// Hybrid retrieval over the persistent index: FTS5 BM25 + vector search fused with
// reciprocal-rank fusion (qmd), then wikilink-adjacency boosts and best-chunk-per-note
// pooling (gbrain). Falls back to BM25-only when embeddings are unavailable.

import { embedQuery } from "./embedder";
import { openBrainDb } from "./index-db";

export interface RecallHit {
	path: string;
	title: string;
	heading: string;
	score: number;
	snippet: string;
}

interface Candidate {
	chunkId: number;
	docId: number;
	path: string;
	title: string;
	heading: string;
	text: string;
	score: number;
}

const RRF_K = 60;
const CANDIDATES = 30;
const SNIPPET_CHARS = 700;

function ftsQuery(query: string, mode: "and" | "or"): string {
	const terms = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 1 && t.length < 40)
		.map((t) => `"${t}"`);
	return terms.join(mode === "and" ? " " : " OR ");
}

function lexicalRanks(query: string): Map<number, number> {
	const { db } = openBrainDb();
	const search = (match: string) => {
		if (!match) return [];
		try {
			return db
				.query(
					`SELECT rowid, bm25(chunks_fts, 3.0, 2.0, 1.0) AS s
					 FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?`,
				)
				.all(match, CANDIDATES) as Array<{ rowid: number }>;
		} catch {
			return [];
		}
	};
	let rows = search(ftsQuery(query, "and"));
	if (rows.length < 5) {
		const seen = new Set(rows.map((r) => r.rowid));
		rows = rows.concat(search(ftsQuery(query, "or")).filter((r) => !seen.has(r.rowid)));
	}
	const ranks = new Map<number, number>();
	rows.slice(0, CANDIDATES).forEach((r, i) => ranks.set(r.rowid, i));
	return ranks;
}

async function vectorRanks(query: string): Promise<Map<number, number>> {
	const { db, vectors } = openBrainDb();
	const ranks = new Map<number, number>();
	if (!vectors) return ranks;
	const embedded = await embedQuery(query);
	if (!embedded) return ranks;
	const rows = db
		.query("SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance")
		.all(new Float32Array(embedded), CANDIDATES) as Array<{ chunk_id: number }>;
	rows.forEach((r, i) => ranks.set(r.chunk_id, i));
	return ranks;
}

/** Reciprocal-rank fusion with qmd's top-rank bonus. */
function fuse(rankLists: Map<number, number>[]): Map<number, number> {
	const fused = new Map<number, number>();
	for (const ranks of rankLists) {
		for (const [id, rank] of ranks) {
			let score = 1 / (RRF_K + rank + 1);
			if (rank === 0) score += 0.05;
			else if (rank < 3) score += 0.02;
			fused.set(id, (fused.get(id) ?? 0) + score);
		}
	}
	return fused;
}

function hydrate(fused: Map<number, number>): Candidate[] {
	const { db } = openBrainDb();
	const get = db.query(
		`SELECT c.id AS chunkId, d.id AS docId, d.path, d.title, c.heading, c.text
		 FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id = ?`,
	);
	const out: Candidate[] = [];
	for (const [chunkId, score] of fused) {
		const row = get.get(chunkId) as Omit<Candidate, "score"> | null;
		if (row) out.push({ ...row, score });
	}
	return out;
}

/**
 * gbrain-style graph signal: a candidate wikilinked to/from other candidates is likely
 * the hub the query is actually about. +0.03 per distinct linked co-candidate, cap +0.09.
 */
function applyGraphBoost(candidates: Candidate[]): void {
	const { db } = openBrainDb();
	const docIds = [...new Set(candidates.map((c) => c.docId))];
	if (docIds.length < 2) return;
	const placeholders = docIds.map(() => "?").join(",");
	const rows = db
		.query(
			`SELECT source_doc, target_doc FROM links
			 WHERE source_doc IN (${placeholders}) AND target_doc IN (${placeholders})`,
		)
		.all(...docIds, ...docIds) as Array<{ source_doc: number; target_doc: number }>;
	const neighbors = new Map<number, Set<number>>();
	for (const { source_doc, target_doc } of rows) {
		(neighbors.get(source_doc) ?? neighbors.set(source_doc, new Set()).get(source_doc)!).add(target_doc);
		(neighbors.get(target_doc) ?? neighbors.set(target_doc, new Set()).get(target_doc)!).add(source_doc);
	}
	// Multiplicative so the boost scales with RRF magnitude instead of swamping it.
	for (const c of candidates) {
		const n = neighbors.get(c.docId)?.size ?? 0;
		if (n > 0) c.score *= 1 + Math.min(n * 0.05, 0.15);
	}
}

/** One hit per note: best chunk carries it, small bonus when several chunks matched. */
function poolByDoc(candidates: Candidate[]): Candidate[] {
	const byDoc = new Map<number, { best: Candidate; extra: number }>();
	for (const c of candidates) {
		const entry = byDoc.get(c.docId);
		if (!entry) byDoc.set(c.docId, { best: c, extra: 0 });
		else {
			entry.extra++;
			if (c.score > entry.best.score) entry.best = c;
		}
	}
	return [...byDoc.values()].map(({ best, extra }) => ({
		...best,
		score: best.score * (1 + Math.min(extra * 0.05, 0.15)),
	}));
}

export async function hybridRecall(query: string, k = 6, pathPrefix?: string): Promise<RecallHit[]> {
	const [lex, vec] = await Promise.all([
		Promise.resolve(lexicalRanks(query)),
		vectorRanks(query),
	]);
	let candidates = hydrate(fuse([lex, vec]));
	// Folder-scoped recall: filter after fusion so global ranking stays comparable.
	if (pathPrefix) {
		const prefix = pathPrefix.replace(/^\/+|\/+$/g, "").toLowerCase();
		candidates = candidates.filter((c) => c.path.toLowerCase().startsWith(prefix));
	}
	applyGraphBoost(candidates);
	return poolByDoc(candidates)
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
		.map((c) => ({
			path: c.path,
			title: c.title,
			heading: c.heading,
			score: Number(c.score.toFixed(4)),
			snippet: c.text.length > SNIPPET_CHARS ? `${c.text.slice(0, SNIPPET_CHARS)}…` : c.text,
		}));
}

export interface IndexStatus {
	docs: number;
	chunks: number;
	embedded: number;
	pendingEmbed: number;
	vectors: boolean;
	lastIndex: string | null;
}

export function indexStatus(): IndexStatus {
	const { db, vectors } = openBrainDb();
	const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
	return {
		docs: one("SELECT count(*) AS n FROM docs"),
		chunks: one("SELECT count(*) AS n FROM chunks"),
		embedded: one("SELECT count(*) AS n FROM chunks WHERE embedded = 1"),
		pendingEmbed: one("SELECT count(*) AS n FROM chunks WHERE embedded = 0"),
		vectors,
		lastIndex: (db.query("SELECT value FROM meta WHERE key = 'last_index'").get() as { value: string } | null)?.value ?? null,
	};
}
