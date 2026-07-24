#!/usr/bin/env bun
// claude-brain — a local second brain for Claude Code.
//   claude-brain                       start the server (if needed) and open the UI
//   claude-brain recall "<query>" [k]  hybrid search over the vault
//   claude-brain note "<text>"         capture a thought into the vault inbox
//   claude-brain vault <path>          select the vault directory
//   claude-brain sync setup <provider> connect dropbox | gdrive | mega (interactive)
//   claude-brain sync now              run one sync pass
//   claude-brain integrate [--remove]  wire into / unwire from Claude Code
//   claude-brain context               tiny digest for the SessionStart hook
//   claude-brain status                index + sync + integration state
//   claude-brain serve                 run the server in the foreground

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";

const cfg = loadConfig();
const BASE = `http://localhost:${cfg.port}`;

async function api(path: string, init?: RequestInit): Promise<Response | null> {
	try {
		const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000), ...init });
		return res.ok ? res : null;
	} catch {
		return null;
	}
}

async function serverUp(): Promise<boolean> {
	return (await api("/api/status")) !== null;
}

async function ensureServer(): Promise<void> {
	if (await serverUp()) return;
	const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	proc.unref();
	for (let i = 0; i < 40; i++) {
		await Bun.sleep(250);
		if (await serverUp()) return;
	}
	console.error("server failed to start — try `claude-brain serve` to see why");
	process.exit(1);
}

async function cmdOpen(): Promise<void> {
	await ensureServer();
	Bun.spawn(["xdg-open", BASE], { stdout: "ignore", stderr: "ignore" }).unref();
	console.log(`brain open at ${BASE}`);
}

/**
 * Claude Code exports the live session as CLAUDE_CODE_SESSION_ID. Passing it lets the
 * brain treat a session as one context: episodes are filed against the right session,
 * and a note already shown this session is not sent twice.
 */
function sessionIdFromEnv(): string | undefined {
	return process.env.CLAUDE_CODE_SESSION_ID || undefined;
}

function postJson(path: string, body: unknown): Promise<Response | null> {
	return api(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function cmdRecall(rest: string[]): Promise<void> {
	let prefix: string | undefined;
	const pIdx = rest.indexOf("-p");
	if (pIdx !== -1) prefix = rest.splice(pIdx, 2)[1];
	let episodes: string | undefined;
	const eIdx = rest.indexOf("-e");
	if (eIdx !== -1) episodes = rest.splice(eIdx, 2)[1];
	// Snippets are trimmed to the answering lines; --full restores whole sections.
	const fullIdx = rest.indexOf("--full");
	const full = fullIdx !== -1;
	if (full) rest.splice(fullIdx, 1);
	let k = 6;
	if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1] ?? "")) k = Number(rest.pop());
	const query = rest.join(" ").trim();
	if (!query) {
		console.error('claude-brain recall "<query>" [k] [-p <folder>] [-e <episodes>] [--full]');
		process.exit(1);
	}
	const params = new URLSearchParams({ q: query, k: String(k), format: "md" });
	if (prefix) params.set("p", prefix);
	if (episodes !== undefined) params.set("episodes", episodes);
	if (full) params.set("full", "1");
	const session = sessionIdFromEnv();
	if (session) params.set("session", session);
	const res = await api(`/api/recall?${params}`);
	if (res) {
		console.log(await res.text());
		return;
	}
	const { recallMarkdownStandalone } = await import("../src/recall");
	console.log(await recallMarkdownStandalone(query, { k, pathPrefix: prefix, full }));
}

/**
 * Durable episodic capture — a decision or preference worth surviving the session but
 * not structured enough to deserve a note. Higher salience, so consolidation keeps it
 * when the surrounding chatter is forgotten.
 */
async function cmdRemember(rest: string[]): Promise<void> {
	let kind = "decision";
	const kIdx = rest.indexOf("-k");
	if (kIdx !== -1) kind = rest.splice(kIdx, 2)[1] ?? "decision";
	const text = rest.join(" ").trim();
	if (!text) {
		console.error('claude-brain remember "<text>" [-k decision|preference|outcome]');
		process.exit(1);
	}
	await ensureServer();
	await postJson("/api/episode", {
		sessionId: sessionIdFromEnv() ?? "manual",
		cwd: process.cwd(),
		kind,
		text,
		salience: 2,
	});
	console.log(`remembered (${kind}): ${text.slice(0, 80)}`);
}

/** Graph verbs. All resolve their arguments through recall, so plain English works. */
async function cmdGraph(verb: string, rest: string[]): Promise<void> {
	const params = new URLSearchParams();
	if (verb === "path") {
		const [from, to] = [rest[0] ?? "", rest[1] ?? ""];
		if (!from || !to) {
			console.error('claude-brain path "<from>" "<to>"');
			process.exit(1);
		}
		params.set("from", from);
		params.set("to", to);
	} else if (verb !== "map") {
		const query = rest.filter((a) => !a.startsWith("-")).join(" ").trim();
		if (!query) {
			console.error(`claude-brain ${verb} "<note>"`);
			process.exit(1);
		}
		params.set("q", query);
		const depth = rest.indexOf("-d");
		if (depth !== -1) params.set("depth", rest[depth + 1] ?? "2");
	}
	await ensureServer();
	const res = await api(`/api/graph/${verb}?${params}`);
	if (!res) {
		console.error("claude-brain: graph verbs need the server — try `claude-brain serve`");
		process.exit(1);
	}
	console.log((await res.text()).trimEnd());
}

function flag(rest: string[], name: string): boolean {
	const i = rest.indexOf(name);
	if (i === -1) return false;
	rest.splice(i, 1);
	return true;
}

function option(rest: string[], name: string): string | undefined {
	const i = rest.indexOf(name);
	return i === -1 ? undefined : rest.splice(i, 2)[1];
}

/** y/N on a TTY; off a TTY the caller must have passed --yes, so this returns false. */
async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	process.stdout.write(`${question} [y/N] `);
	for await (const line of console) return /^y(es)?$/i.test(line.trim());
	return false;
}

/**
 * Reorganize the vault into a topical folder structure, using the user's own Claude CLI
 * for the categorisation. Planning is free of consequence — it writes a run directory and
 * moves nothing. Only `--apply` touches the vault, and `--undo` puts it back.
 */
async function cmdReorganize(rest: string[]): Promise<void> {
	const { buildInventory, DEFAULT_MAX_NOTES } = await import("../src/reorganize-inventory");
	const { createPlan, estimateCost, loadPlan, previewPrompts, renderPlan } = await import("../src/reorganize-plan");
	const { applyPlan, listRuns, undoRun } = await import("../src/reorganize-apply");

	if (flag(rest, "--list")) {
		const runs = listRuns();
		if (runs.length === 0) console.log("no reorganize runs yet");
		for (const run of runs) console.log(JSON.stringify(run));
		return;
	}

	if (flag(rest, "--undo")) {
		const result = await undoRun(rest[0]);
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	const yes = flag(rest, "--yes");
	const noReindex = flag(rest, "--no-reindex");

	if (flag(rest, "--apply")) {
		const loaded = loadPlan(option(rest, "--plan"));
		if (!loaded) {
			console.error("no plan found — run `claude-brain reorganize` first");
			process.exit(1);
		}
		const selected = loaded.plan.moves.filter((m) => m.selected).length;
		console.log(`plan ${loaded.plan.runId}: ${selected} move(s) from ${loaded.path}`);
		if (!yes && !(await confirm(`Move ${selected} note(s)?`))) {
			console.error("aborted — pass --yes to apply without a prompt");
			process.exit(1);
		}
		const result = await applyPlan(loaded.plan, {
			reindex: !noReindex,
			onProgress: (m) => console.log(m),
		});
		console.log(JSON.stringify({ ...result, skipped: result.skipped.length }, null, 2));
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	const inv = buildInventory({
		scope: option(rest, "--scope"),
		max: Number(option(rest, "--max") ?? DEFAULT_MAX_NOTES) || DEFAULT_MAX_NOTES,
		includeRoot: flag(rest, "--include-root"),
		freeze: (option(rest, "--freeze") ?? "").split(",").filter(Boolean),
	});
	if (!inv.ok) {
		console.error(inv.message);
		process.exit(1);
	}

	const opts = {
		batch: Number(option(rest, "--batch") ?? "") || undefined,
		folders: Number(option(rest, "--folders") ?? "") || undefined,
		model: option(rest, "--model") as "haiku" | "sonnet" | "opus" | undefined,
		taxonomyFile: option(rest, "--taxonomy"),
		allowChurn: flag(rest, "--allow-churn"),
		onProgress: (m: string) => console.log(m),
	};

	// Free auditability: exactly what would be sent to the user's own CLI, without
	// sending it. Worth having when the input is somebody's private notes.
	if (flag(rest, "--dry-prompt")) {
		for (const prompt of previewPrompts(inv.inventory, opts)) console.log(`${prompt}\n${"-".repeat(72)}`);
		return;
	}

	const cost = estimateCost(inv.inventory, opts);
	console.log(`${inv.inventory.notes.length} candidate note(s), estimated ${cost.calls} call(s) ≈ $${cost.usd.toFixed(3)}`);
	if (!yes && !(await confirm("Send titles, tags and note openings to your Claude CLI?"))) {
		console.error("aborted — pass --yes to plan without a prompt");
		process.exit(1);
	}

	const planned = await createPlan(inv.inventory, opts);
	if (!planned.ok) {
		console.error(planned.message);
		process.exit(1);
	}
	console.log(renderPlan(planned.plan));
	console.log(`\nplan written to ${planned.planPath}`);
	console.log(`apply with:  claude-brain reorganize --apply --plan ${planned.plan.runId}`);
}

/** The design library: what the brain remembers about designs the user liked. */
async function cmdDesign(rest: string[]): Promise<void> {
	const store = await import("../src/design-store");
	const sub = rest.shift() ?? "list";

	if (sub === "list") {
		const rows = store.listDesigns({ all: flag(rest, "--all") });
		if (rows.length === 0) console.log("no designs yet — upload one in the dashboard, or `claude-brain design add <path>`");
		for (const row of rows) {
			console.log(`${row.id}  ${row.status.padEnd(12)}  ${row.name || row.source_name}${row.note_path ? `  -> ${row.note_path}` : ""}`);
		}
		return;
	}

	if (sub === "add") {
		const caption = option(rest, "--caption");
		const { enqueueDesign } = await import("../src/design-extract");
		for (const path of rest) {
			const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
			const result = await store.saveDesign({ bytes, sourceName: path.split("/").pop() ?? path, caption });
			if (!result.ok) {
				console.error(`${path}: ${result.reason}`);
				process.exitCode = 1;
				continue;
			}
			if (result.fresh || result.requeued) enqueueDesign(result.row.id);
			console.log(`${result.row.id}  ${result.fresh ? "added" : result.requeued ? "re-queued" : "already known"}  ${path}`);
		}
		return;
	}

	// Everything below addresses one design, by id or by description.
	const query = rest.filter((a) => !a.startsWith("-")).join(" ").trim();
	const row = store.validId(query) ? store.getDesign(query) : (store.findDesigns(query, 1)[0] ?? null);
	if (!row) {
		console.error(query ? `no design matches: ${query}` : `claude-brain design ${sub} "<id or description>"`);
		process.exit(1);
	}

	if (sub === "show") {
		const { designBrief } = await import("../src/design-note");
		console.log(designBrief([row]));
		// The escape hatch: the brief gets an agent most of the way, and it can Read the
		// image itself for whatever the words did not carry.
		console.log(`\nimage: ${store.imagePath(row)}`);
		if (row.note_path) console.log(`note:  ${row.note_path}`);
		return;
	}
	if (sub === "retry") {
		const { retryExtraction } = await import("../src/design-extract");
		console.log(retryExtraction(row.id) ? `re-queued ${row.id}` : `could not re-queue ${row.id}`);
		return;
	}
	if (sub === "restore") {
		const { restoreDesignNote } = await import("../src/design-extract");
		const result = restoreDesignNote(row.id);
		console.log(result.detail);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	if (sub === "forget") {
		const trashNote = flag(rest, "--trash-note");
		const confirmed = flag(rest, "--yes");
		const plan = store.forgetDesign(row.id, { confirm: confirmed, trashNote });
		console.log(JSON.stringify(plan, null, 2));
		if (!confirmed) console.log("\ndry run — repeat with --yes to actually free the bytes");
		return;
	}
	console.error(`unknown: design ${sub}`);
	process.exit(1);
}

async function cmdConsolidate(rest: string[]): Promise<void> {
	const days = Number(rest[0] ?? "30") || 30;
	const res = await postJson(`/api/consolidate?days=${days}`, {});
	if (!res) {
		const { consolidate } = await import("../src/consolidate");
		console.log(JSON.stringify(consolidate(days), null, 2));
		return;
	}
	console.log(JSON.stringify(await res.json(), null, 2));
}

interface HookPayload {
	session_id?: string;
	cwd?: string;
	prompt?: string;
}

/**
 * Hook entrypoints, reading Claude Code's JSON on stdin. Every one fails silently and
 * exits 0 — a brain that can break the session it is trying to help is a liability.
 */
async function cmdHook(event: string): Promise<void> {
	let payload: HookPayload = {};
	try {
		const raw = await Bun.stdin.text();
		if (raw.trim()) payload = JSON.parse(raw) as HookPayload;
	} catch {
		/* no payload — fall back to the environment */
	}
	const sessionId = payload.session_id ?? sessionIdFromEnv() ?? "";
	const cwd = payload.cwd ?? process.cwd();
	if (!sessionId) return;

	if (event === "session-start") {
		const res = await postJson("/api/session/start", { sessionId, cwd });
		if (res) console.log((await res.text()).trim());
		return;
	}
	if (event === "prompt") {
		const res = await postJson("/api/session/prompt", { sessionId, cwd, prompt: payload.prompt ?? "" });
		const text = res ? (await res.text()).trim() : "";
		if (text) console.log(text);
		return;
	}
	if (event === "session-end") {
		const res = await postJson("/api/session/end", { sessionId, cwd });
		if (!res) return;
		const report = (await res.json()) as { captured: number; proposals: string[] };
		console.error(`[brain] captured ${report.captured} episodes from this session`);
		for (const p of report.proposals) console.error(`[brain] recurring — ${p}`);
	}
}

async function cmdNote(rest: string[]): Promise<void> {
	// Optional folder: `claude-brain note -f rust "text"` files under `<vault>/rust/`.
	let folder = "Inbox";
	const fIdx = rest.indexOf("-f");
	if (fIdx !== -1) folder = rest.splice(fIdx, 2)[1] ?? "Inbox";
	const text = rest.join(" ").trim();
	if (!text) {
		console.error('claude-brain note "<text>" [-f <subfolder>]');
		process.exit(1);
	}
	const { vaultReady, vaultRoot } = await import("../src/config");
	const root = vaultRoot();
	if (!root || !vaultReady()) {
		console.error("no vault selected — run `claude-brain` and pick one in Settings");
		process.exit(1);
	}
	const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
	const dir = join(root, folder.replace(/^\/+|\.\./g, ""));
	mkdirSync(dir, { recursive: true });
	let path = join(dir, `${stamp}.md`);
	for (let i = 2; existsSync(path); i++) path = join(dir, `${stamp} (${i}).md`);
	await Bun.write(path, `# Inbox ${stamp}\n\n${text}\n`);
	console.log(`captured: ${path}`);
	await api("/api/reindex", { method: "POST" });
}

async function cmdVault(rest: string[]): Promise<void> {
	const path = rest[0] ? resolve(rest[0]) : null;
	if (!path) {
		console.error("claude-brain vault <path>");
		process.exit(1);
	}
	await ensureServer();
	const res = await api("/api/config", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vault: path }),
	});
	if (!res) {
		console.error("vault rejected — is it a readable directory?");
		process.exit(1);
	}
	console.log(`vault set: ${path}`);
	console.log(JSON.stringify(await res.json()));
}

async function cmdSync(rest: string[]): Promise<void> {
	const sub = rest[0];
	if (sub === "setup") {
		const provider = rest[1];
		if (provider !== "dropbox" && provider !== "gdrive" && provider !== "mega") {
			console.error("claude-brain sync setup <dropbox|gdrive|mega>");
			process.exit(1);
		}
		const { setupRemoteInteractive, configureSync } = await import("../src/sync");
		const code = await setupRemoteInteractive(provider);
		if (code === 0) {
			await configureSync({ provider, enabled: true });
			console.log(`${provider} connected — auto-sync enabled. Toggle in the UI or config.json.`);
		}
		process.exit(code);
	}
	if (sub === "now") {
		await ensureServer();
		await api("/api/sync/now", { method: "POST" });
		console.log("sync started — `claude-brain status` shows the result");
		return;
	}
	console.error("claude-brain sync <setup|now>");
	process.exit(1);
}

async function cmdIntegrate(rest: string[]): Promise<void> {
	const mod = await import("../src/integrate");
	const status = rest[0] === "--remove" ? await mod.unintegrate() : await mod.integrate();
	console.log(JSON.stringify(status));
	if (rest[0] !== "--remove") {
		console.log("Claude Code wired: recall-first instructions, SessionStart hook, recording skill.");
	}
}

async function cmdContext(): Promise<void> {
	const { contextDigest } = await import("../src/integrate");
	console.log(await contextDigest());
}

async function cmdStatus(): Promise<void> {
	const res = await api("/api/status");
	if (res) {
		console.log(JSON.stringify(await res.json(), null, 2));
		return;
	}
	const { indexStatus } = await import("../src/hybrid-search");
	console.log(JSON.stringify({ index: indexStatus(), server: "down" }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
	case undefined:
	case "open":
		await cmdOpen();
		break;
	case "serve":
		await import("../server.ts");
		break;
	case "recall":
	case "search":
		await cmdRecall(rest);
		break;
	case "note":
		await cmdNote(rest);
		break;
	case "remember":
		await cmdRemember(rest);
		break;
	case "path":
	case "explain":
	case "affected":
	case "map":
		await cmdGraph(cmd, rest);
		break;
	case "reorganize":
		await cmdReorganize(rest);
		break;
	case "design":
		await cmdDesign(rest);
		break;
	case "consolidate":
		await cmdConsolidate(rest);
		break;
	case "hook":
		await cmdHook(rest[0] ?? "");
		break;
	case "vault":
		await cmdVault(rest);
		break;
	case "sync":
		await cmdSync(rest);
		break;
	case "integrate":
		await cmdIntegrate(rest);
		break;
	case "context":
		await cmdContext();
		break;
	case "status":
		await cmdStatus();
		break;
	case "reindex":
		console.log(JSON.stringify(await (await import("../src/indexer")).reindex()));
		break;
	default:
		console.log(`usage:
  claude-brain                       open the brain UI

 recall
  claude-brain recall "<query>" [k] [-p <folder>] [-e <n>] [--full]
                                     search notes and past sessions
  claude-brain note "<text>" [-f <subfolder>]      quick-capture (default Inbox/)
  claude-brain remember "<text>" [-k decision|preference|outcome]
                                     store a durable fact in episodic memory

 structure
  claude-brain path "<from>" "<to>"  how two notes connect
  claude-brain explain "<note>"      a note and everything around it
  claude-brain affected "<note>" [-d N]   what points at it, transitively
  claude-brain map                   the vault as named clusters

 designs — reference images the brain can describe back to you
  claude-brain design list [--all]
  claude-brain design add <path…> [--caption "…"]
  claude-brain design show "<id or description>"   the description, then the image path
  claude-brain design retry|restore|forget "<id or description>"

 reorganize — tidy the vault into topical folders (uses your own claude CLI)
  claude-brain reorganize [--scope <folder>] [--max n] [--dry-prompt] [--yes]
                                     plans only; writes a plan file, moves nothing
  claude-brain reorganize --apply [--plan <run-id>] [--yes]
  claude-brain reorganize --undo [<run-id>]
  claude-brain reorganize --list

 upkeep
  claude-brain vault <path>          choose where your brain lives
  claude-brain sync setup <provider> connect dropbox | gdrive | mega
  claude-brain sync now              sync to the cloud now
  claude-brain integrate [--remove]  wire into Claude Code
  claude-brain consolidate [days]    mine session logs, abstract, forget
  claude-brain status | reindex | serve | context`);
		process.exit(cmd ? 1 : 0);
}
