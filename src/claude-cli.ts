// The one place claude-brain shells out to the user's own Claude Code CLI. Everything
// else in the brain is local and free; this module is the trust boundary where calls
// start costing the user real money, so it is deliberately conservative: gated behind
// explicit consent, serialized across processes, budgeted against a daily ledger, timed
// out, and null-returning on every failure path.
//
// Three flags carry most of the weight and none are optional:
//   --safe-mode              claude-brain installs SessionStart/UserPromptSubmit/SessionEnd
//                            hooks that shell back into `claude-brain`. Without safe-mode
//                            every internal call re-enters our own hooks (recursion, and
//                            synthetic prompts polluting episodic memory) and inherits the
//                            user's CLAUDE.md, whose house style rewrites our output.
//                            Measured: 3.4k input tokens vs 11.8k, $0.0042 vs $0.111.
//   --no-session-persistence otherwise every call leaves a transcript in
//                            ~/.claude/projects/<cwd-slug>/, which our own transcript miner
//                            would later ingest as if the user had said it.
//   --tools ""               no tool should ever touch the vault. Widened to "Read" only
//                            for image calls, which cannot work without it.
// `--bare` looks similar but is wrong: it never reads OAuth, so it breaks every
// subscription user who has no ANTHROPIC_API_KEY.
//
// What a call costs, measured, so no caller has to rediscover it:
//   ~3459 input tokens = $0.0036 per haiku call even with --safe-mode. That is the floor;
//   the prompt is on top of it. One large image is ~$0.016.
// A caller that makes one call per note therefore costs at least $18 on a 5000-note vault.
// Batching is the caller's obligation, and the number above is why.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR, STATE_DIR, loadConfig } from "./config";
import { imageMeta } from "./image-meta";

/** Aliases, not pinned model ids — the CLI resolves them and pinned ids rot. */
export type ClaudeModel = "haiku" | "sonnet" | "opus";

export interface AskOptions {
	/** Absolute image paths. Presence switches the Read tool on; without it the model
	 *  invents a description instead of failing. */
	images?: string[];
	model?: ClaudeModel;
	timeoutMs?: number;
	/** Hard per-call ceiling handed to the CLI itself, in USD. */
	maxCostUsd?: number;
	signal?: AbortSignal;
	/** Shown in the log line and the spend ledger so a user can see what spent their money. */
	label?: string;
}

export type Unavailable = "not-installed" | "not-logged-in" | "too-old" | "disabled";

export interface ClaudeStatus {
	available: boolean;
	reason: Unavailable | "ok";
	binary: string | null;
	/** Present only when logged in — shown in the dashboard so the user knows which account pays. */
	account?: string;
	version?: string;
	/** Epoch ms until which the breaker stays open, so the UI can say when it retries. */
	breakerUntil?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const IMAGE_TIMEOUT_MS = 150_000;
/** A single call that wants more than this is a bug in the caller, not a big job. */
const DEFAULT_MAX_COST_USD = 0.25;
const STATUS_TTL_MS = 300_000;
/** Consecutive hard failures before we stop trying for a while. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
const BREAKER_MAX_COOLDOWN_MS = 30 * 60_000;
/** Anything the model refuses to look at anyway; checked locally, before a token is spent. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2000;
/** Measured floor of one --safe-mode haiku call. Charged to the ledger when we kill a
 *  call mid-flight: the request was still billed, and recording 0 would understate the day. */
const MIN_CALL_COST_USD = 0.0036;

const LOCK_PATH = join(STATE_DIR, "claude-cli.lock");
const LEDGER_PATH = join(STATE_DIR, "llm-spend.jsonl");
/** A lock older than this belonged to a process that died without unlinking. */
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 100;

/** The CLI walks up from cwd looking for CLAUDE.md and slugs cwd into ~/.claude/projects.
 *  Both are reasons never to run it inside the vault. An empty cache dir is inert. */
function workDir(): string {
	const dir = join(CACHE_DIR, "claude-cwd");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Bun.which only sees PATH, and the daemon's PATH is systemd's, not the user's login
 *  shell's — which is where every one of these install locations actually lives. */
function findBinary(): string | null {
	const configured = loadConfig().llm.binaryPath;
	if (configured && existsSync(configured)) return configured;
	const fromEnv = process.env.CLAUDE_CODE_EXECPATH;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const onPath = Bun.which("claude");
	if (onPath) return onPath;
	const home = homedir();
	for (const candidate of [
		join(home, ".local", "bin", "claude"),
		join(home, ".bun", "bin", "claude"),
		join(home, ".claude", "local", "claude"),
		"/usr/bin/claude",
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Flags this module cannot safely run without. An older CLI rejects an unknown option with
 *  "error: unknown option" on stderr and prints no JSON at all, so calls would fail closed
 *  but silently. Reading --help once turns that into an honest "too-old". */
const REQUIRED_FLAGS = [
	"--safe-mode",
	"--no-session-persistence",
	"--json-schema",
	"--output-format",
	"--tools",
	"--max-budget-usd",
];

async function supportsRequiredFlags(binary: string): Promise<boolean> {
	const proc = Bun.spawn([binary, "--help"], { cwd: workDir(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const help = await new Response(proc.stdout).text();
	await proc.exited;
	// Anchored to the start of an option line, not a substring: --bare's own description
	// names other flags in prose, so `help.includes(flag)` can pass on a mere mention.
	return REQUIRED_FLAGS.every((flag) => new RegExp(`^\\s+${flag}\\b`, "m").test(help));
}

// ---------------------------------------------------------------- availability

let statusCache: { at: number; value: ClaudeStatus } | null = null;
const breaker = { failures: 0, openedUntil: 0 };

/** Consecutive failures open the breaker for 5 minutes, doubling to a 30 minute ceiling.
 *  It closes itself: three timeouts across a laptop suspend must not disable every LLM
 *  feature for the life of the daemon. */
function recordFailure(): void {
	breaker.failures += 1;
	if (breaker.failures < BREAKER_THRESHOLD) return;
	const cooldown = Math.min(BREAKER_COOLDOWN_MS * 2 ** (breaker.failures - BREAKER_THRESHOLD), BREAKER_MAX_COOLDOWN_MS);
	breaker.openedUntil = Date.now() + cooldown;
}

function recordSuccess(): void {
	breaker.failures = 0;
	breaker.openedUntil = 0;
}

/** For a "try again now" button: the user knows something we don't (VPN back up, quota reset). */
export function resetBreaker(): void {
	recordSuccess();
}

/**
 * `claude auth status --json` costs zero tokens, makes no network call (verified with a
 * blackholed proxy) and takes ~450 ms — cheap enough to check, too slow to check per item,
 * hence the TTL cache. It proves credentials exist, not that they still work; call sites
 * must still tolerate a null from ask().
 */
export async function status(force = false): Promise<ClaudeStatus> {
	// Consent first: with llm.enabled off we do not even look for the binary, so an
	// install that never opts in never spawns anything.
	if (!loadConfig().llm.enabled) return { available: false, reason: "disabled", binary: null };
	if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return withBreaker(statusCache.value);

	const binary = findBinary();
	let value: ClaudeStatus = { available: false, reason: "not-installed", binary: null };

	if (binary && !(await supportsRequiredFlags(binary))) {
		value = { available: false, reason: "too-old", binary };
	} else if (binary) {
		const proc = Bun.spawn([binary, "auth", "status", "--json"], {
			cwd: workDir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const raw = await new Response(proc.stdout).text();
		await proc.exited;
		const parsed = safeParse<{ loggedIn?: boolean; email?: string }>(raw);
		value = parsed?.loggedIn
			? { available: true, reason: "ok", binary, account: parsed.email }
			: { available: false, reason: "not-logged-in", binary };
	}

	statusCache = { at: Date.now(), value };
	// Checking status deliberately does not clear the breaker — only a call that works,
	// or the user pressing reset, is evidence that anything changed.
	return withBreaker(value);
}

function withBreaker(value: ClaudeStatus): ClaudeStatus {
	return breaker.openedUntil > Date.now() ? { ...value, breakerUntil: breaker.openedUntil } : value;
}

export async function isAvailable(): Promise<boolean> {
	if (Date.now() < breaker.openedUntil) return false;
	return (await status()).available;
}

// ---------------------------------------------------------------- spend ledger

interface SpendEntry {
	ts: number;
	label: string;
	model: ClaudeModel;
	costUsd: number;
	ok: boolean;
}

/** Session totals are per-process, and claude-brain runs as at least three (the systemd
 *  server, the CLI, and one short-lived process per hook fire). The budget only means
 *  anything if they all count against the same file. */
let spent = 0;
export function sessionSpendUsd(): number {
	return spent;
}

function recordSpend(entry: SpendEntry): void {
	spent += entry.costUsd;
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		/* the ledger is advisory; failing to append must not fail the call */
	}
}

/** Today's spend across every claude-brain process. ~80 bytes per call, so the whole
 *  file is small enough to re-read per invocation rather than cache and go stale. */
export function spendTodayUsd(): number {
	let raw: string;
	try {
		raw = readFileSync(LEDGER_PATH, "utf-8");
	} catch {
		return 0;
	}
	const since = new Date().setHours(0, 0, 0, 0);
	let total = 0;
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const entry = safeParse<SpendEntry>(line);
		if (entry && entry.ts >= since) total += entry.costUsd;
	}
	return total;
}

function remainingBudgetUsd(): number {
	return Math.max(0, loadConfig().llm.dailyBudgetUsd - spendTodayUsd());
}

// ---------------------------------------------------------------- cross-process lock

function lockHolderIsAlive(): boolean {
	let raw: string;
	try {
		raw = readFileSync(LOCK_PATH, "utf-8");
	} catch {
		return false;
	}
	const held = safeParse<{ pid?: number; startedAt?: number }>(raw);
	if (!held?.pid) return false;
	if (held.startedAt && Date.now() - held.startedAt > LOCK_STALE_MS) return false;
	try {
		process.kill(held.pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * One `claude` child per machine. In-process serialization is not enough: a hook fire and
 * the daemon can spawn at the same instant, and subscription sessions are rate-limited.
 * A caller that cannot take the lock quickly gives up rather than queueing — a queued
 * batch behind someone else's long call is how a "quick" pass turns into a stall.
 */
async function acquireLock(): Promise<boolean> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(STATE_DIR, { recursive: true });
			const fd = openSync(LOCK_PATH, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
			closeSync(fd);
			return true;
		} catch {
			if (!lockHolderIsAlive()) {
				try {
					unlinkSync(LOCK_PATH);
					continue;
				} catch {
					/* lost the race to clean it; fall through to the wait */
				}
			}
			if (Date.now() >= deadline) return false;
			await Bun.sleep(LOCK_POLL_MS);
		}
	}
}

function releaseLock(): void {
	try {
		unlinkSync(LOCK_PATH);
	} catch {
		/* already gone */
	}
}

// ---------------------------------------------------------------- invocation

/** The subset of the --output-format json envelope we rely on. Everything else
 *  (usage, modelUsage, ttft_ms, …) is real but none of our business. */
interface ResultEnvelope {
	type: string;
	subtype: string;
	is_error: boolean;
	/** Null when the CLI stopped itself, e.g. subtype "error_max_budget_usd". */
	result: string | null;
	num_turns: number;
	total_cost_usd: number;
	structured_output?: unknown;
	permission_denials?: unknown[];
}

export interface CallOutcome {
	envelope: ResultEnvelope | null;
	costUsd: number;
	/** Null on any failure, including a well-formed envelope carrying is_error. */
	text: string | null;
	/** Envelope subtype, so a UI can distinguish "stopped at your budget" from "failed". */
	subtype: string | null;
	/** Set when the call never happened at all. */
	blocked: "hook" | "budget" | "busy" | "aborted" | "unavailable" | null;
	/** Last 2 KB of stderr. Without it a packaged install has zero diagnostics. */
	stderr: string;
}

function safeParse<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function blockedOutcome(blocked: NonNullable<CallOutcome["blocked"]>): CallOutcome {
	return { envelope: null, costUsd: 0, text: null, subtype: null, blocked, stderr: "" };
}

/**
 * Everything the child is allowed to see. Inheriting the parent environment would hand a
 * nested call CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / CLAUDE_CODE_SESSION_ID and associate
 * it with the user's live session; an allowlist makes that impossible by construction
 * rather than by remembering to strip each new variable.
 */
function childEnv(): Record<string, string> {
	const allowed = ["PATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (allowed.includes(key) || key.startsWith("XDG_") || key.startsWith("ANTHROPIC_")) env[key] = value;
	}
	return env;
}

async function invoke(prompt: string, args: string[], opts: AskOptions): Promise<CallOutcome> {
	// Hooks installed by integrate.ts are killed at 8-20 s. A 90 s call from a hook path
	// gets the parent killed and orphans a `claude` child that bills for another 80 s
	// with its output discarded.
	if (process.env.CLAUDE_BRAIN_HOOK === "1") return blockedOutcome("hook");
	// Re-checked here as well as in the queue: a job can sit behind a 90 s call and the
	// caller may have given up long before its turn came.
	if (opts.signal?.aborted) return blockedOutcome("aborted");

	const st = await status();
	if (!st.available || !st.binary) return blockedOutcome("unavailable");
	if (remainingBudgetUsd() <= 0) return blockedOutcome("budget");
	if (!(await acquireLock())) return blockedOutcome("busy");

	const model = opts.model ?? loadConfig().llm.model;
	const timeoutMs = opts.timeoutMs ?? (opts.images?.length ? IMAGE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
	let killed = false;
	let child: ReturnType<typeof Bun.spawn> | null = null;
	// SIGTERM first so the CLI can close its own children; SIGKILL only if it ignores us.
	const stop = () => {
		if (killed) return;
		killed = true;
		child?.kill("SIGTERM");
		setTimeout(() => child?.kill("SIGKILL"), 2_000).unref?.();
	};
	const onAbort = () => stop();

	try {
		const proc = Bun.spawn([st.binary, ...args], {
			cwd: workDir(),
			env: childEnv(),
			// Prompt goes on stdin, never argv: reorganize sends thousands of note titles and
			// ARG_MAX is a silent, size-dependent failure.
			stdin: new TextEncoder().encode(prompt),
			stdout: "pipe",
			stderr: "pipe",
		});
		child = proc;
		liveChildren.add(proc);

		const timer = setTimeout(stop, timeoutMs);
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const [raw, errorText] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		liveChildren.delete(proc);
		clearTimeout(timer);

		const envelope = safeParse<ResultEnvelope>(raw);
		// A killed call still made the API request, so it still cost something.
		const costUsd = envelope?.total_cost_usd ?? (killed ? MIN_CALL_COST_USD : 0);
		recordSpend({ ts: Date.now(), label: opts.label ?? "unlabelled", model, costUsd, ok: !killed && envelope !== null });

		// Exit code alone is not enough and neither is `subtype`: an unauthenticated CLI exits 1
		// with is_error:true but still reports subtype:"success". is_error is the honest field.
		const ok = !killed && envelope !== null && envelope.is_error === false;
		if (ok) recordSuccess();
		else recordFailure();

		return {
			envelope,
			costUsd,
			text: ok ? envelope.result : null,
			subtype: envelope?.subtype ?? null,
			blocked: null,
			stderr: errorText.slice(-2048),
		};
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		releaseLock();
	}
}

function baseArgs(opts: AskOptions): string[] {
	// The per-call ceiling is clamped to what is left of today's budget, so the CLI itself
	// enforces the remainder instead of us discovering the overrun afterwards.
	const budget = Math.min(opts.maxCostUsd ?? DEFAULT_MAX_COST_USD, remainingBudgetUsd());
	const args = [
		"-p",
		"--output-format", "json",
		"--safe-mode",
		"--no-session-persistence",
		"--model", opts.model ?? loadConfig().llm.model,
		"--max-budget-usd", budget.toFixed(4),
	];
	// Read is required for images and forbidden otherwise — an unconstrained tool set is
	// how an LLM ends up editing the user's notes.
	args.push("--tools", opts.images?.length ? "Read" : "");
	if (opts.images?.length) args.push("--allowedTools", "Read");
	return args;
}

/**
 * Serialization point with a queue we can actually empty. Concurrent callers wait rather
 * than fan out: these calls are billed, and a reorganize pass over a large vault would
 * otherwise open dozens of subscription-rate-limited sessions at once.
 */
interface QueuedJob {
	run: () => Promise<unknown>;
	settle: (value: unknown) => void;
	fail: (err: unknown) => void;
}

const queue: QueuedJob[] = [];
let draining = false;

function serialize<T>(job: () => Promise<T | null>): Promise<T | null> {
	return new Promise<T | null>((resolve, reject) => {
		queue.push({ run: job as () => Promise<unknown>, settle: resolve as (v: unknown) => void, fail: reject });
		void drain();
	});
}

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			try {
				next.settle(await next.run());
			} catch (err) {
				next.fail(err);
			}
		}
	} finally {
		draining = false;
	}
}

/**
 * Cancel every call that has not started yet. An AbortSignal only reaches the call in
 * flight, so without this, cancelling a batch still spawns and bills everything queued
 * behind it.
 */
/** Children still running, so shutdown can stop them rather than orphan them. */
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>();

/**
 * Kill any `claude` child still running. Called on shutdown: a vision or reorganize call
 * can be 90 s of billed work, and exiting without this leaves it orphaned — still running,
 * still billing the user, with its output going nowhere.
 */
export function killChildren(): number {
	let killed = 0;
	for (const child of liveChildren) {
		try {
			child.kill("SIGTERM");
			killed++;
		} catch {
			/* already gone */
		}
	}
	liveChildren.clear();
	return killed;
}

export function cancelAll(): number {
	const pending = queue.splice(0);
	for (const job of pending) job.settle(null);
	return pending.length;
}

/** Free-text answer, or null if the CLI is missing, unauthenticated, timed out or errored. */
export async function ask(prompt: string, opts: AskOptions = {}): Promise<string | null> {
	if (!(await isAvailable())) return null;
	return serialize(async () => {
		if (opts.signal?.aborted) return null;
		return (await invoke(prompt, baseArgs(opts), opts)).text;
	});
}

/**
 * Structured answer validated by the CLI's own `--json-schema`. Prefers the envelope's
 * parsed `structured_output` over re-parsing `result`, which is the same object as a string.
 * `schema` is a real JSON Schema object, not a prose hint — the CLI enforces it server-side,
 * so a caller gets either a conforming object or null.
 */
export async function askJson<T>(
	prompt: string,
	schema: Record<string, unknown>,
	opts: AskOptions = {},
): Promise<T | null> {
	if (!(await isAvailable())) return null;
	return serialize(async () => {
		if (opts.signal?.aborted) return null;
		const args = [...baseArgs(opts), "--json-schema", JSON.stringify(schema)];
		const { envelope, text } = await invoke(prompt, args, opts);
		if (!envelope || text === null) return null;
		return (envelope.structured_output as T | undefined) ?? safeParse<T>(text);
	});
}

/**
 * Describe an image. The failure mode this guards is uniquely bad: given a path the model
 * cannot actually open, it does not error — it returns a plausible description, or a polite
 * "the image is too large, could you resize it", with is_error:false. Either would be written
 * into the user's vault as a design description.
 *
 * Three checks, no stream parsing: the schema forces the model to declare whether it opened
 * the file, permission_denials proves no tool call was refused, and imageMeta() has already
 * rejected truncated or oversized files locally before a token is spent. Turn count is NOT a
 * check — --json-schema alone yields num_turns 2 with no file access, and a failed Read
 * yields polite prose with is_error:false, so it is wrong in both directions.
 *
 * `schema` must declare `viewed: boolean` as a required property.
 */
export async function describeImageJson<T extends { viewed: boolean }>(
	imagePath: string,
	instruction: string,
	schema: Record<string, unknown>,
	opts: AskOptions = {},
): Promise<T | null> {
	if (!(await isAvailable())) return null;

	const file = Bun.file(imagePath);
	if (!(await file.exists()) || file.size > MAX_IMAGE_BYTES) return null;
	const meta = imageMeta(new Uint8Array(await file.arrayBuffer()));
	if (!meta?.complete || meta.width > MAX_IMAGE_EDGE || meta.height > MAX_IMAGE_EDGE) return null;

	const options: AskOptions = { ...opts, images: [imagePath] };
	return serialize(async () => {
		if (options.signal?.aborted) return null;
		const args = [...baseArgs(options), "--json-schema", JSON.stringify(schema)];
		const { envelope, text } = await invoke(`Read the image file at ${imagePath}, then: ${instruction}`, args, options);
		if (!envelope || text === null) return null;
		if (envelope.permission_denials?.length) return null;
		const described = envelope.structured_output as T | undefined;
		if (!described || described.viewed !== true) return null;
		return described;
	});
}
