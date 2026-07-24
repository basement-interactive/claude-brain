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

async function cmdRecall(rest: string[]): Promise<void> {
	let prefix: string | undefined;
	const pIdx = rest.indexOf("-p");
	if (pIdx !== -1) prefix = rest.splice(pIdx, 2)[1];
	let k = 6;
	if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1] ?? "")) k = Number(rest.pop());
	const query = rest.join(" ").trim();
	if (!query) {
		console.error('claude-brain recall "<query>" [k] [-p <folder-prefix>]');
		process.exit(1);
	}
	const pArg = prefix ? `&p=${encodeURIComponent(prefix)}` : "";
	const res = await api(`/api/recall?q=${encodeURIComponent(query)}&k=${k}&format=md${pArg}`);
	if (res) {
		console.log(await res.text());
		return;
	}
	const { recallMarkdownStandalone } = await import("../src/recall");
	console.log(await recallMarkdownStandalone(query, k));
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
  claude-brain recall "<query>" [k] [-p <folder>]  search your vault (folder-scoped with -p)
  claude-brain note "<text>" [-f <subfolder>]      quick-capture (default Inbox/)
  claude-brain vault <path>          choose where your brain lives
  claude-brain sync setup <provider> connect dropbox | gdrive | mega
  claude-brain sync now              sync to the cloud now
  claude-brain integrate [--remove]  wire into Claude Code
  claude-brain status | reindex | serve | context`);
		process.exit(cmd ? 1 : 0);
}
