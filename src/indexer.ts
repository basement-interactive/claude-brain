// Incremental vault indexer: content-hash diff against the persistent index, so a
// reindex touches only added/changed/removed notes. Wikilinks are stored as typed
// doc→doc edges carrying the relation implied by their surroundings.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { chunkNote, stripFrontmatter, titleOf } from "./chunker";
import { embedTexts } from "./embedder";
import { refreshCentroids, scheduleGraphRebuild } from "./graph";
import { resolveLink } from "./graph-builder";
import { openBrainDb, setMeta } from "./index-db";
import { parseLinks, parseTags } from "./relations";
import { IGNORED_DIR_NAMES, vaultReady, vaultRoot } from "./config";

export interface IndexStats {
	indexed: number;
	updated: number;
	removed: number;
	/** Notes that only changed location — same bytes, new path. */
	moved: number;
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

interface KnownDoc {
	id: number;
	hash: string;
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

/**
 * Recognise moved notes before the diff turns them into deletes plus inserts.
 *
 * A reorganize — or one Obsidian drag-and-drop — otherwise costs every moved note its
 * chunks, and with them its embeddings, its community and its derived links, forcing a
 * full local re-embed of files whose bytes never changed.
 *
 * A move is only claimed on a true bijection: exactly one departure and exactly one
 * arrival sharing a content hash. Three identical stubs moved out of one folder carry no
 * fact about which became which, and guessing would repoint one docs row at several
 * notes while leaving the rest with no row, no chunks and no way to be recalled.
 *
 * Reconciled files then take the unchanged fast path in the main loop, since their
 * content genuinely did not change.
 */
function reconcileMoves(
	root: string,
	files: VaultFile[],
	known: Map<string, KnownDoc>,
	raws: Map<string, string>,
	stats: IndexStats,
): void {
	const walked = new Set(files.map((f) => f.relPath));
	const goneByHash = new Map<string, string[]>();
	for (const [path, row] of known) {
		if (walked.has(path)) continue;
		const list = goneByHash.get(row.hash) ?? [];
		list.push(path);
		goneByHash.set(row.hash, list);
	}
	if (goneByHash.size === 0) return;

	const freshByHash = new Map<string, VaultFile[]>();
	for (const f of files) {
		if (known.has(f.relPath)) continue;
		let raw: string;
		try {
			raw = readFileSync(join(root, f.relPath), "utf-8");
		} catch {
			continue;
		}
		// Cached so the main loop does not read every new file a second time.
		raws.set(f.relPath, raw);
		const hash = String(Bun.hash(raw));
		const list = freshByHash.get(hash) ?? [];
		list.push(f);
		freshByHash.set(hash, list);
	}

	const { db } = openBrainDb();
	const update = db.query("UPDATE docs SET path = ?, title = ?, mtime = ?, size = ? WHERE id = ?");
	const retitle = db.query("UPDATE chunks_fts SET title = ? WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)");

	for (const [hash, arrivals] of freshByHash) {
		const departures = goneByHash.get(hash);
		if (!departures || departures.length !== 1 || arrivals.length !== 1) continue;
		const from = departures[0]!;
		const to = arrivals[0]!;
		const prev = known.get(from)!;
		const raw = raws.get(to.relPath) ?? "";
		const title = titleOf(stripFrontmatter(raw), basename(to.relPath).replace(/\.md$/i, ""));
		try {
			update.run(to.relPath, title, to.mtime, to.size, prev.id);
		} catch {
			// docs.path is UNIQUE, so a collision means this was not the move it looked
			// like. Leave the row alone and let the ordinary delete/insert path handle it.
			continue;
		}
		// A rename keeps the bytes but can change the filename-derived title, and the FTS
		// copy of it would otherwise stay stale until the note is edited.
		if (basename(from) !== basename(to.relPath)) retitle.run(title, prev.id);
		known.delete(from);
		known.set(to.relPath, { id: prev.id, hash: prev.hash, mtime: to.mtime, size: to.size });
		stats.moved++;
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
		return { indexed: 0, updated: 0, removed: 0, moved: 0, unchanged: 0, ...countStats(), skipped: "vault not available" };
	}

	const files: VaultFile[] = [];
	walkVault(root, root, files);

	const known = new Map<string, KnownDoc>();
	for (const row of db.query("SELECT id, path, hash, mtime, size FROM docs").all() as Array<
		KnownDoc & { path: string }
	>) {
		known.set(row.path, row);
	}

	const stats: IndexStats = { indexed: 0, updated: 0, removed: 0, moved: 0, unchanged: 0, docs: 0, chunks: 0 };
	const seen = new Set<string>();
	const bodies = new Map<string, string>();
	const raws = new Map<string, string>();

	reconcileMoves(root, files, known, raws, stats);

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
		let raw = raws.get(f.relPath);
		if (raw === undefined) {
			try {
				raw = readFileSync(join(root, f.relPath), "utf-8");
			} catch {
				continue;
			}
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

	// A new, deleted or moved note changes what every other note's wikilinks resolve to
	// — a bare [[link]] with duplicate basenames is tiebroken on the top-level folder —
	// so only those cases pay for a full re-resolve; an edit re-links just that note.
	if (stats.indexed || stats.removed || stats.moved) rebuildAllLinks(root);
	else if (stats.updated) relinkChanged(bodies);
	if (stats.indexed || stats.updated || stats.removed || stats.moved) scheduleGraphRebuild();
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
					`SELECT c.id, c.doc_id, d.title, c.heading, c.text FROM chunks c
					 JOIN docs d ON d.id = c.doc_id WHERE c.embedded = 0 LIMIT 32`,
				)
				.all() as Array<{ id: number; doc_id: number; title: string; heading: string; text: string }>;
			if (pending.length === 0) return total;
			// qmd trick: prefix title into every embedded chunk for cheap relevance gain.
			const vecs = await embedTexts(pending.map((p) => `${p.title} | ${p.heading} | ${p.text}`));
			if (!vecs) return total;
			// vec0 virtual tables don't honour OR REPLACE — it raises a UNIQUE violation
			// instead of replacing. Delete first so a reused chunk rowid can't wedge the pass.
			const clear = db.query("DELETE FROM vec_chunks WHERE chunk_id = ?");
			const insert = db.query("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)");
			const mark = db.query("UPDATE chunks SET embedded = 1 WHERE id = ?");
			db.transaction(() => {
				for (let i = 0; i < pending.length; i++) {
					const chunk = pending[i]!;
					clear.run(chunk.id);
					insert.run(chunk.id, new Float32Array(vecs[i]!));
					mark.run(chunk.id);
				}
			})();
			// The note's centroid is the mean of its chunk vectors, so it moved. Refreshing
			// per batch keeps the similarity pass from re-aggregating every vector later.
			refreshCentroids(pending.map((p) => p.doc_id));
			total += pending.length;
		}
	} finally {
		embedding = false;
		// New vectors mean new similarity edges — the graph is now one step stale.
		if (total > 0) scheduleGraphRebuild();
	}
}
