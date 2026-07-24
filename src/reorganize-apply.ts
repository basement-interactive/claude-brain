// The only code in claude-brain that moves the user's notes.
//
// Everything here is built around one rule: a note's bytes are never touched, only its
// location, and every location change is written down before it happens so it can be put
// back. No rename, no merge, no delete, no non-.md file.
//
// Plan-time checks are re-run here, cheaply, because a plan can be hours old and edited by
// hand in between. Anything that fails re-verification is skipped and reported by category
// rather than fixed silently: a user who asked for 200 moves and got 197 deserves to know
// which three and why.
//
// Both ends of every move are proved to be inside the vault before anything happens, and
// proved through symlinks rather than by comparing strings. Neither end is trusted: plan.md
// is advertised as hand-editable, `--plan <file>` takes a plan this machine never wrote,
// and a folder inside the vault can be a symlink to anywhere on the disk. "It came out of
// our own index" is not a claim this module is in a position to make.

import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { REORGANIZE_LOCK, STATE_DIR, loadConfig, reorganizeLockHeld, safeVaultFolder, vaultReady, vaultRoot } from "./config";
import { recordEpisode } from "./episodic";
import { openBrainDb } from "./index-db";
import {
	JOURNAL_NAME,
	UNDONE_JOURNAL_NAME,
	type JournalRecord,
	type PlanMove,
	type ReorganizePlan,
	isRunId,
	journalPath,
	loadPlan,
	readJournal,
	runDir,
	runIds,
} from "./reorganize-plan";
import {
	ambiguousBasenames,
	basenameKey,
	calendarShapedFolder,
	journalFolders,
	scanLinkRisks,
	underAnyFolder,
	vaultNotePath,
} from "./vault-links";

export interface SkippedMove {
	from: string;
	to: string;
	reason: string;
}

export interface ApplyResult {
	ok: boolean;
	runId: string;
	moved: number;
	skipped: SkippedMove[];
	prunedDirs: number;
	/** Things the user should know but that are not reasons to stop. */
	warnings: string[];
	message?: string;
}

export interface UndoResult {
	ok: boolean;
	runId: string;
	restored: number;
	skipped: SkippedMove[];
	message?: string;
}

export interface RunSummary {
	runId: string;
	createdAt: string;
	moves: number;
	applied: boolean;
	undone: boolean;
	costUsd: number;
}

export interface ApplyOptions {
	/** Off for `--no-reindex`, when the user is applying several plans back to back. */
	reindex?: boolean;
	onProgress?: (message: string) => void;
}

/** Obsidian rewrites workspace.json constantly while it is open; a fresh mtime is the
 *  cheapest evidence that the vault is being edited right now. */
const OBSIDIAN_ACTIVE_MS = 5 * 60_000;

/** How long we wait for the server to *acknowledge* a reindex, not to finish one. */
const REINDEX_ANSWER_MS = 30_000;

// ---------------------------------------------------------------- lock

/** Null when the lock is ours, otherwise the reason it is not — which is not always
 *  contention: on a fresh XDG_STATE_HOME the lock file's own directory does not exist yet,
 *  and reporting that as "another reorganize is running" sends the user hunting for a
 *  process that was never there. */
function takeLock(runId: string): string | null {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
	} catch (err) {
		return `could not create ${STATE_DIR}: ${String(err)}`;
	}
	let lastError = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(REORGANIZE_LOCK, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, runId, startedAt: Date.now() }));
			closeSync(fd);
			return null;
		} catch (err) {
			lastError = String(err);
			// reorganizeLockHeld() unlinks a lock whose writer is gone, so a second attempt
			// after a false answer succeeds. A live holder means someone else is moving
			// these same files, and two of us must never do that at once.
			if (reorganizeLockHeld()) return "another reorganize is running — wait for it to finish";
		}
	}
	return `could not take the reorganize lock: ${lastError}`;
}

function releaseLock(): void {
	try {
		unlinkSync(REORGANIZE_LOCK);
	} catch {
		/* already gone */
	}
}

/**
 * The lock file is enough for a watcher that knows about it, but the running server may be
 * a pre-upgrade build. Asking it to pause is best effort in both directions: an old server
 * 404s, a dead one refuses the connection, and neither is a reason not to proceed.
 */
async function watchControl(action: "pause" | "resume"): Promise<void> {
	try {
		await fetch(`http://localhost:${loadConfig().port}/api/watch/${action}`, {
			method: "POST",
			signal: AbortSignal.timeout(3000),
		});
	} catch {
		/* no server, or a build that predates the endpoint */
	}
}

// ---------------------------------------------------------------- moving

function hashFile(absPath: string): string {
	return String(Bun.hash(readFileSync(absPath)));
}

/**
 * Rename where possible, copy where not. A vault split across mounts (a symlinked folder
 * into a second disk) fails renameSync with EXDEV, and the copy path has to restore mtime
 * by hand: it drives Obsidian's recent-files list, date-sorted Dataview queries and the
 * indexer's mtime+size fast path, so losing it re-embeds the entire moved set.
 */
function moveFile(fromAbs: string, toAbs: string): void {
	try {
		renameSync(fromAbs, toAbs);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
	}
	const before = statSync(fromAbs);
	copyFileSync(fromAbs, toAbs);
	// Copy-then-delete is two operations and the second one can fail on its own — a source
	// on a read-only mount, an immutable bit, a permission the copy did not need. A half
	// done move is worse than none: two notes now share a basename, so every bare [[link]]
	// to either resolves ambiguously, undo refuses to touch a path that is occupied, and
	// the ambiguity itself freezes both copies against every future run. So the copy is
	// rolled back and the caller sees a failed move over a vault it can still reason about.
	try {
		utimesSync(toAbs, before.atime, before.mtime);
		if (statSync(toAbs).size !== before.size) throw new Error("copy across devices was truncated");
		unlinkSync(fromAbs);
	} catch (err) {
		try {
			unlinkSync(toAbs);
		} catch {
			/* nothing better to do; the original failure is the one worth reporting */
		}
		throw err;
	}
}

/**
 * The deepest ancestor of `abs` that exists, resolved through symlinks — or null when we
 * cannot tell. Only ENOENT is walked past: a path we are refused permission to resolve is
 * a path whose location we do not know, and guessing at a parent's answer is how a check
 * like this approves the thing it exists to refuse.
 */
function realExistingAncestor(abs: string): string | null {
	let current = abs;
	for (;;) {
		try {
			return realpathSync(current);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/** Containment through symlinks, not string prefixes. `Ideas/` inside the vault can be a
 *  symlink to a second disk, and both renameSync and copyFileSync follow it. */
function insideVault(rootReal: string, abs: string | null): boolean {
	return abs !== null && (abs === rootReal || abs.startsWith(rootReal + sep));
}

/** Where a move would actually read and write, once both ends are known to be inside the
 *  vault. Produced by the same function that refuses moves so the paths that were checked
 *  and the paths that are used cannot drift apart. */
interface ResolvedMove {
	fromAbs: string;
	toAbs: string;
	/** Vault-relative destination including the filename, as journalled. */
	toRel: string;
}

type MoveCheck = { ok: true; move: ResolvedMove } | { ok: false; reason: string };

interface MoveContext {
	rootReal: string;
	journals: Set<string>;
	duplicates: Set<string>;
	risks: Map<string, string>;
}

/**
 * Every reason a planned move is refused at apply time, in one place so the categories
 * reported to the user and the checks that produce them cannot drift apart.
 *
 * Both ends are checked, and the source end matters most: it is the one the plan format
 * lets a hand-edit name freely, and a source outside the vault means moving a file that
 * is none of our business into a vault the user did not ask us to fill. Textual
 * containment settles neither end — a symlinked folder resolves elsewhere and rename
 * follows it — so the deepest existing directory of each end is resolved and re-checked.
 */
function checkMove(from: string, to: string, ctx: MoveContext): MoveCheck {
	const refuse = (reason: string): MoveCheck => ({ ok: false, reason });

	const fromRel = vaultNotePath(from);
	if (!fromRel) return refuse("source is not a vault-relative markdown path");
	// Re-checked here and not only at parse time: this is the last point before a file
	// moves, and a note filed into `Trash` or `.obsidian` is gone from every index while
	// the file itself still exists.
	if (safeVaultFolder(to) !== to) return refuse("destination is not a folder we will write to");
	if (calendarShapedFolder(to)) return refuse("destination is a calendar-shaped folder");

	const fromAbs = join(ctx.rootReal, fromRel);
	const toRel = `${to}/${basename(fromRel)}`;
	const toAbs = join(ctx.rootReal, toRel);

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(fromAbs);
	} catch {
		return refuse("source is gone");
	}
	// lstat, not stat: following a symlink would move the link and leave whatever it
	// pointed at behind, or move a file from outside the vault entirely.
	if (!stat.isFile()) return refuse(stat.isSymbolicLink() ? "source is a symlink" : "source is not a regular file");
	if (!insideVault(ctx.rootReal, realExistingAncestor(dirname(fromAbs)))) return refuse("source resolves outside the vault");
	if (!insideVault(ctx.rootReal, realExistingAncestor(dirname(toAbs)))) return refuse("destination escapes the vault");

	if (existsSync(toAbs)) return refuse("a note with that name is already there");
	if (underAnyFolder(fromRel, ctx.journals)) return refuse("source is in a journal folder");
	if (underAnyFolder(`${to}/x.md`, ctx.journals)) return refuse("destination is a journal folder");
	if (ctx.duplicates.has(basenameKey(fromRel))) return refuse("another note now shares this filename");
	const risk = ctx.risks.get(fromRel);
	if (risk) return refuse(risk);

	return { ok: true, move: { fromAbs, toAbs, toRel } };
}

// ---------------------------------------------------------------- apply

export async function applyPlan(plan: ReorganizePlan, opts: ApplyOptions = {}): Promise<ApplyResult> {
	const progress = opts.onProgress ?? (() => {});
	const empty: ApplyResult = { ok: false, runId: plan.runId, moved: 0, skipped: [], prunedDirs: 0, warnings: [] };

	const root = vaultRoot();
	if (!root || !vaultReady()) return { ...empty, message: "no vault available" };
	if (!isRunId(plan.runId)) return { ...empty, message: `this plan's run id is not one we minted: ${plan.runId}` };
	// The vault the plan names is compared through symlinks too: a plan made for the vault
	// under its real path must still apply when the config holds a symlink to it, and two
	// different vaults must not compare equal because one path is a link to the other.
	const rootReal = realExistingAncestor(root);
	if (!rootReal) return { ...empty, message: `the vault path ${root} cannot be resolved` };
	if (plan.vault && realExistingAncestor(plan.vault) !== rootReal) {
		return { ...empty, message: `this plan was made for ${plan.vault}, but the current vault is ${root}` };
	}
	if (existsSync(journalPath(plan.runId))) {
		return {
			...empty,
			message: `run ${plan.runId} has already been applied — undo it first with \`claude-brain reorganize --undo ${plan.runId}\``,
		};
	}

	if (!plan.moves.some((move) => move.selected)) return { ...empty, ok: true, message: "nothing selected in the plan" };

	const skipped: SkippedMove[] = [];
	// Normalised once, here, so the link scan, the refusal checks and the journal all name
	// a move's source with the same string. A path that cannot be normalised is refused
	// before it reaches any of them.
	const selected: PlanMove[] = [];
	for (const move of plan.moves) {
		if (!move.selected) continue;
		const from = vaultNotePath(move.from);
		if (!from) {
			skipped.push({ from: move.from, to: move.to, reason: "source is not a vault-relative markdown path" });
			continue;
		}
		selected.push({ ...move, from });
	}
	// ok stays false: a plan whose every move was rejected is the shape that most warrants
	// a non-zero exit, and the CLI takes its exit code straight from this flag.
	if (selected.length === 0) {
		return { ...empty, skipped, message: "every selected move named a path outside the vault" };
	}

	const lockRefusal = takeLock(plan.runId);
	if (lockRefusal) return { ...empty, skipped, message: lockRefusal };

	const warnings = obsidianWarnings(root);
	for (const warning of warnings) progress(`warning: ${warning}`);
	await watchControl("pause");

	const sourceDirs = new Set<string>();
	let moved = 0;

	try {
		// Cheap re-verification only: the full-vault link scan is plan-time work and these
		// vaults live on portable disks. What can have changed since the plan is what the
		// moved notes themselves link to, plus whether a new note now shares a basename.
		const { db } = openBrainDb();
		const allPaths = (db.query("SELECT path FROM docs").all() as Array<{ path: string }>).map((row) => row.path);
		const ctx: MoveContext = {
			rootReal,
			journals: journalFolders(allPaths, rootReal),
			duplicates: ambiguousBasenames(allPaths),
			risks: scanLinkRisks(rootReal, selected.map((move) => move.from)),
		};

		mkdirSync(runDir(plan.runId), { recursive: true });
		const journal = journalPath(plan.runId);

		for (const planned of selected) {
			const checked = checkMove(planned.from, planned.to, ctx);
			if (!checked.ok) {
				skipped.push({ from: planned.from, to: planned.to, reason: checked.reason });
				continue;
			}
			const { fromAbs, toAbs, toRel } = checked.move;
			try {
				const beforeHash = hashFile(fromAbs);
				mkdirSync(dirname(toAbs), { recursive: true });
				appendRecord(journal, { kind: "move", ts: Date.now(), from: planned.from, to: toRel, beforeHash });
				moveFile(fromAbs, toAbs);
				appendRecord(journal, { kind: "move-done", ts: Date.now(), to: toRel, afterHash: hashFile(toAbs) });
				sourceDirs.add(dirname(planned.from));
				moved++;
			} catch (err) {
				// One unwritable note must not abandon the rest mid-run; the journal already
				// records whether this one landed, so undo can still reason about it.
				skipped.push({ from: planned.from, to: planned.to, reason: String(err) });
			}
			if (moved % 25 === 0 && moved > 0) progress(`moved ${moved}/${selected.length}`);
		}
	} finally {
		releaseLock();
	}

	const prunedDirs = pruneEmptyDirs(rootReal, sourceDirs);
	await watchControl("resume");

	recordEpisode({
		sessionId: "reorganize",
		kind: "outcome",
		text: `reorganised ${moved} notes into ${new Set(selected.map((m) => m.to)).size} folders (run ${plan.runId})`,
		salience: 2,
	});
	if (opts.reindex !== false) await triggerReindex(progress);

	return { ok: true, runId: plan.runId, moved, skipped, prunedDirs, warnings };
}

function appendRecord(path: string, record: JournalRecord): void {
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/**
 * Obsidian treats an external move as a delete plus a create, so it will not update links
 * it would have fixed itself, and an editor with unsaved changes can write the note back
 * to its old path minutes later. Neither is worth refusing over — the moves are still
 * reversible — but a user who sees this afterwards has no way to connect it to the cause.
 */
function obsidianWarnings(root: string): string[] {
	const warnings: string[] = [];
	try {
		const workspace = statSync(join(root, ".obsidian", "workspace.json"));
		if (Date.now() - workspace.mtimeMs < OBSIDIAN_ACTIVE_MS) {
			warnings.push("this vault was open in Obsidian moments ago — close it so unsaved notes are not written back to their old paths");
		}
	} catch {
		/* no workspace file: the vault has not been opened in Obsidian */
	}
	const pgrep = Bun.which("pgrep");
	if (pgrep && Bun.spawnSync([pgrep, "-x", "obsidian"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
		warnings.push("Obsidian is running — it sees external moves as delete + create and will not update links");
	}
	return warnings;
}

/**
 * Remove directories this run emptied, and their parents if that emptied those too. Only
 * genuinely empty ones: a leftover .DS_Store or an attachment means the folder still holds
 * something of the user's, and a journal folder is never pruned even if it looks empty.
 */
function pruneEmptyDirs(rootReal: string, sourceDirs: Set<string>): number {
	const journals = journalFolders([...sourceDirs].map((dir) => `${dir}/x.md`), rootReal);
	let pruned = 0;
	for (const start of [...sourceDirs].sort((a, b) => b.length - a.length)) {
		let rel = start;
		while (rel && !underAnyFolder(`${rel}/x.md`, journals)) {
			const abs = resolve(rootReal, rel);
			if (abs === rootReal || !abs.startsWith(rootReal + sep)) break;
			try {
				// A symlinked folder is the user's own arrangement, not something this run
				// emptied — and readdir would answer for whatever it points at.
				if (lstatSync(abs).isSymbolicLink()) break;
				if (readdirSync(abs).length > 0) break;
				rmdirSync(abs);
				pruned++;
			} catch {
				break;
			}
			rel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
		}
	}
	return pruned;
}

/**
 * Exactly one reindex for the whole run, through the server when it is up so the running
 * process's caches agree with the disk. Mirrors how `claude-brain note` degrades.
 *
 * The timeout is a limit on waiting for an answer, not a verdict on the server. A vault of
 * a few thousand notes legitimately takes minutes to walk, chunk and embed, so a request
 * that has not come back yet means the job is running — not that nobody took it. Indexing
 * here as well would put a second writer on the same SQLite file for no gain: at best the
 * user pays for the embedding pass twice, at worst SQLITE_BUSY surfaces out of applyPlan
 * after the notes have already moved, which reads as a failed run that in fact succeeded.
 */
async function triggerReindex(progress: (message: string) => void): Promise<void> {
	try {
		const res = await fetch(`http://localhost:${loadConfig().port}/api/reindex`, {
			method: "POST",
			signal: AbortSignal.timeout(REINDEX_ANSWER_MS),
		});
		if (res.ok) return;
		progress(`the server refused the reindex (HTTP ${res.status}) — indexing here instead`);
	} catch (err) {
		const name = (err as Error | undefined)?.name;
		if (name === "TimeoutError" || name === "AbortError") {
			progress("the server took the reindex and is still working — it will finish in the background");
			return;
		}
		progress("no server is running — indexing here instead");
	}
	await (await import("./indexer")).reindex();
}

// ---------------------------------------------------------------- undo

interface JournalledMove {
	from: string;
	to: string;
	beforeHash: string;
	done: boolean;
	afterHash: string;
}

function pairJournal(records: JournalRecord[]): JournalledMove[] {
	const moves: JournalledMove[] = [];
	for (const record of records) {
		if (record.kind === "move") {
			moves.push({ from: record.from, to: record.to, beforeHash: record.beforeHash, done: false, afterHash: "" });
			continue;
		}
		if (record.kind === "move-done") {
			// The pending record for this destination is always the last one written.
			const pending = [...moves].reverse().find((move) => move.to === record.to && !move.done);
			if (pending) {
				pending.done = true;
				pending.afterHash = record.afterHash;
			}
		}
	}
	return moves;
}

/**
 * Put a run back exactly where it was, newest move first so a note that passed through two
 * folders lands where it started.
 *
 * The two record kinds are undone differently on purpose. A completed move is reversed on
 * the strength of the journal alone — the file is where we said we put it, and restoring
 * its path is safe even if the user has edited the contents since. A dangling `move` means
 * the process died between the record and the rename, so the hash decides which side of it
 * landed. "The file I would move back is not there" is a skip, not an error: something else
 * already reorganised it, and guessing is how an undo destroys work.
 */
export async function undoRun(runId?: string, onProgress?: (message: string) => void): Promise<UndoResult> {
	const progress = onProgress ?? (() => {});
	const root = vaultRoot();
	if (runId && !isRunId(runId)) {
		return { ok: false, runId, restored: 0, skipped: [], message: `not a run id: ${runId}` };
	}
	const target = runId ?? runIds().find((id) => existsSync(journalPath(id)));
	if (!target) return { ok: false, runId: "", restored: 0, skipped: [], message: "no applied run to undo" };
	if (!root || !vaultReady()) return { ok: false, runId: target, restored: 0, skipped: [], message: "no vault available" };
	const rootReal = realExistingAncestor(root);
	if (!rootReal) return { ok: false, runId: target, restored: 0, skipped: [], message: `the vault path ${root} cannot be resolved` };

	const journal = journalPath(target);
	if (!existsSync(journal)) {
		const already = existsSync(journalPath(target, true));
		return {
			ok: false,
			runId: target,
			restored: 0,
			skipped: [],
			message: already ? `run ${target} was already undone` : `run ${target} was never applied`,
		};
	}
	const lockRefusal = takeLock(target);
	if (lockRefusal) return { ok: false, runId: target, restored: 0, skipped: [], message: lockRefusal };
	await watchControl("pause");

	const skipped: SkippedMove[] = [];
	const restoredDirs = new Set<string>();
	let restored = 0;
	try {
		for (const move of pairJournal(readJournal(target)).reverse()) {
			const skip = (reason: string) => skipped.push({ from: move.to, to: dirname(move.from), reason });
			// The journal is ours, but it is a file on disk like any other: a truncated
			// append, a hand-edit, a run recorded by a build that did not check these paths.
			// Undo writes to the vault, so it earns its own containment check rather than
			// inheriting apply's.
			const fromRel = vaultNotePath(move.from);
			const toRel = vaultNotePath(move.to);
			if (!fromRel || !toRel) {
				skip("the journal record does not name a path inside the vault");
				continue;
			}
			const fromAbs = join(rootReal, fromRel);
			const toAbs = join(rootReal, toRel);
			if (!insideVault(rootReal, realExistingAncestor(dirname(fromAbs)))) {
				skip("its original folder now resolves outside the vault");
				continue;
			}
			if (!insideVault(rootReal, realExistingAncestor(dirname(toAbs)))) {
				skip("its current folder now resolves outside the vault");
				continue;
			}

			if (!existsSync(toAbs)) {
				// A dangling record whose source is still in place simply never happened.
				skip(existsSync(fromAbs) ? "the move never landed" : "the note is no longer where the run left it");
				continue;
			}
			if (!move.done && hashFile(toAbs) !== move.beforeHash) {
				skip("interrupted move, and the file at the destination is not the one that was moved");
				continue;
			}
			if (existsSync(fromAbs)) {
				skip("something already occupies its original path");
				continue;
			}
			try {
				mkdirSync(dirname(fromAbs), { recursive: true });
				moveFile(toAbs, fromAbs);
				restoredDirs.add(dirname(toRel));
				restored++;
			} catch (err) {
				skip(String(err));
			}
		}
		// Only retire a journal that actually put something back. Marking a run undone
		// when every record was skipped loses the one record of where those notes went,
		// and drops them out of the 30-day churn protection in recentlyMovedPaths().
		if (restored > 0) {
			appendRecord(journal, { kind: "undone", ts: Date.now() });
			renameSync(journal, journalPath(target, true));
		}
	} finally {
		releaseLock();
	}

	pruneEmptyDirs(rootReal, restoredDirs);
	await watchControl("resume");
	recordEpisode({
		sessionId: "reorganize",
		kind: "outcome",
		text: `undid reorganize run ${target}: ${restored} notes back where they were`,
		salience: 2,
	});
	await triggerReindex(progress);
	return { ok: true, runId: target, restored, skipped };
}

// ---------------------------------------------------------------- listing

export function listRuns(): RunSummary[] {
	const runs: RunSummary[] = [];
	for (const runId of runIds()) {
		const loaded = loadPlan(runId);
		if (!loaded) continue;
		runs.push({
			runId,
			createdAt: loaded.plan.createdAt,
			moves: loaded.plan.moves.filter((move) => move.selected).length,
			applied: existsSync(join(runDir(runId), JOURNAL_NAME)) || existsSync(join(runDir(runId), UNDONE_JOURNAL_NAME)),
			undone: existsSync(join(runDir(runId), UNDONE_JOURNAL_NAME)),
			costUsd: loaded.plan.costUsd,
		});
	}
	return runs;
}
