// Retrieval across both memory systems. Lexical (FTS5 BM25) and semantic (vector)
// rankings are fused with reciprocal-rank fusion, then reweighted by how strong each
// trace is (activation.ts), extended along associations (spreading.ts), and finally
// strengthened by the act of being recalled.
//
// Ordering matters: relevance decides the candidate set, memory strength only reorders
// within it. A brain that let recency outvote meaning would answer every question with
// whatever it saw last.

import { activationBoost, strengthen } from "./activation";
import { embedQuery } from "./embedder";
import { openBrainDb } from "./index-db";
import { focusSnippet } from "./snippet";
import { spreadActivation } from "./spreading";

export interface RecallHit {
	kind: "note" | "episode";
	/** Vault-relative path for notes; `session/<id>` for episodes. */
	path: string;
	title: string;
	heading: string;
	score: number;
	snippet: string;
	/** Epoch ms of the remembered event — episodes only. */
	when?: number;
	/** Title of the note this one was reached through, when it arrived by association. */
	via?: string;
	/** Already surfaced earlier in this session — its text is still in context. */
	seen?: boolean;
}

export interface RecallOptions {
	k?: number;
	/** How many episodic traces may accompany the notes. */
	episodeK?: number;
	pathPrefix?: string;
	/** Live session id — enables working-memory priming and is required for priming to persist. */
	sessionId?: string;
	/**
	 * Drop episodes from this session. What just happened is still in the context
	 * window; replaying it back as "memory" is an echo, not a recollection.
	 */
	excludeSessionId?: string;
	/** Set false for background/UI queries that shouldn't count as retrievals. */
	reinforce?: boolean;
	/** Return whole matching sections instead of just the answering lines. */
	full?: boolean;
}

interface Candidate {
	chunkId: number;
	docId: number;
	path: string;
	title: string;
	heading: string;
	text: string;
	score: number;
	via?: string;
}

interface EpisodeCandidate {
	id: number;
	sessionId: string;
	kind: string;
	ts: number;
	text: string;
	salience: number;
	score: number;
}

const RRF_K = 60;
const CANDIDATES = 30;
/**
 * Snippet budget. The old 700 was "however much of the chunk fits"; with focused
 * extraction the same answer arrives in a third of the space, so the budget buys
 * relevance instead of padding. `full` restores whole-chunk output for the rare case
 * where the surrounding section matters.
 */
const SNIPPET_CHARS = 280;
const FULL_SNIPPET_CHARS = 900;
/** An episode is a reminder, not a document — it never needs a note-sized excerpt. */
const EPISODE_SNIPPET_CHARS = 200;
/** Episodes are raw and repetitive next to a curated note; they earn less trust. */
const EPISODE_WEIGHT = 0.8;

function ftsQuery(query: string, mode: "and" | "or"): string {
	const terms = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 1 && t.length < 40)
		.map((t) => `"${t}"`);
	return terms.join(mode === "and" ? " " : " OR ");
}

/** BM25 over one FTS table. Falls back from all-terms to any-term when too few match. */
function lexicalRanks(table: string, columnWeights: number[], query: string): Map<number, number> {
	const { db } = openBrainDb();
	const weights = columnWeights.join(", ");
	const search = (match: string) => {
		if (!match) return [];
		try {
			return db
				.query(
					`SELECT rowid, bm25(${table}, ${weights}) AS s
					 FROM ${table} WHERE ${table} MATCH ? ORDER BY s LIMIT ?`,
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

function vectorRanks(table: string, idColumn: string, vector: number[] | null): Map<number, number> {
	const { db, vectors } = openBrainDb();
	const ranks = new Map<number, number>();
	if (!vectors || !vector) return ranks;
	const rows = db
		.query(`SELECT ${idColumn} AS id FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
		.all(new Float32Array(vector), CANDIDATES) as Array<{ id: number }>;
	rows.forEach((r, i) => ranks.set(r.id, i));
	return ranks;
}

/** Reciprocal-rank fusion with a bonus for the very top of each list. */
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

// Working memory: a running average of what this session has been asking about, blended
// into each new query so consecutive recalls stay on topic — the reason a follow-up
// question needs less context than the first one did.
const PRIMING_WEIGHT = 0.15;
/** Sessions that ended without a SessionEnd hook would otherwise leak their vector. */
const MAX_PRIMED_SESSIONS = 64;
const primed = new Map<string, number[]>();

function primeQuery(sessionId: string | undefined, vector: number[] | null): number[] | null {
	if (!vector) return vector;
	if (!sessionId) return vector;
	const context = primed.get(sessionId);
	const next = context
		? vector.map((v, i) => (1 - PRIMING_WEIGHT) * v + PRIMING_WEIGHT * (context[i] ?? 0))
		: vector;
	// Keep the context vector as a decaying trace of the session's queries.
	primed.set(sessionId, context ? context.map((c, i) => 0.6 * c + 0.4 * (vector[i] ?? 0)) : [...vector]);
	if (primed.size > MAX_PRIMED_SESSIONS) primed.delete(primed.keys().next().value as string);
	const norm = Math.hypot(...next) || 1;
	return next.map((v) => v / norm);
}

export function clearPriming(sessionId: string): void {
	primed.delete(sessionId);
}

function hydrateChunks(fused: Map<number, number>): Candidate[] {
	const { db } = openBrainDb();
	const ids = [...fused.keys()];
	if (ids.length === 0) return [];
	const rows = db
		.query(
			`SELECT c.id AS chunkId, d.id AS docId, d.path, d.title, c.heading, c.text,
			        d.access_count, d.last_access, d.mtime
			 FROM chunks c JOIN docs d ON d.id = c.doc_id
			 WHERE c.id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Array<
		Omit<Candidate, "score"> & { access_count: number; last_access: number; mtime: number }
	>;
	return rows.map((r) => ({
		chunkId: r.chunkId,
		docId: r.docId,
		path: r.path,
		title: r.title,
		heading: r.heading,
		text: r.text,
		score:
			(fused.get(r.chunkId) ?? 0) *
			activationBoost({ accessCount: r.access_count, lastAccess: r.last_access, created: r.mtime }),
	}));
}

function hydrateEpisodes(fused: Map<number, number>): EpisodeCandidate[] {
	const { db } = openBrainDb();
	const ids = [...fused.keys()];
	if (ids.length === 0) return [];
	const rows = db
		.query(
			`SELECT id, session_id, kind, ts, text, salience, access_count, last_access
			 FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Array<{
		id: number;
		session_id: string;
		kind: string;
		ts: number;
		text: string;
		salience: number;
		access_count: number;
		last_access: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		sessionId: r.session_id,
		kind: r.kind,
		ts: r.ts,
		text: r.text,
		salience: r.salience,
		score:
			(fused.get(r.id) ?? 0) *
			EPISODE_WEIGHT *
			r.salience ** 0.4 *
			activationBoost({ accessCount: r.access_count, lastAccess: r.last_access, created: r.ts }),
	}));
}

/**
 * Co-citation signal: a candidate wikilinked to other candidates is likely the hub the
 * query is actually about. Multiplicative, so it scales with the fused score instead of
 * swamping it.
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

/** Pull in notes that matched nothing but sit one association away from a strong match. */
function addAssociations(pooled: Candidate[], limit: number): Candidate[] {
	if (pooled.length === 0 || limit <= 0) return pooled;
	const seeds = new Map(pooled.map((c) => [c.docId, c.score]));
	const spread = spreadActivation(seeds, limit);
	if (spread.length === 0) return pooled;

	const { db } = openBrainDb();
	const titleByDoc = new Map(pooled.map((c) => [c.docId, c.title]));
	const ids = spread.map((s) => s.docId);
	// The opening chunk of a note is its summary — the right thing to show for a hit
	// that was never matched on content.
	const rows = db
		.query(
			`SELECT d.id AS docId, d.path, d.title, c.id AS chunkId, c.heading, c.text
			 FROM docs d JOIN chunks c ON c.doc_id = d.id AND c.pos = 0
			 WHERE d.id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Array<Omit<Candidate, "score">>;
	const byDoc = new Map(rows.map((r) => [r.docId, r]));

	const extra: Candidate[] = [];
	for (const s of spread) {
		const row = byDoc.get(s.docId);
		if (row) extra.push({ ...row, score: s.score, via: titleByDoc.get(s.viaDocId) });
	}
	return pooled.concat(extra);
}

/** At most one trace per session, so a single chatty session can't fill the results. */
function diversifyEpisodes(candidates: EpisodeCandidate[], k: number): EpisodeCandidate[] {
	const seen = new Set<string>();
	const out: EpisodeCandidate[] = [];
	for (const c of candidates.sort((a, b) => b.score - a.score)) {
		if (seen.has(c.sessionId)) continue;
		seen.add(c.sessionId);
		out.push(c);
		if (out.length >= k) break;
	}
	return out;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function hybridRecall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
	const k = options.k ?? 6;
	const episodeK = options.episodeK ?? Math.max(1, Math.round(k / 3));
	const vector = primeQuery(options.sessionId, await embedQuery(query));

	const noteFused = fuse([
		lexicalRanks("chunks_fts", [3.0, 2.0, 1.0], query),
		vectorRanks("vec_chunks", "chunk_id", vector),
	]);
	let notes = hydrateChunks(noteFused);
	// Folder-scoped recall filters after fusion so global ranking stays comparable.
	if (options.pathPrefix) {
		const prefix = options.pathPrefix.replace(/^\/+|\/+$/g, "").toLowerCase();
		notes = notes.filter((c) => c.path.toLowerCase().startsWith(prefix));
	}
	applyGraphBoost(notes);
	const pooled = poolByDoc(notes).sort((a, b) => b.score - a.score);
	const topNotes = addAssociations(pooled.slice(0, k), Math.max(1, Math.round(k / 4)))
		.sort((a, b) => b.score - a.score)
		.slice(0, k);

	const episodes =
		episodeK > 0 && !options.pathPrefix
			? diversifyEpisodes(
					hydrateEpisodes(
						fuse([
							lexicalRanks("episodes_fts", [1.0], query),
							vectorRanks("vec_episodes", "episode_id", vector),
						]),
					).filter((e) => e.sessionId !== options.excludeSessionId),
					episodeK,
				)
			: [];

	if (options.reinforce !== false) {
		strengthen(
			topNotes.map((n) => n.docId),
			episodes.map((e) => e.id),
		);
	}

	const budget = options.full ? FULL_SNIPPET_CHARS : SNIPPET_CHARS;
	const noteHits: RecallHit[] = topNotes.map((c) => ({
		kind: "note",
		path: c.path,
		title: c.title,
		heading: c.heading,
		score: Number(c.score.toFixed(4)),
		snippet: focusSnippet(c.text, query, budget),
		via: c.via,
	}));
	const episodeHits: RecallHit[] = episodes.map((e) => ({
		kind: "episode",
		path: `session/${e.sessionId}`,
		title: e.kind,
		heading: e.kind,
		score: Number(e.score.toFixed(4)),
		snippet: clip(e.text, EPISODE_SNIPPET_CHARS),
		when: e.ts,
	}));
	return [...noteHits, ...episodeHits];
}

export interface IndexStatus {
	docs: number;
	chunks: number;
	embedded: number;
	pendingEmbed: number;
	episodes: number;
	sessions: number;
	pendingEpisodeEmbed: number;
	edges: number;
	communities: number;
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
		episodes: one("SELECT count(*) AS n FROM episodes"),
		sessions: one("SELECT count(*) AS n FROM sessions"),
		pendingEpisodeEmbed: one("SELECT count(*) AS n FROM episodes WHERE embedded = 0"),
		edges: one("SELECT (SELECT count(*) FROM links) + (SELECT count(*) FROM derived_links) AS n"),
		communities: one("SELECT count(*) AS n FROM community_labels"),
		vectors,
		lastIndex: (db.query("SELECT value FROM meta WHERE key = 'last_index'").get() as { value: string } | null)?.value ?? null,
	};
}
