// Turning a vision model's JSON into the thing that is actually retrievable: a note.
//
// The brain's retrieval is text — BM25 over FTS5 plus 384-dim embeddings — so an image
// blob is not memory, it is an attachment. What makes "build me something like that
// dashboard I saved" work is a durable written description sitting in the vault next to
// everything else the user knows, indexed by the same indexer, editable in Obsidian,
// carried by the same rclone sync.
//
// The image that goes with it is a preview, never the upload. The vault is usually a synced
// folder, so anything written here is something the user uploads to Dropbox or Mega; the
// real bytes stay in DATA_DIR (design-store.ts) and only a small downscaled copy travels.
//
// Nothing here spawns a subprocess, so session-memory.ts and the CLI can import the brief
// renderer without dragging in the LLM bridge.

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designFolder, loadConfig, vaultReady, vaultRoot } from "./config";
import {
	type DesignRow,
	VAULT_IMAGE_SUBDIR,
	freeFileName,
	imagePath,
	renderPath,
	thumbPath,
	updateDesign,
} from "./design-store";

export interface PaletteEntry {
	/** Always `#rrggbb`. The hex is the point — a role with no colour is not reusable. */
	hex: string;
	role: string;
	note: string;
}

export interface DesignSpec {
	name: string;
	/** One sentence: what it feels like to look at. */
	vibe: string;
	mood: string[];
	layout: string[];
	spacing: string[];
	palette: PaletteEntry[];
	typography: string[];
	/** Radii, borders, elevation, shadows. */
	shape: string[];
	motion: string[];
	/** The two or three things that make it recognisably itself. */
	signature: string[];
	avoid: string[];
	recreate: string[];
}

/** Long enough to hold a palette and a type scale; short enough to drop into every turn. */
export const DESIGN_BRIEF_CHARS = 800;

const MAX_ITEMS = 12;
const MAX_CHARS = 400;
const MAX_NAME_CHARS = 80;
const MAX_TAGS = 6;

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS) : "";
}

function textList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(text).filter(Boolean).slice(0, MAX_ITEMS);
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function hex(value: unknown): string | null {
	const match = HEX.exec(typeof value === "string" ? value.trim() : "");
	if (!match) return null;
	const digits = match[1]!.toLowerCase();
	return `#${digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits}`;
}

function paletteOf(value: unknown): PaletteEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: PaletteEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		const code = hex(raw.hex);
		if (!code) continue;
		entries.push({ hex: code, role: text(raw.role), note: text(raw.note) });
		if (entries.length === MAX_ITEMS) break;
	}
	return entries;
}

/**
 * Hand-written coercion rather than a schema library — this is the only untrusted object
 * shape in the package, and it is worth no dependency.
 *
 * `thin` is deliberately distinct from `null`. A greyscale wireframe genuinely has no
 * palette; reporting that as unparseable would trigger a retry whose prompt says "your
 * previous reply was not valid JSON", which is false, confusing, and a second billed
 * vision call for a result that will be just as thin.
 */
export function normalizeSpec(raw: unknown): { spec: DesignSpec; thin: boolean } | null {
	if (!raw || typeof raw !== "object") return null;
	const src = raw as Record<string, unknown>;
	const spec: DesignSpec = {
		name: text(src.name).slice(0, MAX_NAME_CHARS),
		vibe: text(src.vibe),
		mood: textList(src.mood),
		layout: textList(src.layout),
		spacing: textList(src.spacing),
		palette: paletteOf(src.palette),
		typography: textList(src.typography),
		shape: textList(src.shape),
		motion: textList(src.motion),
		signature: textList(src.signature),
		avoid: textList(src.avoid),
		recreate: textList(src.recreate),
	};
	// A reply with no name, no description and no mood is not a design; it is prose that
	// happened to fit the schema.
	if (!spec.name && !spec.vibe && spec.mood.length === 0) return null;
	const thin = spec.palette.length === 0 && spec.typography.length === 0;
	return { spec, thin };
}

/** Frontmatter tags are matched by a single regex in relations.ts; anything with a comma
 *  or a bracket in it would split that line into nonsense. */
function tagify(word: string): string {
	return word
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
}

function cell(value: string): string {
	return value.replace(/\|/g, "\\|");
}

function section(heading: string, lines: string[]): string[] {
	return lines.length === 0 ? [] : [`## ${heading}`, ...lines.map((line) => `- ${line}`), ""];
}

/**
 * The note. Frontmatter is exactly `tags: [design, …]` on one bracketed line — the only
 * shape parseTags() matches, and getting it wrong means the design never joins the vault's
 * tag graph.
 *
 * `imageRel` is vault-relative on purpose. Baking the absolute DATA_DIR path into a note
 * that rclone-syncs to other machines makes it wrong everywhere except the machine that
 * wrote it; `design show` resolves the real path at print time instead.
 */
export function renderDesignNote(spec: DesignSpec, row: DesignRow, imageRel?: string): string {
	const tags = ["design", ...spec.mood.map(tagify)].filter(Boolean).slice(0, MAX_TAGS);
	// Through text() even though saveDesign now stores a collapsed source_name: rows written
	// by an older version still hold whatever the filename had in it, and a newline here
	// would put arbitrary text on its own line at the top of a note in the user's vault.
	const title = spec.name || text(row.name) || text(row.source_name) || `Design ${row.id}`;

	const lines: string[] = [
		"---",
		`tags: [${[...new Set(tags)].join(", ")}]`,
		`brain-design: ${row.id}`,
		`source: ${JSON.stringify(row.source_name)}`,
		"---",
		"",
		`# ${title}`,
		"",
	];
	if (spec.vibe) lines.push(spec.vibe, "");
	if (row.caption) lines.push(`Saved because: ${row.caption}`, "");

	lines.push(...section("Mood", spec.mood));
	lines.push(...section("Layout & spacing", [...spec.layout, ...spec.spacing]));

	if (spec.palette.length > 0) {
		lines.push(
			"## Palette",
			"",
			"| Hex | Role | Note |",
			"| --- | --- | --- |",
			...spec.palette.map((p) => `| \`${p.hex}\` | ${cell(p.role)} | ${cell(p.note)} |`),
			"",
		);
	}

	lines.push(...section("Typography", spec.typography));
	lines.push(...section("Shape & depth", spec.shape));
	lines.push(...section("Motion", spec.motion));
	lines.push(...section("Signature moves", spec.signature));
	lines.push(...section("Avoid", spec.avoid));
	lines.push(...section("Recreating it", spec.recreate));

	if (imageRel) lines.push(`![preview](${imageRel})`, "");
	return `${lines.join("\n").trimEnd()}\n`;
}

const ILLEGAL_IN_FILENAME = /[\\/:*?"<>|#^[\]]/g;

function noteBaseName(name: string, fallback: string): string {
	const cleaned = name
		.replace(ILLEGAL_IN_FILENAME, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_CHARS)
		// A trailing dot or space survives on Linux but not on the other end of a sync.
		.replace(/[. ]+$/, "");
	return cleaned || fallback;
}

export type WriteNoteResult =
	| { ok: true; path: string; created: boolean }
	| { ok: false; reason: "no-vault" | "empty-index" | "write-failed"; detail: string };

/**
 * The stub-mount signature is the directory, not the index.
 *
 * An unmounted mountpoint is an empty, readable directory; a vault — even one created five
 * minutes ago to collect design references — has at least `.obsidian` in it. The index's
 * doc count answers a different question and answers it wrongly here: a brand-new vault has
 * zero docs, and the first design note is the thing that would change that, so refusing on
 * the count locks the feature out of exactly the vault it was wanted for, permanently and
 * with a sentence that is not true. It also reads zero for a few seconds on every real
 * vault, before the first index pass finishes.
 */
function looksUnmounted(root: string): boolean {
	try {
		return readdirSync(root).length === 0;
	} catch {
		return true;
	}
}

/**
 * The vault is usually a synced folder, so a copy made here is a copy someone uploads.
 * The downscaled render is worth that; a 12 MB original is not, and design-store keeps the
 * real bytes outside the vault precisely so a vault of notes stays a vault of notes.
 */
const MAX_VAULT_IMAGE_BYTES = 2 * 1024 * 1024;

/** Best preview small enough to belong in the vault, or null if none of them is. */
function previewSource(row: DesignRow): { path: string; name: string } | null {
	const candidates = [row.render ? renderPath(row.id) : "", imagePath(row), row.thumb ? thumbPath(row.id) : ""];
	for (const path of candidates) {
		if (!path) continue;
		const size = Bun.file(path).size;
		if (size === 0 || size > MAX_VAULT_IMAGE_BYTES) continue;
		// `<id>.<ext>`, which is what design-store's vaultImageCopies() looks for when the
		// design is forgotten and the row that could have named this file is gone.
		return { path, name: `${row.id}${path.slice(path.lastIndexOf("."))}` };
	}
	return null;
}

/**
 * Never writes over a file it did not create. `wx` rather than a plain write because
 * freeFileName is a check-then-act: an rclone pass landing a note from another machine in
 * that window, or a second claude-brain process, would otherwise silently lose it.
 */
function writeNewFile(path: string, body: string): string {
	try {
		writeFileSync(path, body, { encoding: "utf-8", flag: "wx" });
		return path;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// One retry is enough: the name that lost is on disk now, so freeFileName picks past it.
		const retry = freeFileName(path);
		writeFileSync(retry, body, { encoding: "utf-8", flag: "wx" });
		return retry;
	}
}

/**
 * File the note into the vault and stamp the row with where it went.
 *
 * Two guards, both about not making a mess in someone else's directory:
 *
 *  - A vault root that is an empty directory means the mount is a stub. Writing there
 *    populates a phantom tree at the mountpoint, after which udisks either refuses to
 *    mount over it or mounts the real disk as `<label>1`.
 *  - An existing file is never overwritten. If this design already has a note on disk we
 *    leave it exactly as it is: the user may have edited it, and a re-extraction saying
 *    much the same thing is not worth losing their edit over.
 */
export function writeDesignNote(row: DesignRow, spec: DesignSpec): WriteNoteResult {
	const root = vaultRoot();
	if (!root || !vaultReady()) {
		return { ok: false, reason: "no-vault", detail: "no vault is mounted — the note will be written when one is" };
	}
	if (looksUnmounted(root)) {
		// The reason code keeps its name for the callers that already switch on it.
		return {
			ok: false,
			reason: "empty-index",
			detail: "the vault folder is completely empty, which usually means the drive is not really mounted",
		};
	}

	if (row.note_path && Bun.file(join(root, row.note_path)).size > 0) {
		return { ok: true, path: row.note_path, created: false };
	}

	const folder = designFolder();
	const dir = join(root, folder);
	try {
		mkdirSync(dir, { recursive: true });
		const imageRel = loadConfig().designs.copyImages ? copyPreview(row, dir) : undefined;
		const file = writeNewFile(
			freeFileName(join(dir, `${noteBaseName(spec.name, `Design ${row.id}`)}.md`)),
			renderDesignNote(spec, row, imageRel),
		);
		const rel = `${folder}/${file.slice(file.lastIndexOf("/") + 1)}`;
		updateDesign(row.id, { notePath: rel, noteMissing: false, vault: root });
		return { ok: true, path: rel, created: true };
	} catch (err) {
		return { ok: false, reason: "write-failed", detail: String(err) };
	}
}

/**
 * Deliberately outside the note's own try: the note is the memory and the image is a
 * convenience, so a full disk must not cost the user the 2 KB that would have made this
 * design recallable. Returns the vault-relative link, or undefined for a note without one.
 */
function copyPreview(row: DesignRow, dir: string): string | undefined {
	const preview = previewSource(row);
	if (!preview) return undefined;
	try {
		mkdirSync(join(dir, VAULT_IMAGE_SUBDIR), { recursive: true });
		copyFileSync(preview.path, join(dir, VAULT_IMAGE_SUBDIR, preview.name));
		return `${VAULT_IMAGE_SUBDIR}/${preview.name}`;
	} catch {
		return undefined;
	}
}

/**
 * The ~800 characters an agent needs before it starts building: enough to reuse the real
 * values, plus the pointer to the full note.
 *
 * Lines are dropped whole when the budget runs out, never truncated mid-line. A palette
 * cut off after two swatches is worse than no palette — it looks complete and is not.
 */
export function designBrief(rows: DesignRow[]): string {
	const blocks: string[] = [];
	let used = 0;
	for (const row of rows) {
		const parsed = normalizeSpec(safeSpec(row.spec));
		if (!parsed) continue;
		const { spec } = parsed;
		const name = spec.name || row.name || row.source_name;
		const title = `**${name}** — ${[spec.vibe, spec.mood.join(", ")].filter(Boolean).join(" ")}`.trim();
		// Reserved up front rather than appended last: this pointer is the escape hatch to
		// the full note and the image, so it must not be the first thing the budget drops.
		const pointer = `full spec: \`claude-brain design show "${name}"\``;
		const overhead = title.length + pointer.length + 2;
		if (used + overhead > DESIGN_BRIEF_CHARS) break;

		const kept = [title];
		used += overhead;
		for (const line of [
			spec.palette.length > 0
				? `palette: ${spec.palette.map((p) => (p.role ? `${p.hex} ${p.role}` : p.hex)).join(" · ")}`
				: "",
			spec.typography.length > 0 ? `type: ${spec.typography.join("; ")}` : "",
			[...spec.shape, ...spec.spacing].length > 0 ? `shape: ${[...spec.shape, ...spec.spacing].join("; ")}` : "",
			spec.motion.length > 0 ? `motion: ${spec.motion.join("; ")}` : "",
			spec.signature.length > 0 ? `moves: ${spec.signature.join("; ")}` : "",
		]) {
			if (!line || used + line.length + 1 > DESIGN_BRIEF_CHARS) continue;
			kept.push(line);
			used += line.length + 1;
		}
		kept.push(pointer);
		blocks.push(kept.join("\n"));
	}
	return blocks.join("\n\n");
}

function safeSpec(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
