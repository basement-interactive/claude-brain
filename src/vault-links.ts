// Everything that decides whether moving a note is safe to attempt.
//
// The premise "Obsidian resolves links by basename, so a note can be moved for free" is
// only half true, and the false half is silent: resolveLink() in graph-builder.ts takes
// basename(target), so claude-brain's own index keeps resolving a link that Obsidian now
// shows as dead. A move that breaks the vault would therefore be reported as a success.
//
// Nothing in this module rewrites a link. The only lever it has is refusing to move a
// note, so the worst consequence of a wrong answer here is a note left where it already
// was — which is exactly the failure mode this feature is allowed to have.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IGNORED_DIR_NAMES } from "./config";

export interface ObsidianLinkFormat {
	useMarkdownLinks: boolean;
	/** "shortest" | "relative" | "absolute" — Obsidian's own vocabulary. */
	newLinkFormat: string;
}

const IGNORED_DIR_LOWER = new Set([...IGNORED_DIR_NAMES].map((name) => name.toLowerCase()));

/**
 * The vault-relative form of a note path, or null when it is not one.
 *
 * Nothing downstream may assume a path came out of our own index: plan.md is advertised as
 * the hand-editable review surface, and a plan can also be handed over with `--plan
 * <file>`. An absolute path, a `..` segment, or a folder the indexer refuses to walk all
 * mean the same thing here — not a note this vault owns, so not a note we move.
 *
 * Control characters are refused for a different reason: plan.md is line-oriented, so a
 * note whose name contains a newline cannot round-trip through it. Refusing to move it is
 * the only answer that keeps the file the user reviewed and the file apply obeys the same.
 */
export function vaultNotePath(rel: string): string | null {
	const trimmed = rel.trim();
	if (!trimmed || !trimmed.toLowerCase().endsWith(".md")) return null;
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	// A drive letter or UNC prefix reads as relative on POSIX and as absolute on the other
	// end of the sync these vaults usually live on.
	if (/^[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) return null;

	const segments = trimmed.split(/[\\/]+/);
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
	if (segments.slice(0, -1).some((segment) => IGNORED_DIR_LOWER.has(segment.toLowerCase()))) return null;
	return segments.join("/");
}

/**
 * Read the vault's link settings. Returns null when there is no Obsidian config at all
 * (a plain folder of markdown), in which case the caller has nothing to abort on: absent
 * keys are Obsidian's defaults, which are markdown-links off and "shortest".
 */
export function obsidianLinkFormat(root: string): ObsidianLinkFormat | null {
	let raw: string;
	try {
		raw = readFileSync(join(root, ".obsidian", "app.json"), "utf-8");
	} catch {
		return null;
	}
	let parsed: { useMarkdownLinks?: unknown; newLinkFormat?: unknown };
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch {
		return null;
	}
	return {
		useMarkdownLinks: parsed.useMarkdownLinks === true,
		newLinkFormat: typeof parsed.newLinkFormat === "string" ? parsed.newLinkFormat : "shortest",
	};
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
/** Same shape, unflagged: a /g regex carries lastIndex between .test() calls. */
const HAS_WIKILINK_RE = /\[\[[^\]\n]+\]\]/;
const MARKDOWN_LINK_RE = /\]\(([^)\s]+)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const URL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function noteKey(target: string): string {
	return basename(target).replace(/\.md$/i, "").toLowerCase();
}

/** Resolve `../notes/x.md` against the folder it was written in. Posix-only: vault
 *  paths are stored posix-normalised everywhere in the index. */
function resolveRelative(fromDir: string, target: string): string {
	const segments = fromDir ? fromDir.split("/") : [];
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") segments.pop();
		else segments.push(part);
	}
	return segments.join("/");
}

/**
 * One full-vault read collecting, per note path, the reason it must not move. Two
 * directions matter and both are recorded:
 *
 *  - the note *carries* a link that is resolved by location — a path-qualified wikilink,
 *    a relative markdown link, a relative image embed. Moving the note breaks its own
 *    outgoing links.
 *  - the note *is the target* of such a link from somewhere else. Moving it breaks the
 *    other note, which the user will discover much later and never connect to this run.
 *
 * A wikilink in the frontmatter is frozen too: `up:`/`parent:` links are a declared
 * position in a hierarchy, and silently relocating a note out from under its declared
 * parent is a semantic break even when the link itself still resolves.
 *
 * Reasons are one short phrase because they are printed verbatim beside the path in the
 * frozen section of plan.md.
 */
export function scanLinkRisks(root: string, paths: string[]): Map<string, string> {
	const byBasename = new Map<string, string[]>();
	const known = new Set(paths);
	for (const path of paths) {
		const key = noteKey(path);
		const list = byBasename.get(key) ?? [];
		list.push(path);
		byBasename.set(key, list);
	}

	const risks = new Map<string, string>();
	const freeze = (path: string, reason: string) => {
		if (!risks.has(path) && known.has(path)) risks.set(path, reason);
	};
	const freezeTargets = (target: string, reason: string) => {
		const exact = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
		if (known.has(exact)) {
			freeze(exact, reason);
			return;
		}
		for (const candidate of byBasename.get(noteKey(target)) ?? []) freeze(candidate, reason);
	};

	for (const path of paths) {
		let raw: string;
		try {
			raw = readFileSync(join(root, path), "utf-8");
		} catch {
			// Unreadable at plan time is unreadable at apply time; freezing costs nothing.
			freeze(path, "unreadable");
			continue;
		}
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const frontmatter = raw.match(FRONTMATTER_RE)?.[1] ?? "";
		if (HAS_WIKILINK_RE.test(frontmatter)) freeze(path, "frontmatter link declares its position");

		for (const match of raw.matchAll(WIKILINK_RE)) {
			const cleaned = (match[1] ?? "").split("|")[0]!.split("#")[0]!.trim();
			if (!cleaned.includes("/")) continue;
			freeze(path, "contains a path-qualified [[link]]");
			freezeTargets(cleaned, "targeted by a path-qualified [[link]]");
		}

		for (const match of raw.matchAll(MARKDOWN_LINK_RE)) {
			const target = (match[1] ?? "").replace(/^<|>$/g, "");
			if (!target || target.startsWith("#") || target.startsWith("/") || URL_SCHEME_RE.test(target)) continue;
			freeze(path, "contains a relative markdown link");
			let decoded = target.split("#")[0]!;
			try {
				decoded = decodeURIComponent(decoded);
			} catch {
				/* a stray % in a filename is not an escape; use it as written */
			}
			if (decoded.toLowerCase().endsWith(".md")) freeze(resolveRelative(dir, decoded), "targeted by a relative link");
		}
	}
	return risks;
}

/**
 * Lowercased basenames that more than one note shares. Moving one of them changes what a
 * bare `[[PLAN]]` resolves to for every note in the vault — Obsidian prefers the nearest
 * match and resolveLink() tiebreaks on the top-level folder, so both answers move with
 * the file. Case-insensitive because half of these vaults sync to a case-insensitive
 * filesystem, where `plan.md` and `Plan.md` are already the same note.
 */
export function ambiguousBasenames(paths: string[]): Set<string> {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const path of paths) {
		const key = noteKey(path);
		if (seen.has(key)) duplicated.add(key);
		else seen.add(key);
	}
	return duplicated;
}

/** The basename key used by {@link ambiguousBasenames}, so callers ask the same question. */
export function basenameKey(path: string): string {
	return noteKey(path);
}

const DATED_BASENAME_RE = /^\d{4}-\d{2}-\d{2}/;
/** A folder that is itself a calendar level: 2026, 07, W30. */
const PERIODIC_FOLDER_RE = /^(?:\d{4}|0[1-9]|1[0-2]|[Ww]\d{2})$/;
const JOURNAL_MIN_CHILDREN = 3;
const JOURNAL_DATED_SHARE = 0.6;

/**
 * True when any segment of `folder` is itself a calendar level (2026, 07, W30) or opens
 * with a date. Such a folder must never be *created* by a reorganize: journalFolders()
 * would classify it on the next run, and every note the previous run filed there would be
 * frozen from then on with a reason the user cannot trace back to the cause.
 *
 * A structural check, not a line of prompt text — the model is asked not to propose these,
 * and asking is not a control.
 */
export function calendarShapedFolder(folder: string): boolean {
	return folder.split("/").some((segment) => PERIODIC_FOLDER_RE.test(segment) || DATED_BASENAME_RE.test(segment));
}

function folderOf(path: string): string {
	return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function normaliseFolder(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().replace(/^[\\/]+|[\\/]+$/g, "").split(/[\\/]+/).join("/");
	return trimmed || null;
}

/** Daily-notes and periodic-notes both store their folder in .obsidian; a vault that has
 *  configured one has told us plainly which folder is off limits. */
function configuredJournalFolders(root: string): string[] {
	const found: string[] = [];
	const readJson = (...parts: string[]): Record<string, unknown> | null => {
		try {
			return JSON.parse(readFileSync(join(root, ".obsidian", ...parts), "utf-8")) as Record<string, unknown>;
		} catch {
			return null;
		}
	};
	const daily = readJson("daily-notes.json");
	const fromDaily = normaliseFolder(daily?.folder);
	if (fromDaily) found.push(fromDaily);

	const periodic = readJson("plugins", "periodic-notes", "data.json");
	for (const period of ["daily", "weekly", "monthly", "quarterly", "yearly"]) {
		const block = periodic?.[period] as { folder?: unknown } | undefined;
		const folder = normaliseFolder(block?.folder);
		if (folder) found.push(folder);
	}
	return found;
}

/**
 * Folders holding dated notes, which reorganize must never touch: a journal's filing
 * system is the date, it is already correct, and reshuffling it destroys the one ordering
 * the user relies on.
 *
 * Three independent rules, because each misses what the others catch. The share rule
 * misses `01 Journals/2026/07/24.md` (whose basenames are not dates at all); the folder
 * name rule misses `Daily/2026-07-24.md`; both miss an empty-but-configured daily folder.
 */
export function journalFolders(paths: string[], root: string): Set<string> {
	const total = new Map<string, number>();
	const dated = new Map<string, number>();
	const allFolders = new Set<string>();

	for (const path of paths) {
		const folder = folderOf(path);
		total.set(folder, (total.get(folder) ?? 0) + 1);
		if (DATED_BASENAME_RE.test(basename(path))) dated.set(folder, (dated.get(folder) ?? 0) + 1);
		// Ancestors too: an intermediate `2026/` holds only folders and would never appear.
		const segments = folder ? folder.split("/") : [];
		for (let i = 1; i <= segments.length; i++) allFolders.add(segments.slice(0, i).join("/"));
	}

	const journals = new Set<string>();
	for (const [folder, count] of total) {
		if (!folder || count < JOURNAL_MIN_CHILDREN) continue;
		if ((dated.get(folder) ?? 0) / count >= JOURNAL_DATED_SHARE) journals.add(folder);
	}
	for (const folder of allFolders) {
		if (PERIODIC_FOLDER_RE.test(basename(folder))) journals.add(folder);
	}
	for (const folder of configuredJournalFolders(root)) journals.add(folder);
	return journals;
}

/** True when `relPath` sits in one of `folders` or anywhere beneath it. */
export function underAnyFolder(relPath: string, folders: Set<string>): boolean {
	if (folders.size === 0) return false;
	const segments = folderOf(relPath).split("/").filter(Boolean);
	for (let i = 1; i <= segments.length; i++) {
		if (folders.has(segments.slice(0, i).join("/"))) return true;
	}
	return false;
}
