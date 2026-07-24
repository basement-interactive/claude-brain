// Turning an inventory into a plan file, and reading one back.
//
// Two model calls' worth of judgement (what folders should exist, what goes where) wrapped
// in machinery whose only job is to make the model's mistakes cheap: a closed folder
// vocabulary validated twice, KEEP as the default verdict, and a fail-closed parse where
// anything unrecognised means "leave this note alone". The failure mode of the only
// non-deterministic component in the feature is always zero moves, never a wrong move.
//
// plan.md is both the human interface and the machine format. There is no second, "real"
// file behind it: the user's edits to the checkboxes are what apply obeys, which is only
// true if apply reads exactly the file the user read.
//
// This module also owns the run directory layout, including the shape of the apply
// journal and the read-only scan over past journals that the churn filter needs.
// reorganize-apply.ts writes those journals; it does not get to decide where they live.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, STATE_DIR, loadConfig, safeVaultFolder } from "./config";
import { type ClaudeModel, askJson, isAvailable, sessionSpendUsd, spendTodayUsd } from "./claude-cli";
import type { Inventory, InventoryNote } from "./reorganize-inventory";
import { calendarShapedFolder, underAnyFolder, vaultNotePath } from "./vault-links";

export const RUNS_DIR = join(STATE_DIR, "reorganize");
const DECISIONS_PATH = join(CACHE_DIR, "reorganize-decisions.json");

export const DEFAULT_BATCH = 60;
export const DEFAULT_FOLDERS = 12;
/** Titles shown to the taxonomy call. More does not buy a better folder set; it buys tokens. */
const TAXONOMY_SAMPLE = 300;
const KEEP = "KEEP";
/** Two moves of the same note inside this window is churn, not organisation. */
const CHURN_DAYS = 30;
const MAX_CACHED_DECISIONS = 20_000;

// Rough token accounting for the pre-flight estimate only. The number that goes into
// plan.md is the actual spend summed from the CLI's own envelopes; these constants exist
// so the user can answer y/N to a real figure instead of an unpriced "this will call an
// LLM 85 times". Measured floor of one --safe-mode call, from claude-cli.ts.
const CALL_OVERHEAD_TOKENS = 3459;
const TOKENS_PER_NOTE_LINE = 45;
const TOKENS_PER_SAMPLE_TITLE = 12;
const TOKENS_PER_ASSIGNMENT_OUT = 12;
const TAXONOMY_OUTPUT_TOKENS = 400;
/** USD per million tokens, list price at release. Only ever used for the estimate. */
const PRICE_PER_MTOK: Record<ClaudeModel, { input: number; output: number }> = {
	haiku: { input: 1, output: 5 },
	sonnet: { input: 3, output: 15 },
	opus: { input: 5, output: 25 },
};

export interface TaxonomyFolder {
	folder: string;
	description: string;
}

export interface Taxonomy {
	folders: TaxonomyFolder[];
	/** Part of the decision cache key: a different folder set is a different question. */
	hash: string;
}

export interface PlanOptions {
	batch?: number;
	folders?: number;
	model?: ClaudeModel;
	/** Hand-edited taxonomy.json, which skips the proposal call entirely. */
	taxonomyFile?: string;
	allowChurn?: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface PlanMove {
	id: number;
	from: string;
	/** Destination folder, never a filename — a rename is not representable here. */
	to: string;
	selected: boolean;
}

export interface ReorganizePlan {
	runId: string;
	createdAt: string;
	vault: string;
	model: string;
	scope: string | null;
	considered: number;
	truncated: number;
	costUsd: number;
	/** Batches the model never answered — a refusal, an exhausted budget, a busy CLI. */
	unansweredBatches: number;
	/** Notes in those batches. Without this, `considered` claims a coverage the run did
	 *  not have and the user approves a plan believing the whole vault was looked at. */
	unseen: number;
	taxonomy: Taxonomy;
	moves: PlanMove[];
	frozen: Array<{ path: string; reason: string }>;
}

export type PlanProblem = "llm-unavailable" | "taxonomy" | "aborted";

export type PlanResult =
	| { ok: true; plan: ReorganizePlan; planPath: string; runDir: string }
	| { ok: false; problem: PlanProblem; message: string };

/** A run id is a timestamp and nothing else. Enforced rather than assumed because it is
 *  the only thing between `- run: ` in a plan file and a `join()` that builds a path we
 *  then mkdir and append to. */
const RUN_ID_RE = /^\d{8}-\d{6}$/;

export function isRunId(value: string): boolean {
	return RUN_ID_RE.test(value);
}

/** Throws rather than sanitising: every caller either has an id we minted or one that has
 *  already been through {@link isRunId}, so reaching here with anything else is a bug. */
export function runDir(runId: string): string {
	if (!isRunId(runId)) throw new Error(`not a run id: ${runId}`);
	return join(RUNS_DIR, runId);
}

/** Newest first. The id is a timestamp, so lexical order is chronological order. */
export function runIds(): string[] {
	try {
		return readdirSync(RUNS_DIR).filter(isRunId).sort().reverse();
	} catch {
		return [];
	}
}

export function newRunId(): string {
	const iso = new Date().toISOString();
	return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

// ---------------------------------------------------------------- apply journal

/**
 * Write-ahead journal records, appended by reorganize-apply.ts. Two records per move,
 * because `afterHash` cannot be known before the write: one record could be write-ahead
 * or verifiable, not both.
 */
export type JournalRecord =
	| { kind: "move"; ts: number; from: string; to: string; beforeHash: string }
	| { kind: "move-done"; ts: number; to: string; afterHash: string }
	| { kind: "undone"; ts: number };

export const JOURNAL_NAME = "applied.jsonl";
/** A successful undo renames the journal, which is also what makes apply → undo → re-plan
 *  possible: an undone run is not a run whose moves still count. */
export const UNDONE_JOURNAL_NAME = "applied.undone.jsonl";

export function journalPath(runId: string, undone = false): string {
	return join(runDir(runId), undone ? UNDONE_JOURNAL_NAME : JOURNAL_NAME);
}

export function readJournal(runId: string, undone = false): JournalRecord[] {
	let raw: string;
	try {
		raw = readFileSync(journalPath(runId, undone), "utf-8");
	} catch {
		return [];
	}
	const records: JournalRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as JournalRecord);
		} catch {
			// A torn last line means the process died mid-append; everything before it is
			// still a true account of what happened.
		}
	}
	return records;
}

/**
 * Paths moved by a run that has not been undone, within the window. Undone runs are
 * skipped entirely — they are stored under a different filename — so undoing a run does
 * not leave its notes untouchable for a month with no way for the user to find out why.
 */
export function recentlyMovedPaths(days = CHURN_DAYS): Set<string> {
	const since = Date.now() - days * 86_400_000;
	const paths = new Set<string>();
	for (const runId of runIds()) {
		for (const record of readJournal(runId)) {
			if (record.kind !== "move" || record.ts < since) continue;
			paths.add(record.from);
			paths.add(record.to);
		}
	}
	return paths;
}

// ---------------------------------------------------------------- prompts

function noteLine(note: InventoryNote): string {
	const parts = [
		String(note.id),
		note.folder || "(vault root)",
		note.title,
		note.tags.join(","),
		note.headings.join("; "),
		note.lead,
	];
	return parts.join(" | ");
}

/** Titles spread across folders rather than the first N in path order, so the taxonomy
 *  call sees the whole vault instead of whatever sorts first. */
function stratifiedTitles(notes: InventoryNote[], limit: number): string[] {
	const byFolder = new Map<string, InventoryNote[]>();
	for (const note of notes) {
		const list = byFolder.get(note.folder) ?? [];
		list.push(note);
		byFolder.set(note.folder, list);
	}
	const buckets = [...byFolder.values()];
	const titles: string[] = [];
	for (let round = 0; titles.length < limit; round++) {
		let added = false;
		for (const bucket of buckets) {
			const note = bucket[round];
			if (!note) continue;
			titles.push(note.title);
			added = true;
			if (titles.length >= limit) break;
		}
		if (!added) break;
	}
	return titles;
}

export function taxonomyPrompt(inv: Inventory, maxFolders: number): string {
	const folders = inv.folders.map((f) => `  ${f.folder} (${f.notes})`).join("\n");
	const tags = inv.topTags.map((t) => `${t.tag} (${t.count})`).join(", ");
	const clusters = inv.communities.map((c) => `${c.label} (${c.size})`).join(", ");
	const titles = stratifiedTitles(inv.notes, TAXONOMY_SAMPLE)
		.map((t) => `  - ${t}`)
		.join("\n");

	return `You are choosing the folder structure for someone else's notes vault.

Folders that already exist, with note counts:
${folders || "  (none — every note is in the vault root)"}

Frequent tags: ${tags || "(none)"}
Existing clusters: ${clusters || "(none)"}

A sample of note titles from across the vault:
${titles}

Propose at most ${maxFolders} folders that these notes should be filed into.

Rules:
- Reuse an existing folder name EXACTLY, character for character, whenever it fits. Most of the answer should be existing folders.
- At most two levels, e.g. "00 Notes/Bible". Never deeper.
- Folder names may contain letters, digits, spaces, dash, underscore and dot only, and must start with a letter or digit.
- Never propose a folder for journals, dailies, dates, years, attachments, images or trash.
- Prefer few broad folders over many narrow ones. A folder that would hold two notes should not exist.
- Each description is one short line saying what belongs there, written for the vault's owner.

Answer with JSON only.`;
}

export function assignPrompt(batch: InventoryNote[], taxonomy: Taxonomy, scope: string | null): string {
	const folders = taxonomy.folders.map((f) => `  ${f.folder} — ${f.description}`).join("\n");
	const scopeNote = scope
		? `\nOnly notes from "${scope}" are listed, but the folders above are the whole vault's, so a note may belong somewhere that is not under "${scope}".\n`
		: "";
	return `You are filing notes into an existing folder structure.

Folders:
${folders}
${scopeNote}
Rules:
- Answer with exactly one entry per note id below — no extras, no omissions.
- "folder" must be one of the folder names above, copied exactly, or "${KEEP}".
- Use "${KEEP}" when the note is already somewhere reasonable, when it fits two folders equally well, or when you are unsure. ${KEEP} is the expected answer for most notes.
- Judge by what the note is about, not by where it currently sits.

Notes, one per line, as: id | current folder | title | tags | headings | opening
${batch.map(noteLine).join("\n")}

Answer with JSON only.`;
}

/** What `--dry-prompt` prints: the real phase-1 prompt, and a phase-2 prompt built against
 *  the vault's existing folders since the proposed ones do not exist until it is paid for. */
export function previewPrompts(inv: Inventory, opts: PlanOptions = {}): string[] {
	const standIn: Taxonomy = {
		folders: inv.folders.slice(0, opts.folders ?? DEFAULT_FOLDERS).map((f) => ({
			folder: f.folder,
			description: "(existing folder — the real prompt uses the proposed taxonomy)",
		})),
		hash: "preview",
	};
	const batch = inv.notes.slice(0, opts.batch ?? DEFAULT_BATCH);
	return [taxonomyPrompt(inv, opts.folders ?? DEFAULT_FOLDERS), assignPrompt(batch, standIn, inv.scope)];
}

// ---------------------------------------------------------------- cost

export interface CostEstimate {
	notes: number;
	calls: number;
	tokens: number;
	model: ClaudeModel;
	usd: number;
	/** What is left of today's budget across every claude-brain process. */
	remainingUsd: number;
	/** False when the run will run dry partway through. The batches after that point
	 *  return nothing, and a plan built from half a vault looks exactly like a whole one. */
	fitsBudget: boolean;
}

/** Upper bound: cached decisions and KEEP-heavy batches only ever make it cheaper. */
export function estimateCost(inv: Inventory, opts: PlanOptions = {}): CostEstimate {
	const model = opts.model ?? loadConfig().llm.model;
	const batchSize = opts.batch ?? DEFAULT_BATCH;
	const notes = inv.notes.length;
	const assignCalls = Math.ceil(notes / batchSize);
	const calls = (opts.taxonomyFile ? 0 : 1) + assignCalls;

	const taxonomyInput = opts.taxonomyFile
		? 0
		: Math.min(notes, TAXONOMY_SAMPLE) * TOKENS_PER_SAMPLE_TITLE + inv.folders.length * 8 + 400;
	const inputTokens = calls * CALL_OVERHEAD_TOKENS + taxonomyInput + notes * TOKENS_PER_NOTE_LINE;
	const outputTokens = (opts.taxonomyFile ? 0 : TAXONOMY_OUTPUT_TOKENS) + notes * TOKENS_PER_ASSIGNMENT_OUT;

	const price = PRICE_PER_MTOK[model];
	const usd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
	const remainingUsd = Math.max(0, loadConfig().llm.dailyBudgetUsd - spendTodayUsd());
	return { notes, calls, tokens: inputTokens + outputTokens, model, usd, remainingUsd, fitsBudget: usd <= remainingUsd };
}

// ---------------------------------------------------------------- taxonomy

const TAXONOMY_SCHEMA = {
	type: "object",
	properties: {
		folders: {
			type: "array",
			items: {
				type: "object",
				properties: { folder: { type: "string" }, description: { type: "string" } },
				required: ["folder", "description"],
				additionalProperties: false,
			},
		},
	},
	required: ["folders"],
	additionalProperties: false,
};

/**
 * Every proposed folder must survive safeVaultFolder() — this is what stops a note being
 * filed into `Trash` or `.obsidian/notes`, where it vanishes from the index while the file
 * still exists — plus a case-insensitive collision check against the vault's real folders.
 * A folder that differs from an existing one only in case is two folders here and one
 * folder on the case-insensitive filesystem this vault probably syncs to.
 *
 * Rejected folders drop out of the taxonomy entirely, so every assignment naming one fails
 * closed and those notes simply stay where they are.
 *
 * The description is the model's free text, and it is written verbatim into plan.md — a
 * line-oriented format whose own headings decide what apply obeys. It is flattened to a
 * single line here, at the point it enters our data, rather than trusted to be one.
 */
export function validateTaxonomy(
	proposed: TaxonomyFolder[],
	inv: Inventory,
	maxFolders: number,
): { folders: TaxonomyFolder[]; rejected: string[] } {
	// Every prefix, not only the counted leaves: `Projects/Web` and `Projects/CLI` mean
	// `Projects` exists too, and buildInventory never lists a folder that holds no notes
	// of its own. Proposing `projects` beside it is the case collision this check is for.
	const existing = new Map<string, string>();
	for (const { folder } of inv.folders) {
		const segments = folder.split("/");
		for (let i = 1; i <= segments.length; i++) {
			const prefix = segments.slice(0, i).join("/");
			if (!existing.has(prefix.toLowerCase())) existing.set(prefix.toLowerCase(), prefix);
		}
	}

	const folders: TaxonomyFolder[] = [];
	const rejected: string[] = [];
	const taken = new Set<string>();

	for (const candidate of proposed) {
		if (folders.length >= maxFolders) break;
		const safe = safeVaultFolder(String(candidate.folder ?? ""));
		if (!safe) {
			rejected.push(`${candidate.folder} (not a folder we will write to)`);
			continue;
		}
		const lower = safe.toLowerCase();
		if (taken.has(lower)) continue;
		const collision = existing.get(lower);
		if (collision && collision !== safe) {
			rejected.push(`${safe} (differs from existing "${collision}" only by case)`);
			continue;
		}
		if (underAnyFolder(`${safe}/x.md`, inv.journals)) {
			rejected.push(`${safe} (journal folder)`);
			continue;
		}
		if (calendarShapedFolder(safe)) {
			rejected.push(`${safe} (calendar-shaped folder name)`);
			continue;
		}
		taken.add(lower);
		folders.push({ folder: safe, description: oneLine(String(candidate.description ?? ""), DESCRIPTION_CHARS) });
	}
	return { folders, rejected };
}

function taxonomyHash(folders: TaxonomyFolder[]): string {
	return String(Bun.hash(folders.map((f) => f.folder).join("\n")));
}

function loadTaxonomyFile(path: string, inv: Inventory, maxFolders: number): Taxonomy | null {
	let parsed: { folders?: TaxonomyFolder[] };
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as typeof parsed;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed.folders)) return null;
	const { folders } = validateTaxonomy(parsed.folders, inv, maxFolders);
	return folders.length > 0 ? { folders, hash: taxonomyHash(folders) } : null;
}

// ---------------------------------------------------------------- assignment

const ASSIGNMENT_SCHEMA = (folders: string[]) => ({
	type: "object",
	properties: {
		assignments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "integer" },
					folder: { type: "string", enum: [KEEP, ...folders] },
				},
				required: ["id", "folder"],
				additionalProperties: false,
			},
		},
	},
	required: ["assignments"],
	additionalProperties: false,
});

interface RawAssignment {
	id?: unknown;
	folder?: unknown;
}

/**
 * Fail-closed validation of one batch reply. An unknown id, a repeated id, an id from a
 * different batch, or a folder outside the validated taxonomy all mean "leave this note
 * alone" — never "guess". Notes the model omitted are absent from the result, which is the
 * same thing as KEEP.
 */
export function validateAssignments(
	raw: RawAssignment[] | null | undefined,
	batch: InventoryNote[],
	taxonomy: Taxonomy,
): Map<number, string> {
	const allowed = new Set(taxonomy.folders.map((f) => f.folder));
	const inBatch = new Map(batch.map((note) => [note.id, note]));
	const out = new Map<number, string>();
	const seen = new Set<number>();

	for (const entry of raw ?? []) {
		const id = typeof entry.id === "number" ? entry.id : Number(entry.id);
		if (!Number.isInteger(id) || !inBatch.has(id)) continue;
		if (seen.has(id)) {
			// A repeated id means the model lost track of the list; distrust both answers.
			out.delete(id);
			continue;
		}
		seen.add(id);
		const folder = typeof entry.folder === "string" ? entry.folder.trim() : "";
		if (!folder || folder === KEEP || !allowed.has(folder)) continue;
		out.set(id, folder);
	}
	return out;
}

// ---------------------------------------------------------------- decision cache

type DecisionCache = Record<string, string>;

function decisionKey(note: InventoryNote, taxonomy: Taxonomy): string {
	return `${note.fingerprint}:${taxonomy.hash}`;
}

function loadDecisions(): DecisionCache {
	try {
		return JSON.parse(readFileSync(DECISIONS_PATH, "utf-8")) as DecisionCache;
	} catch {
		return {};
	}
}

function saveDecisions(cache: DecisionCache): void {
	const entries = Object.entries(cache).slice(-MAX_CACHED_DECISIONS);
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(DECISIONS_PATH, `${JSON.stringify(Object.fromEntries(entries))}\n`);
	} catch {
		/* the cache is an optimisation; failing to write it only costs tokens next run */
	}
}

// ---------------------------------------------------------------- plan

export async function createPlan(inv: Inventory, opts: PlanOptions = {}): Promise<PlanResult> {
	const progress = opts.onProgress ?? (() => {});
	// The configured model, never the CLI's own inherited default: a user who set haiku
	// must not have a reorganize billed at whatever their last `claude` session used.
	const model = opts.model ?? loadConfig().llm.model;
	const maxFolders = opts.folders ?? DEFAULT_FOLDERS;
	const batchSize = Math.max(1, opts.batch ?? DEFAULT_BATCH);
	const spendBefore = sessionSpendUsd();

	// A taxonomy file skips phase 1, not phase 2: deciding where each note goes is still a
	// model call. Gating this behind !taxonomyFile produced a zero-move plan with ok:true
	// and no message when llm was off — the one shape this feature must never have.
	if (!(await isAvailable())) {
		return {
			ok: false,
			problem: "llm-unavailable",
			message: opts.taxonomyFile
				? "the claude CLI is not available — a folder list still needs a model to decide what goes in it"
				: "the claude CLI is not available — enable llm in settings, or pass --taxonomy with a folder list",
		};
	}

	const runId = newRunId();
	const dir = runDir(runId);
	mkdirSync(join(dir, "prompts"), { recursive: true });
	mkdirSync(join(dir, "replies"), { recursive: true });

	let taxonomy: Taxonomy | null = null;
	if (opts.taxonomyFile) {
		taxonomy = loadTaxonomyFile(opts.taxonomyFile, inv, maxFolders);
		if (!taxonomy) {
			return { ok: false, problem: "taxonomy", message: `no usable folders in ${opts.taxonomyFile}` };
		}
		progress(`taxonomy: ${taxonomy.folders.length} folders from ${opts.taxonomyFile}`);
	} else {
		const prompt = taxonomyPrompt(inv, maxFolders);
		writeFileSync(join(dir, "prompts", "00-taxonomy.txt"), prompt);
		progress(`proposing folders (1 call, ${model})`);
		const reply = await askJson<{ folders: TaxonomyFolder[] }>(prompt, TAXONOMY_SCHEMA, {
			model,
			label: "reorganize/taxonomy",
			maxCostUsd: 0.1,
			signal: opts.signal,
		});
		writeFileSync(join(dir, "replies", "00-taxonomy.json"), `${JSON.stringify(reply ?? null, null, "\t")}\n`);
		if (!reply?.folders) {
			return { ok: false, problem: "taxonomy", message: "the model returned no usable folder list — nothing planned" };
		}
		const { folders, rejected } = validateTaxonomy(reply.folders, inv, maxFolders);
		for (const bad of rejected) progress(`rejected folder: ${bad}`);
		if (folders.length === 0) {
			return { ok: false, problem: "taxonomy", message: "every proposed folder was rejected — nothing planned" };
		}
		taxonomy = { folders, hash: taxonomyHash(folders) };
	}
	writeFileSync(join(dir, "taxonomy.json"), `${JSON.stringify({ folders: taxonomy.folders }, null, "\t")}\n`);

	const cache = loadDecisions();
	const decided = new Map<number, string>();
	const pending: InventoryNote[] = [];
	for (const note of inv.notes) {
		const cached = cache[decisionKey(note, taxonomy)];
		if (cached === undefined) pending.push(note);
		else if (cached !== KEEP) decided.set(note.id, cached);
	}
	if (pending.length < inv.notes.length) {
		progress(`${inv.notes.length - pending.length} notes answered from cache`);
	}

	// Fixed slices of a path-sorted list: the same note keeps the same neighbours across
	// runs, so its batch context — and therefore the answer — is stable.
	const batches: InventoryNote[][] = [];
	for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));

	let unansweredBatches = 0;
	let unseen = 0;
	for (const [index, batch] of batches.entries()) {
		if (opts.signal?.aborted) return { ok: false, problem: "aborted", message: "cancelled" };
		const label = String(index + 1).padStart(2, "0");
		const prompt = assignPrompt(batch, taxonomy, inv.scope);
		writeFileSync(join(dir, "prompts", `${label}-assign.txt`), prompt);
		progress(`filing notes ${index + 1}/${batches.length}`);

		const reply = await askJson<{ assignments: RawAssignment[] }>(
			prompt,
			ASSIGNMENT_SCHEMA(taxonomy.folders.map((f) => f.folder)),
			{ model, label: `reorganize/assign-${label}`, maxCostUsd: 0.1, signal: opts.signal },
		);
		writeFileSync(join(dir, "replies", `${label}-assign.json`), `${JSON.stringify(reply ?? null, null, "\t")}\n`);
		if (!reply) {
			// Not "those notes stay put" — nobody decided about them. The distinction only
			// survives if it is counted; a progress line scrolls away and plan.md is what
			// the user actually approves. Deliberately not cached: an unanswered batch must
			// be asked again next run, not remembered as a KEEP.
			unansweredBatches++;
			unseen += batch.length;
			progress(`batch ${index + 1} returned nothing — those ${batch.length} notes were never looked at`);
			continue;
		}
		const valid = validateAssignments(reply.assignments, batch, taxonomy);
		for (const note of batch) {
			const folder = valid.get(note.id);
			cache[decisionKey(note, taxonomy)] = folder ?? KEEP;
			if (folder) decided.set(note.id, folder);
		}
	}
	saveDecisions(cache);

	const churned = opts.allowChurn ? new Set<string>() : recentlyMovedPaths();
	const byId = new Map(inv.notes.map((note) => [note.id, note]));
	const moves: PlanMove[] = [];
	for (const [id, folder] of [...decided].sort((a, b) => a[0] - b[0])) {
		const note = byId.get(id);
		if (!note || folder === note.folder) continue;
		if (underAnyFolder(`${folder}/x.md`, inv.journals)) continue;
		if (churned.has(note.path)) {
			progress(`skipping ${note.path} — moved within the last ${CHURN_DAYS} days (--allow-churn overrides)`);
			continue;
		}
		moves.push({ id, from: note.path, to: folder, selected: true });
	}

	const plan: ReorganizePlan = {
		runId,
		createdAt: new Date().toISOString(),
		vault: inv.root,
		model,
		scope: inv.scope,
		considered: inv.notes.length,
		truncated: inv.truncated,
		unansweredBatches,
		unseen,
		costUsd: Math.max(0, sessionSpendUsd() - spendBefore),
		taxonomy,
		moves,
		frozen: inv.frozen,
	};
	const planPath = join(dir, "plan.md");
	writeFileSync(planPath, renderPlan(plan));
	return { ok: true, plan, planPath, runDir: dir };
}

// ---------------------------------------------------------------- plan file I/O

const FROZEN_SHOWN = 200;
const DESCRIPTION_CHARS = 200;

/**
 * plan.md is a line-oriented format whose `##` headings decide what apply obeys, so no
 * value written into it may contain a newline. Two of the values are outside our control:
 * the folder descriptions come from the model, and `scope` comes from the command line.
 * A description carrying `\n## Moves\n- [x] 99 …` is a plan file that shows the user one
 * set of moves and hands apply another.
 */
function oneLine(value: string, max: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function renderPlan(plan: ReorganizePlan): string {
	const lines = [
		"# claude-brain reorganize plan",
		"",
		`- run: ${plan.runId}`,
		`- created: ${oneLine(plan.createdAt, 40)}`,
		`- vault: ${oneLine(plan.vault, 400)}`,
		`- model: ${oneLine(plan.model, 40)}`,
		`- scope: ${plan.scope ? oneLine(plan.scope, 400) : "-"}`,
		`- considered: ${plan.considered}`,
		`- truncated: ${plan.truncated}`,
		`- unanswered: ${plan.unansweredBatches}`,
		`- unseen: ${plan.unseen}`,
		`- cost: ${plan.costUsd.toFixed(4)}`,
		"",
		"Nothing has moved yet. Untick anything you disagree with, save the file, then run:",
		"",
		`    claude-brain reorganize --apply --plan ${plan.runId}`,
		"",
		"Only .md files move, and only between folders — nothing is renamed, merged or deleted.",
		"",
	];
	if (plan.unansweredBatches > 0) {
		lines.push(
			`**${plan.unseen} of the ${plan.considered} notes were never looked at.** ${plan.unansweredBatches} model` +
				" calls returned nothing — an exhausted daily budget, another claude-brain process holding the CLI, or a" +
				" refusal. Those notes are not in the list below because nobody decided about them, not because they" +
				" belong where they are. Re-run to cover them.",
			"",
		);
	}
	lines.push(
		"## Folders",
		"",
		...plan.taxonomy.folders.map((f) => `- ${f.folder} — ${oneLine(f.description, DESCRIPTION_CHARS)}`),
		"",
		`## Moves (${plan.moves.length})`,
		"",
	);
	if (plan.moves.length === 0) lines.push("Nothing to move — the vault is already filed the way the model would file it.");
	for (const move of plan.moves) {
		lines.push(`- [${move.selected ? "x" : " "}] ${move.id}  ${move.from} → ${move.to}/`);
	}
	lines.push("", `## Frozen (${plan.frozen.length})`, "");
	lines.push("These were never considered. The reason is why moving them would break something.", "");
	for (const frozen of plan.frozen.slice(0, FROZEN_SHOWN)) {
		lines.push(`- ${oneLine(frozen.path, 400)} — ${oneLine(frozen.reason, DESCRIPTION_CHARS)}`);
	}
	if (plan.frozen.length > FROZEN_SHOWN) lines.push(`- … and ${plan.frozen.length - FROZEN_SHOWN} more`);
	return `${lines.join("\n")}\n`;
}

/**
 * Read a plan back. Parsing is anchored on the id and on the two shapes a move line can
 * legally have — a source ending in `.md`, a destination ending in `/` — rather than on
 * delimiters. Backticks, arrows and pipes are all legal in an Obsidian note title and on
 * a Linux filesystem, and a delimiter-based parse silently yields a truncated path for
 * exactly the notes whose names are unusual enough that nobody would notice.
 *
 * Returns null when the file is not a plan at all. Anything else unparseable is dropped:
 * a line this cannot read is a note that does not move.
 */
export function parsePlan(text: string): ReorganizePlan | null {
	const header = new Map<string, string>();
	const headerRe = /^- (run|created|vault|model|scope|considered|truncated|unanswered|unseen|cost): (.*)$/gm;
	for (const match of text.matchAll(headerRe)) {
		if (!header.has(match[1]!)) header.set(match[1]!, (match[2] ?? "").trim());
	}
	// The run id names a directory we mkdir and append a journal to, so it is checked
	// against the one shape we ever mint rather than used as written. A plan whose header
	// says `../../tmp/pwned` is not a plan with an odd id; it is not a plan.
	const runId = header.get("run");
	if (!runId || !isRunId(runId)) return null;

	const folders: TaxonomyFolder[] = [];
	const moves: PlanMove[] = [];
	const frozen: Array<{ path: string; reason: string }> = [];
	let section = "";
	// `## Moves (12)` declares its own length. Reading past it is how a line that turned up
	// in the file some other way — a hand-edit, text injected through a folder description —
	// becomes a move. A heading with no count declares none, so nothing after it is read.
	//
	// The count is checked once, after the loop, against the total parsed. A running
	// per-line counter is easy to get subtly wrong; "the file said 12 and we read 12"
	// is one comparison, and any injected extra — before the real heading or after it —
	// makes the totals disagree and rejects the whole plan.
	let declaredMoves: number | null = null;

	for (const line of text.split(/\r?\n/)) {
		const heading = line.match(/^##\s+(\w+)(?:\s+\((\d+)\))?/);
		if (heading) {
			section = heading[1]!.toLowerCase();
			// First declaration wins, so a second `## Moves (5)` cannot raise the ceiling.
			if (section === "moves" && declaredMoves === null) {
				declaredMoves = heading[2] ? Number(heading[2]) : 0;
			}
			continue;
		}
		if (section === "folders") {
			const match = line.match(/^-\s+(.+?)\s+—\s+(.*)$/);
			const safe = match ? safeVaultFolder(match[1]!) : null;
			if (safe) folders.push({ folder: safe, description: oneLine(match![2]!, DESCRIPTION_CHARS) });
			continue;
		}
		if (section === "moves") {
			const match = line.match(/^-\s+\[([ xX])\]\s+(\d+)\s+(.+\.md)\s+→\s+(\S.*)\/$/);
			if (!match) continue;
			const from = vaultNotePath(match[3]!);
			const to = safeVaultFolder(match[4]!);
			if (!from || !to) continue;
			moves.push({ id: Number(match[2]), from, to, selected: match[1] !== " " });
			continue;
		}
		if (section === "frozen" && line.startsWith("- ")) {
			const body = line.slice(2);
			const split = body.lastIndexOf(" — ");
			if (split > 0) frozen.push({ path: body.slice(0, split), reason: body.slice(split + 3) });
		}
	}

	// `## Moves (12)` declares its own length, so a document carrying more move lines than
	// it admits to — a hand-edit that added one, or text injected through a folder
	// description — disagrees here and is refused outright. Refusing the whole plan rather
	// than truncating it keeps the file the user read and the file we act on identical.
	if (declaredMoves === null || moves.length !== declaredMoves) return null;

	return {
		runId,
		createdAt: header.get("created") ?? "",
		vault: header.get("vault") ?? "",
		model: header.get("model") ?? "",
		scope: !header.get("scope") || header.get("scope") === "-" ? null : header.get("scope")!,
		considered: Number(header.get("considered") ?? "0") || 0,
		truncated: Number(header.get("truncated") ?? "0") || 0,
		unansweredBatches: Number(header.get("unanswered") ?? "0") || 0,
		unseen: Number(header.get("unseen") ?? "0") || 0,
		costUsd: Number(header.get("cost") ?? "0") || 0,
		taxonomy: { folders, hash: taxonomyHash(folders) },
		moves,
		frozen,
	};
}

/**
 * Resolve `--plan`: a run id, a path to a plan file, or nothing at all, which means the
 * most recent run that produced one.
 */
export function loadPlan(ref?: string): { plan: ReorganizePlan; path: string } | null {
	const candidates: string[] = [];
	// A bare ref is a run id or nothing: runDir() refuses anything else, and silently
	// leaving the list empty here is the same answer as "no plan by that name".
	if (ref && (ref.includes("/") || ref.endsWith(".md"))) candidates.push(ref);
	else if (ref && isRunId(ref)) candidates.push(join(runDir(ref), "plan.md"));
	else if (!ref) for (const runId of runIds()) candidates.push(join(runDir(runId), "plan.md"));

	for (const path of candidates) {
		if (!existsSync(path) || !statSync(path).isFile()) continue;
		const plan = parsePlan(readFileSync(path, "utf-8"));
		if (plan) return { plan, path };
	}
	return null;
}
