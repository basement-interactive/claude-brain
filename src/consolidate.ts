// Consolidation: the slow pass that turns raw experience into knowledge worth keeping,
// and lets the rest fade. Runs when a session ends and on demand.
//
// Three jobs, in the order the brain does them:
//  1. encode  — mine any session log not yet in the episodic store
//  2. abstract — find traces that recurred across separate sessions; a thing that keeps
//                happening is a fact about the world, not an incident, and belongs in
//                the vault as a note
//  3. forget  — drop weak, never-rehearsed traces so retrieval stays fast
//
// Step 2 only *proposes*. Writing to the vault stays a deliberate act, because the
// vault is the user's and a wrong auto-note would poison every later recall.

import { forgetWeakEpisodes, type ForgetStats } from "./activation";
import { embedPendingEpisodes, ingestTranscripts } from "./episodic";
import { openBrainDb } from "./index-db";

/**
 * L2 distance under which two normalised MiniLM embeddings count as the same idea.
 * Measured on this vault's episodes: verbatim repeats land at 0.0–0.35, same-topic-
 * different-question at 0.4–0.55, unrelated above that. 0.40 keeps the first group.
 */
const SAME_IDEA_DISTANCE = 0.4;
const LOOKBACK_DAYS = 90;
const NEIGHBOURS = 8;
const MAX_PROPOSALS = 8;

export interface Recurrence {
	kind: string;
	text: string;
	occurrences: number;
	sessions: number;
	lastSeen: number;
}

interface EpisodeRow {
	id: number;
	session_id: string;
	kind: string;
	ts: number;
	text: string;
}

/**
 * Traces that keep coming back. A failure hit once is noise; the same failure across
 * three sessions is a gotcha the vault is missing.
 */
export function findRecurring(now = Date.now()): Recurrence[] {
	const { db, vectors } = openBrainDb();
	if (!vectors) return [];
	const since = now - LOOKBACK_DAYS * 86_400_000;
	const rows = db
		.query(
			`SELECT id, session_id, kind, ts, text FROM episodes
			 WHERE embedded = 1 AND ts >= ? AND kind IN ('error', 'prompt')
			 ORDER BY ts DESC`,
		)
		.all(since) as EpisodeRow[];
	if (rows.length === 0) return [];

	const byId = new Map(rows.map((r) => [r.id, r]));
	const neighbourQuery = db.query(
		`SELECT episode_id, distance FROM vec_episodes
		 WHERE embedding MATCH (SELECT embedding FROM vec_episodes WHERE episode_id = ?)
		 AND k = ? ORDER BY distance`,
	);

	const claimed = new Set<number>();
	const found: Recurrence[] = [];
	for (const row of rows) {
		if (claimed.has(row.id)) continue;
		const near = neighbourQuery.all(row.id, NEIGHBOURS) as Array<{ episode_id: number; distance: number }>;
		const cluster = near
			.filter((n) => n.distance <= SAME_IDEA_DISTANCE)
			.map((n) => byId.get(n.episode_id))
			.filter((r): r is EpisodeRow => r !== undefined && !claimed.has(r.id));
		for (const member of cluster) claimed.add(member.id);
		claimed.add(row.id);

		const sessions = new Set(cluster.map((c) => c.session_id));
		// One session repeating itself is a loop, not a lesson.
		if (sessions.size < 2) continue;
		found.push({
			kind: row.kind,
			text: row.text,
			occurrences: cluster.length,
			sessions: sessions.size,
			lastSeen: Math.max(...cluster.map((c) => c.ts)),
		});
	}
	return found
		.sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences)
		.slice(0, MAX_PROPOSALS);
}

export interface ConsolidationReport {
	ingestedSessions: number;
	ingestedEpisodes: number;
	pendingEmbed: number;
	forgotten: ForgetStats;
	proposals: Recurrence[];
}

/**
 * Embedding runs as a background drain rather than a step: a first backfill is minutes
 * of CPU, and nothing downstream — not a session ending, not a hook — should wait on it.
 * Traces missed by this pass get their abstraction on the next one.
 */
export function consolidate(sinceDays = 14): ConsolidationReport {
	const ingested = ingestTranscripts(sinceDays);
	void embedPendingEpisodes();
	const forgotten = forgetWeakEpisodes();
	const { db } = openBrainDb();
	db.run("UPDATE sessions SET consolidated = 1 WHERE ended IS NOT NULL AND consolidated = 0");
	// The injection ledger only guards a live context window; a week out it is dead weight.
	db.query("DELETE FROM injected WHERE ts < ?").run(Date.now() - 7 * 86_400_000);
	// Autocheckpoint recycles WAL pages but never shrinks the file; embedding passes had
	// left it at 5 MB. Truncating here is safe — the server is the only writer.
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	return {
		ingestedSessions: ingested.sessions,
		ingestedEpisodes: ingested.episodes,
		pendingEmbed: (db.query("SELECT count(*) AS n FROM episodes WHERE embedded = 0").get() as { n: number }).n,
		forgotten,
		proposals: findRecurring(),
	};
}
