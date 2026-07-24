// Reads Claude Code's own session logs (~/.claude/projects/<slug>/<uuid>.jsonl) and
// distils them into episodic traces. This is what makes the brain remember without
// being told to: encoding happens as a by-product of the session, the way the
// hippocampus records an experience whether or not you decided it was worth keeping.
//
// Everything extracted here is verbatim from the log — no model is involved, so
// mining a year of history costs a few seconds of parsing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type EpisodeKind = "prompt" | "decision" | "outcome" | "error" | "preference" | "summary";

export interface DraftEpisode {
	kind: EpisodeKind;
	ts: number;
	text: string;
	salience: number;
}

export interface MinedSession {
	sessionId: string;
	cwd: string;
	started: number;
	ended: number;
	episodes: DraftEpisode[];
	filesTouched: string[];
	gitBranch: string;
}

const MAX_TEXT = 600;
const MIN_PROMPT_CHARS = 25;
const MIN_ERROR_CHARS = 30;
/** One thrashing session shouldn't fill episodic memory with its own flailing. */
const MAX_ERRORS_PER_SESSION = 12;
const SYNTHETIC_PREFIXES = [
	"Caveat:",
	"[Request interrupted",
	"API Error",
	"[Image:",
	"Base directory for this skill:",
];
/** The CLI wraps its own machinery — slash commands, shell mode, hook output — in
 *  lowercase tags. A human prompt effectively never opens with one. */
const MACHINERY_TAG = /^<[a-z][a-z0-9-]*>/;
/** Harness-protocol complaints ("file not read yet", "string not found") and permission
 *  refusals. They say nothing about the user's world and would drown out the failures
 *  that do. */
const HARNESS_ERROR = /^(<tool_use_error>|The user (doesn't want|rejected))/;
/** A non-zero exit alone means little — pipelines end in `head`, greps find nothing.
 *  Something in the output has to actually read like a failure. */
const REAL_FAILURE =
	/\b(error|errno|failed|failure|fatal|exception|traceback|not found|no such|cannot|can't|permission denied|refused|undefined|unbound|timed? out|panic)\b/i;

function clip(text: string, max = MAX_TEXT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isSynthetic(text: string): boolean {
	return MACHINERY_TAG.test(text) || SYNTHETIC_PREFIXES.some((p) => text.startsWith(p));
}

/** User turns arrive either as a bare string or as content blocks mixed with tool results. */
function userText(content: unknown): string | null {
	if (typeof content === "string") return content.trim() || null;
	if (!Array.isArray(content)) return null;
	const parts = content
		.filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
		.map((b) => b.text);
	return parts.join("\n").trim() || null;
}

interface ToolCall {
	name: string;
	target: string;
}

/** The subset of a transcript line this miner reads; the format carries much more. */
interface TranscriptEntry {
	type?: string;
	sessionId?: string;
	cwd?: string;
	gitBranch?: string;
	timestamp?: string;
	message?: { content?: unknown };
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	id?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	is_error?: boolean;
	content?: string | Array<{ text?: string }>;
}

function blocksOf(content: unknown): ContentBlock[] {
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function toolTarget(name: string, input: Record<string, unknown>): string {
	const file = input.file_path ?? input.path ?? input.notebook_path;
	if (typeof file === "string") return file;
	if (typeof input.command === "string") return clip(input.command, 160);
	if (typeof input.pattern === "string") return String(input.pattern);
	if (typeof input.query === "string") return clip(input.query, 120);
	return name;
}

/** Near-duplicate guard for the common "resubmit the prompt with one clause changed" case. */
function tooSimilar(a: string, b: string): boolean {
	const shorter = a.length < b.length ? a : b;
	const longer = a.length < b.length ? b : a;
	return longer.startsWith(shorter.slice(0, Math.min(120, shorter.length)));
}

export function mineTranscript(file: string): MinedSession | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch {
		return null;
	}

	let sessionId = "";
	let cwd = "";
	let gitBranch = "";
	let started = 0;
	let ended = 0;
	const episodes: DraftEpisode[] = [];
	const filesTouched = new Set<string>();
	const pendingTools = new Map<string, ToolCall>();
	let lastPrompt = "";
	let errorCount = 0;

	const collectUserTurn = (content: unknown, ts: number): void => {
		const text = userText(content);
		// "yes", "continue", "go on" carry no retrievable content — they'd only dilute
		// the index and burn embedding time.
		if (text && text.length >= MIN_PROMPT_CHARS && !isSynthetic(text)) {
			if (!tooSimilar(text, lastPrompt)) {
				episodes.push({ kind: "prompt", ts, text: clip(text), salience: 1.4 });
			}
			lastPrompt = text;
		}
		for (const block of blocksOf(content)) {
			if (block.type !== "tool_result" || !block.is_error) continue;
			if (errorCount >= MAX_ERRORS_PER_SESSION) continue;
			const detail = (typeof block.content === "string" ? block.content : (block.content?.[0]?.text ?? "")).trim();
			if (detail.length < MIN_ERROR_CHARS || HARNESS_ERROR.test(detail)) continue;
			if (!REAL_FAILURE.test(detail)) continue;
			const call = block.tool_use_id ? pendingTools.get(block.tool_use_id) : undefined;
			errorCount++;
			episodes.push({
				kind: "error",
				ts,
				// Failures are the most reusable thing a session produces, and the message
				// is the cue a future session will match on — so it leads.
				text: `${clip(detail, 300)} — from ${call?.name ?? "tool"} on ${clip(call?.target ?? "?", 100)}`,
				salience: 1.8,
			});
		}
	};

	const collectAssistantTurn = (content: unknown): void => {
		for (const block of blocksOf(content)) {
			if (block.type !== "tool_use" || !block.name || !block.id) continue;
			const target = toolTarget(block.name, block.input ?? {});
			pendingTools.set(block.id, { name: block.name, target });
			if (block.name === "Edit" || block.name === "Write" || block.name === "NotebookEdit") {
				filesTouched.add(target);
			}
		}
	};

	for (const line of raw.split("\n")) {
		if (!line) continue;
		let entry: TranscriptEntry;
		try {
			entry = JSON.parse(line) as TranscriptEntry;
		} catch {
			continue;
		}

		sessionId ||= entry.sessionId ?? "";
		if (entry.cwd) cwd = entry.cwd;
		if (entry.gitBranch) gitBranch = entry.gitBranch;
		const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;
		if (ts) {
			started ||= ts;
			ended = Math.max(ended, ts);
		}

		if (entry.type === "user") collectUserTurn(entry.message?.content, ts);
		else if (entry.type === "assistant") collectAssistantTurn(entry.message?.content);
	}

	if (!sessionId || episodes.length === 0) return null;
	return { sessionId, cwd, started, ended: ended || started, episodes, filesTouched: [...filesTouched], gitBranch };
}

export interface TranscriptFile {
	path: string;
	mtime: number;
}

/** All session logs, newest first, optionally limited to recent history. */
export function listTranscripts(sinceMs = 0): TranscriptFile[] {
	let slugs: string[];
	try {
		slugs = readdirSync(PROJECTS_DIR);
	} catch {
		return [];
	}
	const out: TranscriptFile[] = [];
	for (const slug of slugs) {
		const dir = join(PROJECTS_DIR, slug);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of files) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			try {
				const mtime = statSync(path).mtimeMs;
				if (mtime >= sinceMs) out.push({ path, mtime });
			} catch {
				/* transcript vanished mid-scan */
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** Locate a live session's log by id, so hooks can mine the session they run inside. */
export function findTranscript(sessionId: string): string | null {
	for (const { path } of listTranscripts()) {
		if (path.endsWith(`${sessionId}.jsonl`)) return path;
	}
	return null;
}
