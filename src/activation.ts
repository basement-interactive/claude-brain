// Memory strength, after ACT-R's base-level learning equation. A trace's availability
// is a function of how often it has been retrieved and how long ago — not of content
// alone. Two consequences the previous pure-similarity ranking couldn't express:
// retrieving a memory strengthens it (the testing effect), and untouched memories
// fade on a power-law curve instead of ranking forever like the day they were written.

import { openBrainDb } from "./index-db";

/** Forgetting exponent. ACT-R fits ~0.5 for lab recall; lower suits a vault that is
 *  consulted in bursts weeks apart, where a 3-month-old note is still worth surfacing. */
const DECAY = 0.35;
/**
 * How far activation may move a score. This is a tie-breaker, and the number has to be
 * small enough to actually be one.
 *
 * At 0.3 it was not. The multiplier spanned 0.797..1.299 — a 1.63x ratio — while adjacent
 * RRF ranks differ by only 1.0164x, so activation could carry a result past roughly 30
 * rank positions and was deciding the order outright. Measured against a labelled set on
 * the real vault: weight 0.30 gave P@1 60% / MRR 0.783, while 0.10, 0.05 and disabling it
 * entirely all gave P@1 70% / MRR 0.833 — identical, meaning at those weights it only ever
 * breaks a genuine tie. 0.08 keeps the testing effect and the forgetting curve without
 * letting either outvote relevance.
 */
const WEIGHT = 0.08;
const SCALE = 2;
const DAY_MS = 86_400_000;

export interface Trace {
	accessCount: number;
	/** ms epoch of last retrieval, 0 if never retrieved. */
	lastAccess: number;
	/** ms epoch the trace entered the store (note mtime, or episode timestamp). */
	created: number;
}

/**
 * Base-level activation: ln(1 + retrievals) − DECAY · ln(1 + days since last touch).
 * Writing counts as a touch, so a freshly edited note starts at full strength.
 */
export function baseActivation(trace: Trace, now = Date.now()): number {
	const touched = Math.max(trace.lastAccess, trace.created);
	const ageDays = Math.max(0, (now - touched) / DAY_MS);
	return Math.log1p(trace.accessCount) - DECAY * Math.log1p(ageDays);
}

/** Bounded multiplier for a retrieval score — roughly [0.94, 1.06] around a neutral 1. */
export function activationBoost(trace: Trace, now = Date.now()): number {
	return 1 + WEIGHT * Math.tanh(baseActivation(trace, now) / SCALE);
}

/**
 * The testing effect: what gets recalled becomes easier to recall next time.
 * Applied to the notes and episodes a query actually returned, not to everything
 * that merely matched.
 */
export function strengthen(docIds: number[], episodeIds: number[], now = Date.now()): void {
	const { db } = openBrainDb();
	if (docIds.length === 0 && episodeIds.length === 0) return;
	db.transaction(() => {
		if (docIds.length > 0) {
			db.query(
				`UPDATE docs SET access_count = access_count + 1, last_access = ?
				 WHERE id IN (${docIds.map(() => "?").join(",")})`,
			).run(now, ...docIds);
		}
		if (episodeIds.length > 0) {
			db.query(
				`UPDATE episodes SET access_count = access_count + 1, last_access = ?
				 WHERE id IN (${episodeIds.map(() => "?").join(",")})`,
			).run(now, ...episodeIds);
		}
	})();
}

/** Activation below which an unrehearsed episode is no longer worth storing. */
const FORGET_THRESHOLD = -1.2;
/** Kinds that survive on their own merit: a stated preference or a hard-won fix stays
 *  useful long after the session that produced it is irrelevant. */
const DURABLE_KINDS = new Set(["preference", "decision", "summary"]);
const MIN_AGE_DAYS = 21;

export interface ForgetStats {
	scanned: number;
	forgotten: number;
}

/**
 * Decay-driven pruning. Runs over episodes only — vault notes are the user's, and
 * the brain never deletes those. Weak transient traces (a prompt nobody ever recalled
 * again) disappear so the episodic store stays small enough to search in milliseconds.
 */
export function forgetWeakEpisodes(now = Date.now()): ForgetStats {
	const { db, vectors } = openBrainDb();
	const cutoff = now - MIN_AGE_DAYS * DAY_MS;
	const rows = db
		.query(
			`SELECT id, kind, ts, salience, access_count, last_access
			 FROM episodes WHERE ts < ? AND access_count = 0`,
		)
		.all(cutoff) as Array<{
		id: number;
		kind: string;
		ts: number;
		salience: number;
		access_count: number;
		last_access: number;
	}>;

	const doomed = rows
		.filter((r) => !DURABLE_KINDS.has(r.kind))
		.filter(
			(r) =>
				baseActivation({ accessCount: r.access_count, lastAccess: r.last_access, created: r.ts }, now) +
					Math.log(r.salience) <
				FORGET_THRESHOLD,
		)
		.map((r) => r.id);

	if (doomed.length > 0) {
		const list = doomed.map(() => "?").join(",");
		db.transaction(() => {
			db.query(`DELETE FROM episodes_fts WHERE rowid IN (${list})`).run(...doomed);
			if (vectors) db.query(`DELETE FROM vec_episodes WHERE episode_id IN (${list})`).run(...doomed);
			db.query(`DELETE FROM episodes WHERE id IN (${list})`).run(...doomed);
		})();
	}
	return { scanned: rows.length, forgotten: doomed.length };
}
