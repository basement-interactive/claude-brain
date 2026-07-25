// The episodic store: what happened, when, and where — as opposed to the semantic
// store (vault notes), which holds what is true. Sessions write here automatically;
// nothing is curated. Consolidation later decides which of these traces earned a
// place in the vault.

import { statSync } from "node:fs";
import { embedTexts } from "./embedder";
import { openBrainDb } from "./index-db";
import { type DraftEpisode, type EpisodeKind, listTranscripts, type MinedSession, mineTranscript } from "./transcript";

export interface EpisodeInput {
	sessionId: string;
	cwd?: string;
	kind: EpisodeKind;
	text: string;
	ts?: number;
	salience?: number;
}

export interface StoredEpisode {
	id: number;
	sessionId: string;
	cwd: string;
	kind: EpisodeKind;
	ts: number;
	text: string;
	salience: number;
}

function fingerprint(sessionId: string, kind: string, text: string): string {
	return `${sessionId}:${kind}:${Bun.hash(text)}`;
}

export function ensureSession(sessionId: string, cwd = "", started = Date.now()): void {
	const { db } = openBrainDb();
	db.query(
		`INSERT INTO sessions (id, cwd, started) VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET cwd = CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE sessions.cwd END`,
	).run(sessionId, cwd, started);
}

/** Returns the new episode id, or null when this trace was already stored. */
export function recordEpisode(input: EpisodeInput): number | null {
	const { db } = openBrainDb();
	const text = input.text.trim();
	if (!text) return null;
	const ts = input.ts ?? Date.now();
	const fp = fingerprint(input.sessionId, input.kind, text);

	const row = db
		.query(
			`INSERT INTO episodes (session_id, cwd, kind, ts, text, salience, fingerprint)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO NOTHING RETURNING id`,
		)
		.get(input.sessionId, input.cwd ?? "", input.kind, ts, text, input.salience ?? 1, fp) as
		| { id: number }
		| null;
	if (!row) return null;
	db.query("INSERT INTO episodes_fts (rowid, text) VALUES (?, ?)").run(row.id, text);
	return row.id;
}

export function endSession(sessionId: string, summary?: string, ended = Date.now()): void {
	const { db } = openBrainDb();
	db.query(
		"UPDATE sessions SET ended = ?, summary = COALESCE(?, summary) WHERE id = ?",
	).run(ended, summary ?? null, sessionId);
}

/**
 * Extractive session summary — the first real ask, what it touched, what broke.
 * No model in the loop, so this stays honest about what actually happened.
 */
export function summarize(mined: MinedSession): string {
	const prompts = mined.episodes.filter((e) => e.kind === "prompt");
	const errors = mined.episodes.filter((e) => e.kind === "error");
	const parts = [prompts[0]?.text ?? "(no prompt captured)"];
	if (prompts.length > 1) parts.push(`then ${prompts.length - 1} more asks`);
	if (mined.filesTouched.length > 0) {
		const shown = mined.filesTouched.slice(0, 6).map((f) => f.split("/").slice(-2).join("/"));
		parts.push(`edited ${shown.join(", ")}${mined.filesTouched.length > 6 ? ` +${mined.filesTouched.length - 6}` : ""}`);
	}
	if (errors.length > 0) parts.push(`${errors.length} tool failures`);
	return parts.join(" · ");
}

export interface IngestStats {
	sessions: number;
	episodes: number;
}

/** Store one mined transcript. Idempotent: re-running over the same log adds nothing. */
export function ingestSession(mined: MinedSession): number {
	const { db } = openBrainDb();
	ensureSession(mined.sessionId, mined.cwd, mined.started);
	const summary = summarize(mined);

	let added = 0;
	db.transaction(() => {
		for (const e of mined.episodes) {
			if (recordEpisode({ ...e, sessionId: mined.sessionId, cwd: mined.cwd }) !== null) added++;
		}
		const summaryId = recordEpisode({
			sessionId: mined.sessionId,
			cwd: mined.cwd,
			kind: "summary",
			text: summary,
			ts: mined.ended,
			salience: 2,
		});
		if (summaryId !== null) added++;
		db.query("UPDATE sessions SET ended = ?, summary = ? WHERE id = ?").run(mined.ended, summary, mined.sessionId);
	})();
	return added;
}

/**
 * Mine every session log newer than `sinceDays`, skipping files whose bytes have not
 * changed since the last pass.
 *
 * `skipPath` exists because finishSession has already mined the live session's own log —
 * the largest file in the corpus — immediately before calling consolidate.
 */
export function ingestTranscripts(sinceDays = 180, skipPath?: string): IngestStats {
	const { db } = openBrainDb();
	const since = Date.now() - sinceDays * 86_400_000;
	const stats: IngestStats = { sessions: 0, episodes: 0 };

	const seen = new Map<string, { mtime: number; size: number }>();
	for (const row of db.query("SELECT path, mtime, size FROM mined_transcripts").all() as Array<{
		path: string;
		mtime: number;
		size: number;
	}>) {
		seen.set(row.path, { mtime: row.mtime, size: row.size });
	}
	const mark = db.query(
		`INSERT INTO mined_transcripts (path, mtime, size, mined_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, mined_at = excluded.mined_at`,
	);

	for (const { path, mtime } of listTranscripts(since)) {
		if (path === skipPath) continue;
		let size = 0;
		try {
			size = statSync(path).size;
		} catch {
			continue;
		}
		const previous = seen.get(path);
		// A transcript only ever grows, so identical mtime and size means identical bytes.
		if (previous && previous.mtime === mtime && previous.size === size) continue;

		const mined = mineTranscript(path);
		mark.run(path, mtime, size, Date.now());
		if (!mined) continue;
		const added = ingestSession(mined);
		if (added > 0) {
			stats.sessions++;
			stats.episodes += added;
		}
	}
	return stats;
}

let embedding = false;

/** Background embedding pass for episodes, mirroring the chunk pass in the indexer. */
export async function embedPendingEpisodes(): Promise<number> {
	const { db, vectors } = openBrainDb();
	if (!vectors || embedding) return 0;
	embedding = true;
	try {
		let total = 0;
		for (;;) {
			const pending = db
				.query("SELECT id, kind, text FROM episodes WHERE embedded = 0 LIMIT 64")
				.all() as Array<{ id: number; kind: string; text: string }>;
			if (pending.length === 0) return total;
			const vecs = await embedTexts(pending.map((p) => `${p.kind} | ${p.text}`));
			if (!vecs) return total;
			// vec0 virtual tables don't honour OR REPLACE — it raises a UNIQUE violation
			// instead of replacing. Delete first; a stale vector for a reused rowid would
			// otherwise crash the whole embedding pass on startup.
			const clear = db.query("DELETE FROM vec_episodes WHERE episode_id = ?");
			const insert = db.query("INSERT INTO vec_episodes (episode_id, embedding) VALUES (?, ?)");
			const mark = db.query("UPDATE episodes SET embedded = 1 WHERE id = ?");
			db.transaction(() => {
				for (let i = 0; i < pending.length; i++) {
					clear.run(pending[i]!.id);
					insert.run(pending[i]!.id, new Float32Array(vecs[i]!));
					mark.run(pending[i]!.id);
				}
			})();
			total += pending.length;
			// ONNX inference holds the loop; yield so a recall arriving mid-backfill
			// still answers in milliseconds.
			await Bun.sleep(5);
		}
	} finally {
		embedding = false;
	}
}

export interface SessionRow {
	id: string;
	cwd: string;
	started: number;
	ended: number | null;
	summary: string | null;
}

/** Past sessions in this directory, most recent first — "what were we doing here". */
export function recentSessions(cwd: string, limit = 3, excludeId?: string): SessionRow[] {
	const { db } = openBrainDb();
	return db
		.query(
			`SELECT id, cwd, started, ended, summary FROM sessions
			 WHERE cwd = ? AND summary IS NOT NULL AND id <> ?
			 ORDER BY started DESC LIMIT ?`,
		)
		.all(cwd, excludeId ?? "", limit) as SessionRow[];
}

export function episodeCount(): number {
	const { db } = openBrainDb();
	return (db.query("SELECT count(*) AS n FROM episodes").get() as { n: number }).n;
}

/** Per-session injection ledger: associative recall must not repeat itself. */
export function alreadyInjected(sessionId: string, refs: string[]): Set<string> {
	const { db } = openBrainDb();
	if (refs.length === 0) return new Set();
	const rows = db
		.query(
			`SELECT ref FROM injected WHERE session_id = ? AND ref IN (${refs.map(() => "?").join(",")})`,
		)
		.all(sessionId, ...refs) as Array<{ ref: string }>;
	return new Set(rows.map((r) => r.ref));
}

export function markInjected(sessionId: string, refs: string[], now = Date.now()): void {
	const { db } = openBrainDb();
	const insert = db.query("INSERT OR IGNORE INTO injected (session_id, ref, ts) VALUES (?, ?, ?)");
	db.transaction(() => {
		for (const ref of refs) insert.run(sessionId, ref, now);
	})();
}

export type { DraftEpisode, EpisodeKind, MinedSession };
