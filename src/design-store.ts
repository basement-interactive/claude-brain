// Where a saved design's *bytes* live, and what we know about where they came from.
//
// The memory itself is a markdown note in the user's vault (design-note.ts) — that is
// what recall ranks and what the user can edit. This module deliberately keeps only the
// original pixels and a provenance row, both outside the vault: an upload must survive
// an unmounted drive, and a vault of notes should stay a vault of notes rather than
// silently accumulating megabytes of PNGs.
//
// Ids are content hashes. Re-dropping the same screenshot is therefore a no-op, with one
// exception spelled out in saveDesign() — re-dropping is also the natural gesture for
// "that one failed, try again", and a silent no-op there would be a dead end.

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DATA_DIR, designFolder, vaultRoot } from "./config";
import { type ImageMime, imageMeta, sniffMime } from "./image-meta";
import { openBrainDb } from "./index-db";

export const DESIGN_DIR = join(DATA_DIR, "designs");
const THUMB_DIR = join(DESIGN_DIR, "thumbs");
const RENDER_DIR = join(DESIGN_DIR, "renders");

/**
 * Sanity ceiling, not a policy. The server enforces its own, much smaller, request limit;
 * this only stops a mistyped `design add /path/to/something-enormous` from being copied
 * into the user's data directory before anything looks at it.
 */
export const MAX_DESIGN_BYTES = 64 * 1024 * 1024;

export type DesignStatus =
	/** Waiting for its turn in the extraction queue. */
	| "queued"
	/** A vision call is in flight. This is a lease, not a flag: it deliberately survives a
	 *  restart and is reclaimed only once its deadline in `next_attempt_at` has passed, so
	 *  a daemon and a CLI cannot both describe the same upload. */
	| "extracting"
	/** Described and filed: spec stored, note written. */
	| "described"
	/** Described, but the description is nearly empty (a greyscale wireframe). Not retried. */
	| "thin"
	/** Too big for a vision call as-is; the dashboard has to downscale it first. */
	| "needs-render"
	/** LLM features were off when its turn came. */
	| "disabled"
	/** The `claude` CLI was missing or unauthenticated when its turn came. */
	| "unavailable"
	/** The call ran and produced nothing usable. */
	| "failed";

/**
 * Re-uploading an image whose row is in one of these states resets it and re-enqueues.
 * `described`/`thin` are absent on purpose: those already produced a note the user may
 * have edited, and a second extraction would be paid for to say the same thing.
 */
const RESETTABLE: ReadonlySet<DesignStatus> = new Set<DesignStatus>([
	"failed",
	"unavailable",
	"disabled",
	"needs-render",
]);

/** Column-for-column, as stored. Snake_case matches the table so `SELECT *` needs no mapping. */
export interface DesignRow {
	id: string;
	vault: string;
	note_path: string;
	note_missing: number;
	name: string;
	caption: string;
	source_name: string;
	mime: string;
	bytes: number;
	width: number;
	height: number;
	thumb: number;
	render: number;
	status: DesignStatus;
	attempts: number;
	next_attempt_at: number;
	error: string;
	/** Raw JSON of what the model returned. Frozen provenance; the note is the live copy. */
	spec: string;
	/** JSON array of hex strings, for the dashboard's swatch strip and the LIKE search. */
	palette: string;
	/** Comma-joined mood words, same reason. */
	mood: string;
	created: number;
	extracted: number;
}

const EXTENSION: Record<ImageMime, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
};

/** The only traversal guard the blob endpoints need: an id is a hash or it is nothing. */
export function validId(id: string): boolean {
	return /^[0-9a-f]{16}$/.test(id);
}

/** First 16 hex of sha256 — 64 bits, which is plenty to separate one person's screenshots. */
export function designId(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
}

function ensureDirs(): void {
	for (const dir of [DESIGN_DIR, THUMB_DIR, RENDER_DIR]) mkdirSync(dir, { recursive: true });
}

/** Absolute path of the original upload. The extension is nominal — every reader sniffs. */
export function imagePath(row: DesignRow): string {
	return join(DESIGN_DIR, `${row.id}.${EXTENSION[row.mime as ImageMime] ?? "bin"}`);
}

// Thumbs and renders are always webp (the dashboard encodes them), so unlike the original
// they need no row to name their file.
export function thumbPath(id: string): string {
	return join(THUMB_DIR, `${id}.webp`);
}

export function renderPath(id: string): string {
	return join(RENDER_DIR, `${id}.webp`);
}

/** Where design-note.ts puts its copy of the image, when the user asked for one. */
export const VAULT_IMAGE_SUBDIR = "_images";

/**
 * Every name that copy could have inside the current vault. The extension follows the
 * source file, so it cannot be derived from the row once the row is gone — which is
 * exactly when `forgetDesign` needs it, so the candidates are enumerated instead.
 */
export function vaultImageCopies(root: string, id: string): string[] {
	const dir = join(root, designFolder(), VAULT_IMAGE_SUBDIR);
	const extensions = new Set([...Object.values(EXTENSION), "bin"]);
	return [...extensions].map((ext) => join(dir, `${id}.${ext}`)).filter(existsSync);
}

/**
 * Write bytes under their final name only once all of them are there. A kill, a full disk
 * or a yanked drive mid-write then leaves a `.part` file nobody reads, rather than a short
 * file under the name every reader trusts.
 */
async function writeBlob(path: string, bytes: Uint8Array): Promise<void> {
	// Pid-suffixed so two processes storing the same upload cannot share a scratch file.
	const part = `${path}.${process.pid}.part`;
	try {
		await Bun.write(part, bytes);
		renameSync(part, path);
	} catch (err) {
		// Without this the scratch file is permanent litter: nothing else in the package
		// walks DESIGN_DIR, and forgetDesign only unlinks the exact final names.
		try {
			unlinkSync(part);
		} catch {
			/* already gone, or the same condition that failed the write */
		}
		throw err;
	}
}

/**
 * Clear scratch files a previous run was killed before renaming. Cheap enough to do at
 * open: a design directory holds tens of files, not thousands.
 */
export function sweepPartFiles(): number {
	let removed = 0;
	for (const dir of [DESIGN_DIR, THUMB_DIR, RENDER_DIR]) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".part")) continue;
			try {
				unlinkSync(join(dir, name));
				removed++;
			} catch {
				/* another process is mid-write under the same name */
			}
		}
	}
	return removed;
}

/**
 * The original, which is content-addressed: same id, same bytes, so a file already the
 * right length is already the right file and re-copying up to 64 MB would be pure cost.
 *
 * Length, not presence. A truncated blob left by an interrupted write is the one case that
 * matters here — a re-upload of that image would short-circuit on a presence check forever,
 * so the copy would stay broken with no path in the package that ever replaces it.
 */
async function writeOriginal(path: string, bytes: Uint8Array): Promise<void> {
	if (Bun.file(path).size === bytes.length) return;
	await writeBlob(path, bytes);
}

export function getDesign(id: string): DesignRow | null {
	if (!validId(id)) return null;
	const { db } = openBrainDb();
	return (db.query("SELECT * FROM designs WHERE id = ?").get(id) as DesignRow | null) ?? null;
}

export interface SaveDesignInput {
	bytes: Uint8Array;
	sourceName: string;
	caption?: string;
	/** Client-measured dimensions, used only when the header parser cannot tell us. */
	width?: number;
	height?: number;
	/** Browser-encoded webp previews, when the upload came from the dashboard. */
	thumb?: Uint8Array;
	render?: Uint8Array;
	/** Status for a brand-new row. A caller that already knows extraction cannot run
	 *  (LLM off, or the file needs downscaling) passes it here rather than queueing a
	 *  job whose only job is to fail. */
	status?: DesignStatus;
}

export type SaveDesignResult =
	| {
			ok: true;
			row: DesignRow;
			/** The id had never been seen before. */
			fresh: boolean;
			/** An existing dead-end row was reset and wants re-enqueueing. */
			requeued: boolean;
	  }
	| { ok: false; reason: "not-an-image" | "truncated" | "too-large" };

/**
 * Store bytes and their row. Idempotent by construction, except that a re-upload of an
 * image whose previous attempt dead-ended is treated as the user asking again.
 *
 * The declared Content-Type never reaches this function: the mime comes from the magic
 * bytes, so an SVG (script-capable, and we serve these back from the dashboard's own
 * origin) cannot get in by claiming to be a PNG.
 */
export async function saveDesign(input: SaveDesignInput): Promise<SaveDesignResult> {
	if (input.bytes.length > MAX_DESIGN_BYTES) return { ok: false, reason: "too-large" };
	const mime = sniffMime(input.bytes);
	if (!mime) return { ok: false, reason: "not-an-image" };
	const meta = imageMeta(input.bytes);
	// A null meta means "we cannot parse this header" (AVIF), not "this is broken" — only
	// a parsed header that says the file is unterminated is grounds for refusing it.
	if (meta && !meta.complete) return { ok: false, reason: "truncated" };

	const id = designId(input.bytes);
	ensureDirs();
	await writeOriginal(join(DESIGN_DIR, `${id}.${EXTENSION[mime]}`), input.bytes);
	// Written here rather than through attachThumb/attachRender: those refuse an id with no
	// row, which is precisely the case on the way in.
	const thumb = input.thumb && sniffMime(input.thumb) ? input.thumb : null;
	const render = input.render && sniffMime(input.render) ? input.render : null;
	if (thumb) await writeBlob(thumbPath(id), thumb);
	if (render) await writeBlob(renderPath(id), render);

	const { db } = openBrainDb();
	const existing = getDesign(id);
	if (existing) {
		const requeued = RESETTABLE.has(existing.status);
		const patch: DesignPatch = {};
		if (input.caption) patch.caption = input.caption;
		if (thumb) patch.thumb = true;
		if (render) patch.render = true;
		if (requeued) {
			patch.status = input.status ?? "queued";
			patch.attempts = 0;
			patch.nextAttemptAt = 0;
			patch.error = "";
		}
		updateDesign(id, patch);
		return { ok: true, row: getDesign(id)!, fresh: false, requeued };
	}

	// ON CONFLICT because the check above is not atomic across processes: a dashboard drop
	// and a `design add` of the same file race, and losing that race must not turn a
	// correctly stored upload into a stack trace.
	//
	// `vault` starts empty on purpose. It records where the design was *filed*, which is
	// what writeDesignNote stamps on the first successful note write — stamping the mounted
	// vault at upload time makes an upload that was never filed anywhere invisible in every
	// other vault, with no way for the user to guess why.
	const insert = db
		.query(
			`INSERT INTO designs (id, vault, source_name, caption, mime, bytes, width, height, thumb, render, status, created)
			 VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
		)
		.run(
			id,
			cleanName(input.sourceName),
			input.caption?.slice(0, 400) ?? "",
			mime,
			input.bytes.length,
			meta?.width ?? input.width ?? 0,
			meta?.height ?? input.height ?? 0,
			thumb ? 1 : 0,
			render ? 1 : 0,
			input.status ?? "queued",
			Date.now(),
		);
	return { ok: true, row: getDesign(id)!, fresh: insert.changes > 0, requeued: false };
}

/**
 * The upload's filename reaches the note as its H1 fallback and its `source:` line, and a
 * filename may legally contain newlines. Collapsing here fixes the H1, the brief and the
 * frontmatter at once, rather than in each of the three places that read the column.
 */
function cleanName(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Backfill a downscaled preview. Returns false when the bytes are not an image at all, or
 * when the design has since been forgotten — writing a blob no row can name again leaks a
 * file `forgetDesign` will never find, and reporting success for it is a lie to the caller.
 */
export async function attachThumb(id: string, bytes: Uint8Array): Promise<boolean> {
	if (!validId(id) || !sniffMime(bytes) || !getDesign(id)) return false;
	ensureDirs();
	await writeBlob(thumbPath(id), bytes);
	updateDesign(id, { thumb: true });
	return true;
}

/**
 * Backfill the downscaled copy the vision call will actually read. This is what turns a
 * 34 MB phone screenshot from "permanently undescribable" into an ordinary queued job —
 * so it also has to take the row out of `needs-render`. Nothing else does: that status is
 * excluded from the resume pass by design, and a row left in it after the user has done
 * exactly what the error text asked would never be described.
 */
export async function attachRender(id: string, bytes: Uint8Array): Promise<boolean> {
	if (!validId(id) || !sniffMime(bytes)) return false;
	const row = getDesign(id);
	if (!row) return false;
	ensureDirs();
	await writeBlob(renderPath(id), bytes);
	updateDesign(id, { render: true });
	if (row.status === "needs-render") {
		updateDesign(id, { status: "queued", attempts: 0, nextAttemptAt: 0, error: "" });
	}
	return true;
}

export interface DesignPatch {
	name?: string;
	caption?: string;
	vault?: string;
	notePath?: string;
	noteMissing?: boolean;
	status?: DesignStatus;
	attempts?: number;
	nextAttemptAt?: number;
	error?: string;
	spec?: string;
	palette?: string;
	mood?: string;
	extracted?: number;
	width?: number;
	height?: number;
	thumb?: boolean;
	render?: boolean;
}

const COLUMN_OF: Record<keyof DesignPatch, string> = {
	name: "name",
	caption: "caption",
	vault: "vault",
	notePath: "note_path",
	noteMissing: "note_missing",
	status: "status",
	attempts: "attempts",
	nextAttemptAt: "next_attempt_at",
	error: "error",
	spec: "spec",
	palette: "palette",
	mood: "mood",
	extracted: "extracted",
	width: "width",
	height: "height",
	thumb: "thumb",
	render: "render",
};

export function updateDesign(id: string, patch: DesignPatch): void {
	const sets: string[] = [];
	const values: Array<string | number> = [];
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		// hasOwn, not truthiness: a patch built from a request body can carry `constructor`,
		// which a plain lookup resolves to a function and interpolates into the statement.
		if (!Object.hasOwn(COLUMN_OF, key)) continue;
		const column = COLUMN_OF[key as keyof DesignPatch];
		sets.push(`${column} = ?`);
		values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number));
	}
	if (sets.length === 0) return;
	openBrainDb()
		.db.query(`UPDATE designs SET ${sets.join(", ")} WHERE id = ?`)
		.run(...values, id);
}

export interface ListOptions {
	/** Include designs filed into a vault other than the current one. */
	all?: boolean;
	limit?: number;
}

/**
 * Current vault first, then rows that predate any vault choice, then — only with `all` —
 * everything filed elsewhere. A design uploaded before the user picked a vault has an
 * empty `vault` and must always be visible, or it would be invisible forever.
 */
export function listDesigns(options: ListOptions = {}): DesignRow[] {
	const { db } = openBrainDb();
	const root = vaultRoot() ?? "";
	return db
		.query(
			`SELECT * FROM designs
			 WHERE ? = 1 OR vault = ? OR vault = ''
			 ORDER BY CASE WHEN vault = ? THEN 0 WHEN vault = '' THEN 1 ELSE 2 END, created DESC
			 LIMIT ?`,
		)
		.all(options.all ? 1 : 0, root, root, options.limit ?? 500) as DesignRow[];
}

function likePattern(query: string): string {
	return `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Resolve "that dark dashboard" against the columns we already keep structured, before
 * anyone pays for a vector search. A design's identity is mostly its name, its mood words
 * and its hex values, and all three are stored here verbatim.
 */
export function findDesigns(query: string, limit = 6): DesignRow[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const { db } = openBrainDb();
	const pattern = likePattern(trimmed);
	const root = vaultRoot() ?? "";
	return db
		.query(
			`SELECT * FROM designs
			 WHERE name LIKE ?1 ESCAPE '\\' OR mood LIKE ?1 ESCAPE '\\' OR palette LIKE ?1 ESCAPE '\\'
			    OR caption LIKE ?1 ESCAPE '\\' OR source_name LIKE ?1 ESCAPE '\\'
			 ORDER BY CASE WHEN vault = ?2 THEN 0 ELSE 1 END, extracted DESC, created DESC
			 LIMIT ?3`,
		)
		.all(pattern, root, limit) as DesignRow[];
}

/** Join recall hits back to their designs. The note path is the only shared key. */
export function designsByNotePath(paths: string[]): Map<string, DesignRow> {
	const found = new Map<string, DesignRow>();
	if (paths.length === 0) return found;
	const { db } = openBrainDb();
	const holes = paths.map(() => "?").join(", ");
	const rows = db
		.query(`SELECT * FROM designs WHERE note_path IN (${holes})`)
		.all(...paths) as DesignRow[];
	for (const row of rows) found.set(row.note_path, row);
	return found;
}

export interface ForgetPlan {
	id: string;
	/** Absolute blob paths that would be, or were, unlinked. */
	removes: string[];
	/** Left alone on purpose, each with the reason. */
	keeps: string[];
	/** The note is moved, never deleted — and only when asked. */
	noteMove: { from: string; to: string } | null;
	applied: boolean;
}

/**
 * Free the bytes. Dry run unless `confirm`, and the vault note is never unlinked: the
 * note is the user's, written into their own vault, and forgetting an upload is not a
 * licence to delete their writing.
 *
 * `trashNote` at most *moves* the note into the vault's local trash, suffixing on
 * collision — overwriting a previously trashed note of the same name would be a real
 * deletion of user content in the one path advertised as non-destructive.
 */
export function forgetDesign(
	id: string,
	options: { confirm?: boolean; trashNote?: boolean } = {},
): ForgetPlan | null {
	const row = getDesign(id);
	if (!row) return null;

	const removes = [imagePath(row)];
	if (row.thumb) removes.push(thumbPath(id));
	if (row.render) removes.push(renderPath(id));

	const root = vaultRoot();
	const keeps: string[] = [];
	// The vault-side image is claude-brain's own copy, named by content hash and written by
	// the note writer — not user writing. It goes with the bytes, and it has to be listed
	// either way or the dry run understates what forgetting actually leaves behind.
	if (root) removes.push(...vaultImageCopies(root, id));
	let noteMove: ForgetPlan["noteMove"] = null;
	if (row.note_path && root) {
		const from = join(root, row.note_path);
		if (options.trashNote) noteMove = { from, to: freeFileName(join(root, ".trash", basename(row.note_path))) };
		else keeps.push(`${row.note_path} — your note stays in the vault`);
	}

	if (!options.confirm) {
		return { id, removes: removes.filter(existsSync), keeps, noteMove, applied: false };
	}

	// The row goes first. Anything after it is best-effort cleanup, and a row that outlives
	// its bytes is the one outcome with no way back: the grid shows a tile whose image 404s
	// and whose second forget reports an empty plan.
	openBrainDb().db.query("DELETE FROM designs WHERE id = ?").run(id);

	const removed: string[] = [];
	for (const path of removes) {
		try {
			unlinkSync(path);
			removed.push(path);
		} catch {
			/* already gone — the row going away is what matters */
		}
	}
	if (noteMove) {
		try {
			// Inside the try with the rename: on a read-only remount this throws EROFS, and
			// the documented outcome for a trash move that cannot happen is "left in place",
			// not an exception out of a function that has already deleted the bytes.
			mkdirSync(dirname(noteMove.to), { recursive: true });
			renameSync(noteMove.from, noteMove.to);
		} catch {
			// The note is the one thing we refuse to lose. A failed move leaves it exactly
			// where it was and is reported as such.
			keeps.push(`${row.note_path} — could not be moved to trash, left in place`);
			noteMove = null;
		}
	}
	return { id, removes: removed, keeps, noteMove, applied: true };
}

/**
 * ` (2)`, ` (3)`, … before the extension, until nothing is in the way. Shared with the
 * note writer: both paths exist so that claude-brain never writes over a file it did not
 * create, and the rule has to be the same in both or the guarantee is only half true.
 */
export function freeFileName(path: string): string {
	if (!existsSync(path)) return path;
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const stem = dot > slash ? path.slice(0, dot) : path;
	const ext = dot > slash ? path.slice(dot) : "";
	for (let n = 2; n < 1000; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!existsSync(candidate)) return candidate;
	}
	return `${stem} (${Date.now()})${ext}`;
}
