// What reorganize is allowed to consider, and what it must leave alone.
//
// The inventory is deliberately tiny per note — title, tags, three headings, a 160-char
// opening — because the alternative does not fit: a 5000-note vault sent as note bodies
// is millions of tokens, and one call per note costs $18 at the measured floor of a
// --safe-mode haiku call. Everything downstream batches these lines, so this is the one
// place that decides how much of the user's vault leaves the machine.
//
// Candidates come from the `docs` index rather than a fresh walk, so a note the index has
// not seen is simply never proposed for a move. That is the safe direction of staleness,
// and it is why the CLI reindexes before planning.

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR, IGNORED_DIR_NAMES, vaultReady, vaultRoot } from "./config";
import { openBrainDb } from "./index-db";
import {
	ambiguousBasenames,
	basenameKey,
	journalFolders,
	obsidianLinkFormat,
	scanLinkRisks,
	underAnyFolder,
	vaultNotePath,
} from "./vault-links";

/** One line of prompt, and everything a decision is keyed on. */
export interface InventoryNote {
	/** 1..N in path order. Integer ids mean the model never echoes a path back at us. */
	id: number;
	path: string;
	folder: string;
	title: string;
	tags: string[];
	headings: string[];
	lead: string;
	/** Hash of what the model is shown, deliberately excluding the path — so a cached
	 *  decision survives the move it caused instead of being re-asked next run. */
	fingerprint: string;
}

export interface FrozenNote {
	path: string;
	reason: string;
}

export interface FolderCount {
	folder: string;
	notes: number;
}

export interface Inventory {
	root: string;
	scope: string | null;
	notes: InventoryNote[];
	frozen: FrozenNote[];
	/** Existing folders (≤2 deep) with note counts — the taxonomy prompt's seed. */
	folders: FolderCount[];
	topTags: Array<{ tag: string; count: number }>;
	communities: Array<{ label: string; size: number }>;
	journals: Set<string>;
	/** Candidates dropped by --max, so the caller can say so rather than silently plan part of a vault. */
	truncated: number;
}

export type InventoryProblem = "no-vault" | "link-format" | "too-few";

export type InventoryResult =
	| { ok: true; inventory: Inventory }
	| { ok: false; problem: InventoryProblem; message: string };

export interface InventoryOptions {
	/** Only notes under this folder are candidates; the whole vault is still described. */
	scope?: string;
	max?: number;
	includeRoot?: boolean;
	freeze?: string[];
}

/** A 5000-note vault must not plan itself whole because someone typed the bare verb. */
export const DEFAULT_MAX_NOTES = 1500;
/** Below this, a taxonomy is a guess: asking a model to invent folders for a handful of
 *  notes produces a filing system nobody would have chosen, at real cost. */
const MIN_CANDIDATES = 25;
const HEAD_BYTES = 2048;
/** Second-chance budget for a note whose frontmatter did not close inside HEAD_BYTES. A
 *  Dataview property block, a long `aliases` list or a base64 banner all get past 2 KB
 *  routinely, and `brain: freeze` is usually the first line of exactly such a block. */
const MAX_FRONTMATTER_BYTES = 32 * 1024;
const LEAD_CHARS = 160;
const MAX_HEADINGS = 3;
const FOLDER_DEPTH = 2;

const FREEZE_FILE = join(CONFIG_DIR, "reorganize-freeze.txt");

interface Head {
	text: string;
	/** The read filled its budget, so the note may continue past what `text` holds. */
	truncated: boolean;
}

function readBytes(absPath: string, limit: number): Head {
	let fd: number;
	try {
		fd = openSync(absPath, "r");
	} catch {
		return { text: "", truncated: false };
	}
	try {
		const buffer = Buffer.allocUnsafe(limit);
		const read = readSync(fd, buffer, 0, limit, 0);
		return { text: buffer.subarray(0, read).toString("utf-8"), truncated: read === limit };
	} finally {
		closeSync(fd);
	}
}

/**
 * Read the opening of a note. The whole file is never needed here and these vaults live
 * on portable disks; a truncated multi-byte character at the cut only ever lands inside
 * a lead we are about to trim anyway.
 *
 * The one thing the cut may not swallow is the frontmatter's closing `---`, because
 * `brain: freeze` is the user's only way to say "never move this" and it lives in there.
 * A head that opens a frontmatter it does not close is re-read with a much larger budget
 * before anything concludes the note said nothing.
 */
function readHead(absPath: string): Head {
	const head = readBytes(absPath, HEAD_BYTES);
	if (!head.truncated || !head.text.startsWith("---") || FRONTMATTER_RE.test(head.text)) return head;
	return readBytes(absPath, MAX_FRONTMATTER_BYTES);
}

/** `**` crosses folders, `*` does not. The two-star forms are parked on placeholder
 *  characters first because their expansions contain `*`, which the single-star pass
 *  would otherwise rewrite a second time. */
function globToRegExp(glob: string): RegExp {
	const body = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "\u0000")
		.replace(/\*\*/g, "\u0001")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, "(?:.*/)?")
		.replace(/\u0001/g, ".*");
	return new RegExp(`^${body}$`, "i");
}

interface FreezeGlob {
	source: string;
	re: RegExp;
	/** A pattern with no slash is matched against the basename too, which is what a user
	 *  typing `--freeze "*.excalidraw.md"` means. */
	basenameToo: boolean;
}

function loadFreezeGlobs(extra: string[]): FreezeGlob[] {
	const lines = [...extra];
	try {
		for (const line of readFileSync(FREEZE_FILE, "utf-8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#")) lines.push(trimmed);
		}
	} catch {
		/* no freeze file is the normal case */
	}
	return lines
		.map((s) => s.trim())
		.filter(Boolean)
		.map((source) => ({ source, re: globToRegExp(source), basenameToo: !source.includes("/") }));
}

function matchFreeze(path: string, globs: FreezeGlob[]): FreezeGlob | null {
	for (const glob of globs) {
		if (glob.re.test(path)) return glob;
		if (glob.basenameToo && glob.re.test(basename(path))) return glob;
	}
	return null;
}

function folderOf(path: string): string {
	return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

interface NoteHead {
	title: string;
	headings: string[];
	lead: string;
	/** Non-null when the note must stay put, carrying the phrase printed in plan.md. */
	frozenReason: string | null;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseHead(head: Head, fallbackTitle: string): NoteHead {
	const raw = head.text;
	const frontmatter = raw.match(FRONTMATTER_RE);
	// An opened-but-unclosed frontmatter fails closed. Either it is longer than even the
	// second read, or the note is malformed — and in both cases we cannot see whether it
	// says `brain: freeze`. Not seeing the instruction is not the same as not being given
	// one, and this is the user's only way to say "never move this".
	// A note may legitimately open with a `---` thematic break, which is not an unclosed
	// frontmatter and must not be frozen. Frontmatter's first line is always `key:`, so
	// require that before treating a missing close as one.
	const opensFrontmatter = /^---\r?\n\s*[A-Za-z_][\w-]*\s*:/.test(raw);
	if (!frontmatter && opensFrontmatter) {
		const reason = head.truncated ? "frontmatter is longer than we read" : "frontmatter has no closing ---";
		return { title: fallbackTitle, headings: [], lead: "", frozenReason: reason };
	}
	if (/^brain:\s*freeze\s*$/im.test(frontmatter?.[1] ?? "")) {
		return { title: fallbackTitle, headings: [], lead: "", frozenReason: "frontmatter says brain: freeze" };
	}

	const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
	const headings: string[] = [];
	const leadLines: string[] = [];
	let title = "";
	let insideFence = false;
	for (const line of body.split(/\r?\n/)) {
		if (/^```/.test(line)) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence) continue;
		const heading = line.match(/^(#{1,4})\s+(.+)$/);
		if (heading) {
			const text = heading[2]!.trim();
			if (heading[1] === "#" && !title) title = text;
			else if (headings.length < MAX_HEADINGS) headings.push(text);
			continue;
		}
		if (leadLines.join(" ").length < LEAD_CHARS && line.trim()) leadLines.push(line.trim());
	}
	const lead = leadLines
		.join(" ")
		.replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, "$1")
		.replace(/[#*_`>]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, LEAD_CHARS);
	return { title: title || fallbackTitle, headings, lead, frozenReason: null };
}

interface DocRow {
	id: number;
	path: string;
	title: string;
}

/**
 * Collect candidates and freeze everything else, with a reason per frozen note that is
 * printed in plan.md — a user who disagrees with a freeze can only argue with it if they
 * can see it.
 *
 * Hard aborts before any of that when the vault's link format is not "shortest": there,
 * every wikilink Obsidian writes is path-qualified or relative, so every note's outgoing
 * links break the moment it moves, and our own basename-resolving index would report a
 * clean vault. Rewriting links is not on the table, so the only honest answer is to stop.
 */
export function buildInventory(opts: InventoryOptions = {}): InventoryResult {
	const root = vaultRoot();
	if (!root || !vaultReady()) {
		return { ok: false, problem: "no-vault", message: "no vault selected — run `claude-brain vault <path>`" };
	}

	const format = obsidianLinkFormat(root);
	if (format && (format.useMarkdownLinks || format.newLinkFormat !== "shortest")) {
		const setting = format.useMarkdownLinks ? "markdown links" : `new link format "${format.newLinkFormat}"`;
		return {
			ok: false,
			problem: "link-format",
			message:
				`this vault uses ${setting}, so its links are resolved by location, not by name.\n` +
				"Moving a note would break them and claude-brain would not notice.\n" +
				'Set Settings → Files & Links → "New link format" to "Shortest path when possible" and turn off "Use [[Wikilinks]]"' +
				" only if you know the existing links were written that way; otherwise reorganize is not for this vault.",
		};
	}

	const { db } = openBrainDb();
	const docs = db.query("SELECT id, path, title FROM docs ORDER BY path").all() as DocRow[];
	const paths = docs.map((d) => d.path);

	const journals = journalFolders(paths, root);
	const duplicates = ambiguousBasenames(paths);
	const linkRisks = scanLinkRisks(root, paths);
	const freezeGlobs = loadFreezeGlobs(opts.freeze ?? []);
	const scope = opts.scope?.replace(/^[\\/]+|[\\/]+$/g, "").split(/[\\/]+/).join("/") || null;

	const tagsByDoc = new Map<number, string[]>();
	for (const row of db.query("SELECT doc_id, tag FROM doc_tags ORDER BY tag").all() as Array<{
		doc_id: number;
		tag: string;
	}>) {
		const list = tagsByDoc.get(row.doc_id) ?? [];
		list.push(row.tag);
		tagsByDoc.set(row.doc_id, list);
	}

	const notes: InventoryNote[] = [];
	const frozen: FrozenNote[] = [];
	const folderCounts = new Map<string, number>();

	for (const doc of docs) {
		const folder = folderOf(doc.path);
		const shallow = folder.split("/").slice(0, FOLDER_DEPTH).join("/");
		if (shallow) folderCounts.set(shallow, (folderCounts.get(shallow) ?? 0) + 1);

		const reason = freezeReason(doc.path, folder, {
			journals,
			duplicates,
			linkRisks,
			freezeGlobs,
			includeRoot: opts.includeRoot === true,
			scope,
		});
		if (reason === "out of scope") continue;
		if (reason) {
			frozen.push({ path: doc.path, reason });
			continue;
		}

		const head = parseHead(readHead(join(root, doc.path)), doc.title);
		if (head.frozenReason) {
			frozen.push({ path: doc.path, reason: head.frozenReason });
			continue;
		}
		const tags = tagsByDoc.get(doc.id) ?? [];
		notes.push({
			id: notes.length + 1,
			path: doc.path,
			folder,
			title: head.title,
			tags,
			headings: head.headings,
			lead: head.lead,
			fingerprint: String(Bun.hash(`${head.title}\u0000${tags.join(",")}\u0000${head.headings.join(";")}\u0000${head.lead}`)),
		});
	}

	if (notes.length < MIN_CANDIDATES) {
		return {
			ok: false,
			problem: "too-few",
			message: `only ${notes.length} notes are eligible (${frozen.length} frozen) — reorganize needs at least ${MIN_CANDIDATES} to propose a filing system worth having`,
		};
	}

	const max = opts.max && opts.max > 0 ? opts.max : DEFAULT_MAX_NOTES;
	const truncated = Math.max(0, notes.length - max);
	const kept = notes.slice(0, max);
	// Ids are positions in the list actually sent, so a truncated run still numbers 1..N.
	kept.forEach((note, index) => {
		note.id = index + 1;
	});

	return {
		ok: true,
		inventory: {
			root,
			scope,
			notes: kept,
			frozen,
			folders: [...folderCounts]
				.map(([folder, count]) => ({ folder, notes: count }))
				.sort((a, b) => b.notes - a.notes),
			topTags: db
				.query("SELECT tag, count(*) AS count FROM doc_tags GROUP BY tag ORDER BY count DESC LIMIT 40")
				.all() as Array<{ tag: string; count: number }>,
			communities: db
				.query("SELECT label, size FROM community_labels ORDER BY size DESC LIMIT 30")
				.all() as Array<{ label: string; size: number }>,
			journals,
			truncated,
		},
	};
}

interface FreezeContext {
	journals: Set<string>;
	duplicates: Set<string>;
	linkRisks: Map<string, string>;
	freezeGlobs: FreezeGlob[];
	includeRoot: boolean;
	scope: string | null;
}

/** The single list of reasons a note stays put, in the order a user would expect to be
 *  told about them. "out of scope" is not a freeze — it is a note this run never looked at. */
function freezeReason(path: string, folder: string, ctx: FreezeContext): string | null {
	if (ctx.scope && folder !== ctx.scope && !folder.startsWith(`${ctx.scope}/`)) return "out of scope";
	if (folder.split("/").some((segment) => IGNORED_DIR_NAMES.has(segment))) return "in an ignored folder";
	// A path plan.md cannot carry unambiguously — a newline in the name, a `..` segment —
	// is a path apply would have to guess at. The index is not a trusted input here either.
	if (vaultNotePath(path) !== path) return "path cannot be written into a plan file";
	if (!folder && !ctx.includeRoot) return "vault root (use --include-root)";
	if (underAnyFolder(path, ctx.journals)) return "journal folder";
	if (ctx.duplicates.has(basenameKey(path))) return "another note shares this filename";
	const glob = matchFreeze(path, ctx.freezeGlobs);
	if (glob) return `frozen by ${glob.source}`;
	return ctx.linkRisks.get(path) ?? null;
}
