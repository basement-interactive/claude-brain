// Incremental vault indexer: content-hash diff against the persistent index, so a
// reindex touches only added/changed/removed notes. Wikilinks are stored as typed
// doc→doc edges carrying the relation implied by their surroundings.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { chunkNote, stripFrontmatter, titleOf } from "./chunker";
import { embedTexts } from "./embedder";
import { scheduleGraphRebuild } from "./graph";
import { resolveLink } from "./graph-builder";
import { openBrainDb, setMeta } from "./index-db";
import { parseLinks, parseTags } from "./relations";
import { IGNORED_DIR_NAMES, vaultReady, vaultRoot } from "./config";

export interface IndexStats {
	indexed: number;
	updated: number;
	removed: number;
	unchanged: number;
	docs: number;
	chunks: number;
	skipped?: string;
}

interface VaultFile {
	relPath: string;
	mtime: number;
	size: number;
}

function walkVault(root: string, dir: string, out: VaultFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (IGNORED_DIR_NAMES.has(entry)) continue;
		const full = join(dir, entry);
		let s: ReturnType<typeof statSync>;
		try {
			s = statSync(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) walkVault(root, full, out);
		else if (s.isFile() && extname(entry).toLowerCase() === ".md") {
			out.push({
				relPath: relative(root, full).split(sep).join("/"),
				mtime: Math.floor(s.mtimeMs),
				size: s.size,
			});
		}
	}
}

let running: Promise<IndexStats> | null = null;

/** Serialized entry point — concurrent calls (watcher + API) share one pass. */
export function reindex(): Promise<IndexStats> {
	if (!running) {
		running = runReindex().finally(() => {
			running = null;
		});
	}
	return running;
}

async function runReindex(): Promise<IndexStats> {
	const { db, vectors } = openBrainDb();
	const countStats = () => {
		const docs = (db.query("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
		const chunks = (db.query("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
		return { docs, chunks };
	};

	const root = vaultRoot();
	if (!root || !vaultReady()) {
		// Unset or unmounted vault: an empty walk must not wipe the last good index.
		return { indexed: 0, updated: 0, removed: 0, unchanged: 0, ...countStats(), skipped: "vault not available" };
	}

	const files: VaultFile[] = [];
	walkVault(root, root, files);

	const known = new Map<string, { id: number; hash: string; mtime: number; size: number }>();
	for (const row of db.query("SELECT id, path, hash, mtime, size FROM docs").all() as Array<{
		id: number;
		path: string;
		hash: string;
		mtime: number;
		size: number;
	}>) {
		known.set(row.path, row);
	}

	const stats: IndexStats = { indexed: 0, updated: 0, removed: 0, unchanged: 0, docs: 0, chunks: 0 };
	const seen = new Set<string>();
	const bodies = new Map<string, string>();

	const upsertDoc = db.query(
		`INSERT INTO docs (path, title, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET title = excluded.title, hash = excluded.hash,
		 mtime = excluded.mtime, size = excluded.size
		 RETURNING id`,
	);
	const insertChunk = db.query(
		"INSERT INTO chunks (doc_id, heading, pos, text) VALUES (?, ?, ?, ?) RETURNING id",
	);
	const insertFts = db.query(
		"INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (?, ?, ?, ?)",
	);

	for (const f of files) {
		seen.add(f.relPath);
		const prev = known.get(f.relPath);
		// mtime+size fast path: skip hashing entirely for untouched files.
		if (prev && prev.mtime === f.mtime && prev.size === f.size) {
			stats.unchanged++;
			continue;
		}
		let raw: string;
		try {
			raw = readFileSync(join(root, f.relPath), "utf-8");
		} catch {
			continue;
		}
		const hash = String(Bun.hash(raw));
		if (prev && prev.hash === hash) {
			db.query("UPDATE docs SET mtime = ?, size = ? WHERE id = ?").run(f.mtime, f.size, prev.id);
			stats.unchanged++;
			continue;
		}

		const body = stripFrontmatter(raw);
		const title = titleOf(body, basename(f.relPath).replace(/\.md$/i, ""));
		bodies.set(f.relPath, body);

		db.transaction(() => {
			if (prev) {
				for (const c of db.query("SELECT id FROM chunks WHERE doc_id = ?").all(prev.id) as Array<{ id: number }>) {
					db.query("DELETE FROM chunks_fts WHERE rowid = ?").run(c.id);
					if (vectors) db.query("DELETE FROM vec_chunks WHERE chunk_id = ?").run(c.id);
				}
				db.query("DELETE FROM chunks WHERE doc_id = ?").run(prev.id);
			}
			const docId = (upsertDoc.get(f.relPath, title, hash, f.mtime, f.size) as { id: number }).id;
			for (const chunk of chunkNote(body)) {
				const chunkId = (insertChunk.get(docId, chunk.heading || title, chunk.pos, chunk.text) as { id: number }).id;
				insertFts.run(chunkId, title, chunk.heading || title, chunk.text);
			}
			db.query("DELETE FROM doc_tags WHERE doc_id = ?").run(docId);
			const insertTag = db.query("INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?, ?)");
			for (const tag of parseTags(raw)) insertTag.run(docId, tag);
		})();
		if (prev) stats.updated++;
		else stats.indexed++;
	}

	// Deletions: docs in the index whose file is gone.
	for (const [path, row] of known) {
		if (seen.has(path)) continue;
		db.transaction(() => {
			for (const c of db.query("SELECT id FROM chunks WHERE doc_id = ?").all(row.id) as Array<{ id: number }>) {
				db.query("DELETE FROM chunks_fts WHERE rowid = ?").run(c.id);
				if (vectors) db.query("DELETE FROM vec_chunks WHERE chunk_id = ?").run(c.id);
			}
			db.query("DELETE FROM docs WHERE id = ?").run(row.id);
		})();
		stats.removed++;
	}

	// A new or deleted note changes what every other note's wikilinks resolve to, so
	// only that case pays for a full re-resolve; an edit re-links just the edited note.
	if (stats.indexed || stats.removed) rebuildAllLinks(root);
	else if (stats.updated) relinkChanged(bodies);
	if (stats.indexed || stats.updated || stats.removed) scheduleGraphRebuild();
	setMeta(db, "last_index", new Date().toISOString());

	Object.assign(stats, countStats());
	if (vectors) void embedPending();
	return stats;
}

interface LinkResolver {
	idByPath: Map<string, number>;
	byBasename: Map<string, string[]>;
}

function loadResolver(): LinkResolver {
	const { db } = openBrainDb();
	const idByPath = new Map<string, number>();
	const byBasename = new Map<string, string[]>();
	for (const row of db.query("SELECT id, path FROM docs").all() as Array<{ id: number; path: string }>) {
		idByPath.set(row.path, row.id);
		const key = basename(row.path).replace(/\.md$/i, "").toLowerCase();
		const list = byBasename.get(key) ?? [];
		list.push(row.path);
		byBasename.set(key, list);
	}
	return { idByPath, byBasename };
}

/** Outgoing edges for one note, replacing whatever it pointed at before. */
function linkOne(resolver: LinkResolver, path: string, body: string): void {
	const { db } = openBrainDb();
	const sourceId = resolver.idByPath.get(path);
	if (!sourceId) return;
	db.query("DELETE FROM links WHERE source_doc = ?").run(sourceId);
	const insert = db.query(
		"INSERT OR IGNORE INTO links (source_doc, target_doc, relation, context) VALUES (?, ?, ?, ?)",
	);
	for (const link of parseLinks(body)) {
		const target = resolveLink(link.target, resolver.byBasename, path);
		if (!target || target === path) continue;
		const targetId = resolver.idByPath.get(target);
		if (targetId) insert.run(sourceId, targetId, link.relation, link.context);
	}
}

/**
 * Re-read every note purely for its structure — typed wikilinks and frontmatter tags.
 * The incremental path never revisits an unchanged file, so a newly added structural
 * field (relations, tags) has no other way to reach notes that predate it.
 */
export function refreshStructure(): { docs: number; tags: number } {
	const root = vaultRoot();
	if (!root) return { docs: 0, tags: 0 };
	const { db } = openBrainDb();
	const resolver = loadResolver();
	let tags = 0;
	db.transaction(() => {
		db.run("DELETE FROM links");
		db.run("DELETE FROM doc_tags");
		const insertTag = db.query("INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?, ?)");
		for (const [path, id] of resolver.idByPath) {
			let raw: string;
			try {
				raw = readFileSync(join(root, path), "utf-8");
			} catch {
				continue;
			}
			linkOne(resolver, path, raw);
			for (const tag of parseTags(raw)) {
				insertTag.run(id, tag);
				tags++;
			}
		}
	})();
	return { docs: resolver.idByPath.size, tags };
}

/** Re-resolve every note. Needed only when the set of link targets itself changed. */
function rebuildAllLinks(root: string): void {
	const { db } = openBrainDb();
	const resolver = loadResolver();
	db.transaction(() => {
		db.run("DELETE FROM links");
		for (const path of resolver.idByPath.keys()) {
			let raw: string;
			try {
				raw = readFileSync(join(root, path), "utf-8");
			} catch {
				continue;
			}
			linkOne(resolver, path, raw);
		}
	})();
}

/**
 * Re-link only the notes whose content changed, reusing the bodies the indexer already
 * read. Saves re-reading the whole vault off the external SSD on every single edit.
 */
function relinkChanged(bodies: Map<string, string>): void {
	const { db } = openBrainDb();
	const resolver = loadResolver();
	db.transaction(() => {
		for (const [path, body] of bodies) linkOne(resolver, path, body);
	})();
}

let embedding = false;

/** Background pass: embed chunks flagged since the last run. Never blocks recall. */
export async function embedPending(): Promise<number> {
	const { db, vectors } = openBrainDb();
	if (!vectors || embedding) return 0;
	embedding = true;
	let total = 0;
	try {
		for (;;) {
			const pending = db
				.query(
					`SELECT c.id, d.title, c.heading, c.text FROM chunks c
					 JOIN docs d ON d.id = c.doc_id WHERE c.embedded = 0 LIMIT 32`,
				)
				.all() as Array<{ id: number; title: string; heading: string; text: string }>;
			if (pending.length === 0) return total;
			// qmd trick: prefix title into every embedded chunk for cheap relevance gain.
			const vecs = await embedTexts(pending.map((p) => `${p.title} | ${p.heading} | ${p.text}`));
			if (!vecs) return total;
			db.transaction(() => {
				for (let i = 0; i < pending.length; i++) {
					const chunk = pending[i]!;
					db.query("INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)").run(
						chunk.id,
						new Float32Array(vecs[i]!),
					);
					db.query("UPDATE chunks SET embedded = 1 WHERE id = ?").run(chunk.id);
				}
			})();
			total += pending.length;
		}
	} finally {
		embedding = false;
		// New vectors mean new similarity edges — the graph is now one step stale.
		if (total > 0) scheduleGraphRebuild();
	}
}
