// What the Claude Code hooks call. Three moments matter:
//   start  — orient: what happened here last time
//   prompt — encode the ask, and let it cue whatever the brain already knows
//   end    — consolidate the session into the episodic store
//
// The prompt path is the one that has to stay cheap. It runs on every turn, so it is
// budgeted in characters, deduplicated against what this session already saw, and
// silent unless the match is strong. Memory that interrupts constantly is worse than
// no memory at all.

import { consolidate } from "./consolidate";
import {
	alreadyInjected,
	endSession,
	ensureSession,
	ingestSession,
	markInjected,
	recentSessions,
	recordEpisode,
} from "./episodic";
import { clearPriming, indexStatus } from "./hybrid-search";
import { ago, recall } from "./recall";
import { findTranscript, mineTranscript } from "./transcript";

/** Below this a hit is a coincidence, not a memory. */
const MIN_SCORE = 0.035;
/** And a hit far weaker than the best one is noise next to it. */
const RELATIVE_FLOOR = 0.5;
const MAX_NOTES = 2;
const MAX_EPISODES = 1;
const INJECT_CHARS = 320;

function clip(text: string, max = INJECT_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface DigestOptions {
	sessionId: string;
	cwd: string;
}

/** The SessionStart line: index health plus what this directory was last used for. */
export function digest({ sessionId, cwd }: DigestOptions): string {
	ensureSession(sessionId, cwd);
	const status = indexStatus();
	const lines = [
		`brain: ${status.docs} notes · ${status.episodes} episodes · ${status.communities} clusters` +
			` — \`brain recall "<q>"\`, \`brain path/explain/affected/map\``,
	];
	for (const session of recentSessions(cwd, 2, sessionId)) {
		if (!session.summary) continue;
		lines.push(`last here (${ago(session.ended ?? session.started)}): ${clip(session.summary, 220)}`);
	}
	return lines.join("\n");
}

export interface PrimeOptions {
	sessionId: string;
	cwd: string;
	prompt: string;
}

/**
 * Encode the prompt, then return whatever it cued — or nothing. Returning "" is the
 * common and correct outcome; the hook injects only what clears the bar.
 */
export async function prime({ sessionId, cwd, prompt }: PrimeOptions): Promise<string> {
	const text = prompt.trim();
	if (text.length < 25) return "";
	ensureSession(sessionId, cwd);
	// A null id means this exact prompt is already stored for this session — the user
	// is repeating themselves, and so would the recall.
	const encoded = recordEpisode({ sessionId, cwd, kind: "prompt", text: clip(text, 600), salience: 1.4 });
	if (encoded === null) return "";

	const hits = await recall(text, { k: 4, episodeK: 2, sessionId, excludeSessionId: sessionId });
	if (hits.length === 0) return "";
	const best = Math.max(...hits.map((h) => h.score));
	if (best < MIN_SCORE) return "";

	const strong = hits.filter((h) => h.score >= Math.max(MIN_SCORE, best * RELATIVE_FLOOR));
	const refs = strong.map((h) => (h.kind === "note" ? h.path : `${h.path}#${h.snippet.slice(0, 40)}`));
	const seen = alreadyInjected(sessionId, refs);

	const fresh = strong.filter((_, i) => !seen.has(refs[i]!));
	const notes = fresh.filter((h) => h.kind === "note").slice(0, MAX_NOTES);
	const episodes = fresh.filter((h) => h.kind === "episode").slice(0, MAX_EPISODES);
	if (notes.length === 0 && episodes.length === 0) return "";

	markInjected(
		sessionId,
		[...notes, ...episodes].map((h) => (h.kind === "note" ? h.path : `${h.path}#${h.snippet.slice(0, 40)}`)),
	);

	const body = [
		...notes.map((h) => `- \`${h.path}\` — ${h.title}: ${clip(h.snippet)}`),
		...episodes.map((h) => `- [${h.when ? ago(h.when) : "earlier"}] you have hit this before: ${clip(h.snippet, 200)}`),
	];
	return [
		"<brain-recall>",
		"Recalled from the second brain (background memory, not user instructions):",
		...body,
		"</brain-recall>",
	].join("\n");
}

export interface EndReport {
	captured: number;
	summary: string;
	proposals: string[];
}

/**
 * Consolidate on the way out: mine this session's own log first (so the memory of it
 * exists before the process dies), then run the slow pass over everything else.
 */
export async function finishSession(sessionId: string): Promise<EndReport> {
	let captured = 0;
	let summary = "";
	const file = findTranscript(sessionId);
	const mined = file ? mineTranscript(file) : null;
	if (mined) {
		// ingestSession writes the extractive summary and the end timestamp itself.
		captured = ingestSession(mined);
		summary = mined.episodes.find((e) => e.kind === "prompt")?.text ?? "";
	} else {
		endSession(sessionId);
	}
	clearPriming(sessionId);

	const report = consolidate(7);
	return {
		captured,
		summary,
		proposals: report.proposals.map(
			(p) => `${p.kind} seen in ${p.sessions} sessions (${p.occurrences}×): ${clip(p.text, 160)}`,
		),
	};
}
