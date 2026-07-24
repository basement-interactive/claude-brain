// The background pass that turns a stored image into a description the brain can recall.
//
// Two properties this file exists to guarantee:
//
//  1. An upload returns immediately. A vision call takes tens of seconds and costs money;
//     making the user wait on it would make dropping twelve screenshots feel broken.
//  2. The queue survives a restart. Every retry deadline lives in `designs.next_attempt_at`
//     rather than only in a live timer, and `extracting` is a lease another process may
//     reclaim once it has expired — without that, a restart two minutes into a batch
//     strands one row mid-flight and the rest queued forever, with a dashboard polling a
//     state that never terminates. One unref'd wake timer reads those deadlines back, so a
//     row that says "this retries shortly" is telling the truth.
//
// When the `claude` CLI is absent, or LLM features are off, nothing here fails silently:
// the image is still stored and listed, the row carries the honest reason, and turning the
// feature on later drains the backlog.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { status as claudeStatus, describeImageJson, sessionSpendUsd, spendTodayUsd } from "./claude-cli";
import { loadConfig, vaultReady, vaultRoot } from "./config";
import { type DesignSpec, normalizeSpec, writeDesignNote } from "./design-note";
import { type DesignRow, getDesign, imagePath, renderPath, updateDesign } from "./design-store";
import { imageMeta } from "./image-meta";
import { openBrainDb } from "./index-db";

/**
 * Mirrors the local refusal inside claude-cli's describeImageJson. Duplicated on purpose:
 * that function answers null for every reason at once, and a row that says "too large,
 * downscale it in the dashboard" is worth far more to the user than a bare failure.
 */
const VISION_MAX_BYTES = 4 * 1024 * 1024;
const VISION_MAX_EDGE = 2000;

const MAX_ATTEMPTS = 3;
/** Indexed by attempt number: a transient failure retries soon, a stubborn one much later. */
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 4 * 60 * 60_000];
/**
 * How long a row may sit in `extracting` before another process may take it back. The
 * vision call's own timeout is 150 s, so anything past that plus slack is genuinely dead.
 */
const EXTRACTING_LEASE_MS = 180_000;
/** Ceiling on the wake timer, and the idle poll rate when nothing has a deadline yet. */
const IDLE_POLL_MS = 5 * 60_000;
/** Floor on the wake timer, so a row already past its deadline cannot spin the queue. */
const MIN_WAKE_MS = 15_000;
/** How many free, never-billed stalls one design may take before it counts as a failure. */
const MAX_STALLS = 5;
/** One large image is ~$0.016; this leaves headroom for a verbose reply without leaving
 *  room for a runaway. */
const MAX_COST_PER_IMAGE_USD = 0.08;

const stringList = (description: string) => ({
	type: "array",
	description,
	maxItems: 8,
	items: { type: "string" },
});

/**
 * Enforced by the CLI's own `--json-schema`, so a caller gets a conforming object or null.
 *
 * `viewed` is not decoration. Given a path it cannot open, the model does not error — it
 * returns a plausible description, or a polite "could you resize it", with is_error false.
 * describeImageJson refuses anything whose `viewed` is not literally true, which is why
 * this property is required here.
 */
const DESIGN_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: [
		"viewed",
		"name",
		"vibe",
		"mood",
		"layout",
		"spacing",
		"palette",
		"typography",
		"shape",
		"motion",
		"signature",
		"avoid",
		"recreate",
	],
	properties: {
		viewed: {
			type: "boolean",
			description: "True only if you actually opened and looked at the image file. Never guess.",
		},
		name: { type: "string", description: "Short memorable name for this design, 2-5 words." },
		vibe: { type: "string", description: "One sentence: what it feels like to look at." },
		mood: stringList("Single adjectives: dark, editorial, playful, brutalist, calm."),
		layout: stringList("Grid, columns, density, alignment, hierarchy, notable structure."),
		spacing: stringList("The spacing scale in px or rem, and where each step is used."),
		palette: {
			type: "array",
			maxItems: 10,
			description: "Every colour that matters, sampled from the image.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["hex", "role", "note"],
				properties: {
					hex: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
					role: { type: "string", description: "page background, body text, accent, border, …" },
					note: { type: "string", description: "Where and how it is used." },
				},
			},
		},
		typography: stringList("Typeface character, sizes, weights, line height, tracking, case."),
		shape: stringList("Corner radii in px, border widths and colours, shadow values."),
		motion: stringList("Implied transitions, durations, easing, hover treatment."),
		signature: stringList("The two or three moves that make it recognisably itself."),
		avoid: stringList("What would break the look if someone added it."),
		recreate: stringList("Ordered steps to rebuild this look in HTML and CSS."),
	},
};

const INSTRUCTION = [
	"Describe this UI design precisely enough that another developer could rebuild it without seeing it.",
	"Sample real hex values off the pixels; never approximate or invent brand colours.",
	"Measure radii, spacing and type sizes against the image rather than quoting conventions.",
	"If the image is a greyscale wireframe with no palette, return an empty palette rather than inventing one.",
].join(" ");

// -------------------------------------------------------------------- the queue

const waiting: string[] = [];
const enqueued = new Set<string>();
let draining = false;

/**
 * Concurrency is 1, and that is the point. A drag-drop of twelve files must not fork
 * twelve `claude` processes — claude-cli serializes across processes anyway, so a fan-out
 * would only convert parallelism into lock contention and a stack of billed timeouts.
 */
export function enqueueDesign(id: string): void {
	// Hook processes are killed at 8-20 s and never own a background queue; letting one
	// start a 150 s vision call just burns an attempt on a row it cannot finish.
	if (process.env.CLAUDE_BRAIN_HOOK === "1") return;
	if (enqueued.has(id)) return;
	enqueued.add(id);
	waiting.push(id);
	void drain();
}

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		for (;;) {
			const id = waiting.shift();
			if (!id) return;
			try {
				await extractDesign(id);
			} catch (err) {
				// A throw here used to escape the loop, leaving every still-queued id marked
				// enqueued with no drain running — and sweep() only re-enters through
				// enqueueDesign, which early-returns for exactly those ids. The queue stayed
				// stalled until an unrelated upload restarted it.
				console.warn(`[designs] extraction failed for ${id}: ${err}`);
			} finally {
				// Released only once the work is done. Freed at the head of a ~60 s call, the
				// id is free for a second click to queue behind itself — and the second run
				// is a second billed vision call for a description that already exists.
				enqueued.delete(id);
			}
		}
	} finally {
		draining = false;
	}
}

// ------------------------------------------------------------------- the retry clock

/**
 * `next_attempt_at` is only a retry ladder if something wakes up to read it. One unref'd
 * timer, re-armed by every pass, is the whole mechanism: the daemon works its own backlog
 * down with no integration point to forget, and a short-lived CLI process exits without
 * waiting for it. Hooks never arm it — they are killed in seconds and own no queue.
 */
let wake: ReturnType<typeof setTimeout> | null = null;

function armWake(now: number): void {
	if (process.env.CLAUDE_BRAIN_HOOK === "1") return;
	if (wake) clearTimeout(wake);
	const delay = Math.min(Math.max(nextDeadline(now) - now, MIN_WAKE_MS), IDLE_POLL_MS);
	wake = setTimeout(() => {
		wake = null;
		sweep(Date.now(), false);
	}, delay);
	wake.unref?.();
}

/**
 * Earliest moment a row will want looking at that it does not want already; Infinity when
 * there is none, which is what leaves the timer at its idle rate.
 *
 * Deadlines already in the past are excluded on purpose: the pass that just ran has queued
 * those, and letting one pin the timer at its floor would turn the clock into a spin.
 */
function nextDeadline(now: number): number {
	const { db } = openBrainDb();
	const row = db
		.query(
			`SELECT MIN(next_attempt_at) AS at FROM designs
			 WHERE next_attempt_at > ?1
			   AND (status IN ('queued', 'extracting') OR (status = 'failed' AND attempts < ?2))`,
		)
		.get(now, MAX_ATTEMPTS) as { at: number | null } | null;
	return row?.at ?? Number.POSITIVE_INFINITY;
}

/**
 * One pass over the table. `includeIdle` is the difference between "something changed"
 * (boot, a vault switch, the LLM toggle — take another look at everything, including the
 * rows parked because the feature was off) and the timer's own tick, which only picks up
 * rows whose deadline has come round. Nothing about a `disabled` row changes on a timer,
 * and re-deciding it every five minutes is a write per row per tick for no new information.
 */
function sweep(now: number, includeIdle: boolean): number {
	const { db } = openBrainDb();
	// `extracting` is a lease held by whichever process is making the call, not a state only
	// a crash can leave behind — claude-brain runs as the daemon, the CLI and one process
	// per hook fire at once. Only an expired lease is ours to take.
	db.query("UPDATE designs SET status = 'queued' WHERE status = 'extracting' AND next_attempt_at <= ?").run(now);
	const rows = db
		.query(
			`SELECT id FROM designs
			 WHERE next_attempt_at <= ?1
			   AND (status = 'queued'
			        OR (status = 'failed' AND attempts < ?2)
			        OR (?3 = 1 AND status IN ('unavailable', 'disabled')))`,
		)
		.all(now, MAX_ATTEMPTS, includeIdle ? 1 : 0) as Array<{ id: string }>;
	for (const row of rows) enqueueDesign(row.id);
	// Restart the loop directly: enqueueDesign is a no-op for an id still marked enqueued,
	// so a queue stalled by an earlier crash would never resume through it alone.
	void drain();
	armWake(now);
	return rows.length;
}

// -------------------------------------------------------------------- extraction

/**
 * Which file the model should read, or the sentence explaining why none of them will do.
 *
 * Every rejection here is one describeImageJson would also make, but silently and as a
 * bare null. Deciding it locally is what lets the row say "open the Designs tab to
 * downscale it" — an instruction the user can act on — instead of "failed".
 *
 * `fixable` is what separates the two kinds of rejection. `needs-render` is a promise that
 * a downscaled copy from the browser will unblock this row, and it is excluded from the
 * resume pass on the strength of that promise; a missing or truncated blob is not something
 * the browser can repair, so parking it there would be a dead end wearing an action button.
 */
async function visionSource(row: DesignRow): Promise<{ path: string } | { blocked: string; fixable: boolean }> {
	const preferred = row.render ? renderPath(row.id) : imagePath(row);
	// A render can be deleted out from under us; the original is still worth trying.
	const path = Bun.file(preferred).size > 0 ? preferred : imagePath(row);
	const file = Bun.file(path);
	if (file.size === 0) return { blocked: "the stored image is missing — upload it again", fixable: false };
	if (file.size > VISION_MAX_BYTES) {
		return { blocked: "too large to send as-is — open the Designs tab to downscale it", fixable: true };
	}

	const meta = imageMeta(new Uint8Array(await file.arrayBuffer()));
	// No parseable header (AVIF) means we cannot vouch for it, and neither can the caller
	// we would hand it to — so it would fail there for a reason the user could not see.
	if (!meta) {
		return { blocked: "this file's dimensions cannot be read — re-save it from the Designs tab", fixable: true };
	}
	if (!meta.complete) return { blocked: "the stored copy is truncated — upload it again", fixable: false };
	if (meta.width > VISION_MAX_EDGE || meta.height > VISION_MAX_EDGE) {
		return { blocked: "too many pixels to send as-is — open the Designs tab to downscale it", fixable: true };
	}
	return { path };
}

function fail(row: DesignRow, error: string): void {
	const attempts = row.attempts + 1;
	stalls.delete(row.id);
	updateDesign(row.id, {
		status: "failed",
		attempts,
		error,
		// Past the last attempt the deadline is meaningless — only an explicit retry moves it.
		nextAttemptAt: attempts <= BACKOFF_MS.length ? Date.now() + BACKOFF_MS[attempts - 1]! : 0,
	});
	armWake(Date.now());
}

/**
 * Calls that never reached the API, per design, this process only.
 *
 * A `busy` outcome — another claude-brain process holding the cross-process CLI lock —
 * costs nothing and says nothing about this design, so it must not cost one of its three
 * attempts either. Bounded all the same: a `claude` binary that exits instantly also bills
 * nothing, and without a ceiling a broken install would re-queue forever.
 */
const stalls = new Map<string, number>();

function stalled(id: string): boolean {
	const count = (stalls.get(id) ?? 0) + 1;
	stalls.set(id, count);
	return count <= MAX_STALLS;
}

/**
 * Describe one design and file its note. Never throws for an expected outcome: every
 * dead end lands in the row as a status plus a sentence the dashboard can show verbatim.
 */
export async function extractDesign(id: string): Promise<void> {
	const row = getDesign(id);
	if (!row) return;
	if (row.attempts >= MAX_ATTEMPTS && row.status === "failed") return;
	// Already described, and a description is a paid thing. Every caller that means "do this
	// again" — retryExtraction, a re-upload of a dead-ended design — resets the status first,
	// so this only ever catches the duplicate: a second Retry click, or a resume pass racing
	// a call that has just landed.
	if (row.status === "described" || row.status === "thin") return;

	const cfg = loadConfig();
	if (!cfg.llm.enabled) {
		updateDesign(id, { status: "disabled", error: "LLM features are off — enable them in Settings to describe this" });
		return;
	}

	const source = await visionSource(row);
	if ("blocked" in source) {
		if (source.fixable) updateDesign(id, { status: "needs-render", error: source.blocked });
		else fail(row, source.blocked);
		return;
	}

	// The status doubles as a lease: another process may only reclaim this row once the
	// deadline has passed, so a `design add` in a terminal cannot flip the daemon's paid
	// call back to `queued` and pay for the same description twice.
	updateDesign(id, { status: "extracting", error: "", nextAttemptAt: Date.now() + EXTRACTING_LEASE_MS });
	const spentBefore = sessionSpendUsd();
	const described = await describeImageJson<{ viewed: boolean }>(source.path, INSTRUCTION, DESIGN_SCHEMA, {
		model: cfg.llm.model,
		maxCostUsd: MAX_COST_PER_IMAGE_USD,
		label: `design:${id}`,
	});

	if (!described) {
		const st = await claudeStatus();
		if (!st.available) {
			updateDesign(id, {
				status: "unavailable",
				error: `the claude CLI is ${st.reason.replace(/-/g, " ")} — this will describe itself once that is fixed`,
			});
			return;
		}
		// A day's budget running out is not this design's fault, and spending its three
		// attempts on it would leave a whole batch permanently failed over a spending cap.
		if (spendTodayUsd() >= cfg.llm.dailyBudgetUsd) {
			updateDesign(id, {
				status: "queued",
				nextAttemptAt: new Date().setHours(24, 0, 0, 0),
				error: "today's LLM budget is spent — this picks up again tomorrow",
			});
			armWake(Date.now());
			return;
		}
		// Session spend is per-process and only moves when a `claude` child actually ran, so
		// an unchanged reading means this call never left the machine: another claude-brain
		// process held the CLI lock, or the call was aborted. Nothing was billed and nothing
		// was learned about this design, so nothing is charged to its attempts either.
		if (sessionSpendUsd() === spentBefore && stalled(id)) {
			updateDesign(id, {
				status: "queued",
				nextAttemptAt: Date.now() + BACKOFF_MS[0]!,
				error: "another claude-brain job had the claude CLI — this retries shortly",
			});
			armWake(Date.now());
			return;
		}
		fail(row, "the vision call did not come back with a usable description");
		return;
	}

	const parsed = normalizeSpec(described);
	if (!parsed) {
		fail(row, "the reply had no design in it");
		return;
	}
	store(row, parsed.spec, described, parsed.thin);
}

function store(row: DesignRow, spec: DesignSpec, raw: unknown, thin: boolean): void {
	stalls.delete(row.id);
	updateDesign(row.id, {
		name: spec.name,
		spec: JSON.stringify(raw),
		palette: JSON.stringify(spec.palette.map((p) => p.hex)),
		mood: spec.mood.join(", "),
		status: thin ? "thin" : "described",
		extracted: Date.now(),
		attempts: 0,
		error: "",
		nextAttemptAt: 0,
	});
	const written = writeDesignNote(getDesign(row.id)!, spec);
	// The description is stored either way. A note that could not be written is a vault
	// problem, not an extraction problem, and materializePending() will retry it.
	if (!written.ok) updateDesign(row.id, { error: written.detail });
}

// -------------------------------------------------------------------- boot passes

/**
 * Re-arm the queue from the table, including the rows parked because the feature was off.
 * Called on boot, after a vault switch, and whenever the user flips LLM features on — which
 * is what makes that toggle drain the backlog instead of only affecting future uploads.
 * It also starts the wake timer, which from then on runs the narrower deadline-only pass.
 *
 * `needs-render` is excluded: those rows want a downscaled copy from the browser, not
 * another attempt at the same oversized file.
 */
export function resumeExtractions(): number {
	// A hook process is killed in seconds and owns no queue. Reclaiming rows from one would
	// pull the daemon's in-flight, already-paid-for call out from under it for nothing.
	if (process.env.CLAUDE_BRAIN_HOOK === "1") return 0;
	return sweep(Date.now(), true);
}

/**
 * The dashboard has stored a downscaled copy. attachRender has already taken the row out of
 * `needs-render`; this is what saves the user waiting for the next wake for something they
 * just did by hand.
 */
export function renderAttached(id: string): boolean {
	if (getDesign(id)?.status !== "queued") return false;
	enqueueDesign(id);
	return true;
}

/**
 * Write the notes that never got written, and notice the ones that have gone.
 *
 * Only `note_path = ''` is materialised. A path that was written and has since vanished
 * means the user deleted the note in Obsidian; recreating it on every restart, forever,
 * would be the brain overriding a deletion in the user's own vault. It is flagged instead,
 * and `design restore` puts it back on request.
 */
export function materializePending(): { written: number; missing: number } {
	const root = vaultRoot();
	// An unmounted vault makes every note look deleted. Flagging the whole library as
	// missing because a portable disk is unplugged is worse than doing nothing.
	if (!root || !vaultReady()) return { written: 0, missing: 0 };

	const { db } = openBrainDb();
	const rows = db.query("SELECT * FROM designs WHERE spec != ''").all() as DesignRow[];
	let written = 0;
	let missing = 0;
	for (const row of rows) {
		if (row.note_path) {
			// Rows filed into a different vault are not missing, just elsewhere.
			if (row.vault && row.vault !== root) continue;
			if (Bun.file(join(root, row.note_path)).size > 0) {
				if (row.note_missing === 1) updateDesign(row.id, { noteMissing: false });
				continue;
			}
			// Not where we left it is not the same as gone: reorganize moves notes between
			// folders, and treating a moved note as deleted invites `design restore` to write
			// a second copy of a note the user still has, possibly with their edits in it.
			const moved = relocateNote(row, root);
			if (moved) {
				updateDesign(row.id, { notePath: moved, noteMissing: false });
				continue;
			}
			if (row.note_missing !== 1) updateDesign(row.id, { noteMissing: true });
			missing++;
			continue;
		}
		const parsed = normalizeSpec(safeParse(row.spec));
		if (!parsed) continue;
		if (writeDesignNote(row, parsed.spec).ok) written++;
	}
	return { written, missing };
}

/**
 * Find a design note that moved rather than one that went.
 *
 * `reorganize --apply` files notes into folders of its own choosing and does not treat the
 * design folder as frozen, so "not at its recorded path" is far more often "moved" than
 * "deleted". Getting that wrong is not a cosmetic error: the dashboard offers to restore a
 * note that is flagged missing, and restoring one that still exists elsewhere leaves the
 * user with two copies of a note they may have edited, both of which recall then ranks.
 *
 * The match must be unambiguous — same filename *and* the `brain-design:` stamp the note
 * writer puts in its own frontmatter. Anything less certain is left flagged.
 */
function relocateNote(row: DesignRow, root: string): string | null {
	const { db } = openBrainDb();
	const name = row.note_path.slice(row.note_path.lastIndexOf("/") + 1);
	const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
	const candidates = db
		.query("SELECT path FROM docs WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")
		.all(name, `%/${escaped}`) as Array<{ path: string }>;

	const stamp = `brain-design: ${row.id}`;
	const matches = candidates
		.map((c) => c.path)
		.filter((path) => path !== row.note_path && frontmatterOf(join(root, path)).includes(stamp));
	return matches.length === 1 ? matches[0]! : null;
}

/** Enough of a note to hold its frontmatter. Notes are small; the slice is the point. */
function frontmatterOf(path: string): string {
	try {
		return readFileSync(path, "utf-8").slice(0, 500);
	} catch {
		return "";
	}
}

/** Put back a note the user deleted — on request, never automatically. */
export function restoreDesignNote(id: string): { ok: boolean; detail: string } {
	const row = getDesign(id);
	if (!row) return { ok: false, detail: "no such design" };
	const parsed = normalizeSpec(safeParse(row.spec));
	if (!parsed) return { ok: false, detail: "this design has no stored description to restore from" };

	// Writing a second copy of a note that still exists somewhere else in the vault is the
	// one mistake this button is a click away from, so look for it before writing anything.
	const root = vaultRoot();
	if (root && row.note_path) {
		const moved = relocateNote(row, root);
		if (moved) {
			updateDesign(id, { notePath: moved, noteMissing: false });
			return { ok: true, detail: moved };
		}
	}

	// Clearing the path first is what lets writeDesignNote pick a fresh filename rather
	// than short-circuiting on the recorded one.
	updateDesign(id, { notePath: "", noteMissing: false });
	const written = writeDesignNote(getDesign(id)!, parsed.spec);
	if (!written.ok) {
		updateDesign(id, { notePath: row.note_path, noteMissing: true });
		return { ok: false, detail: written.detail };
	}
	return { ok: true, detail: written.path };
}

/** Clear the failure state and put the design back in line. */
export function retryExtraction(id: string): boolean {
	const row = getDesign(id);
	if (!row) return false;
	// A live lease means some process is describing this right now, which is what the button
	// asks for; taking it back would only buy a second billed call for the same answer.
	if (row.status === "extracting" && row.next_attempt_at > Date.now()) return true;
	updateDesign(id, { status: "queued", attempts: 0, nextAttemptAt: 0, error: "" });
	enqueueDesign(id);
	return true;
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
