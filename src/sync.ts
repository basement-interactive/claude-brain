// Cloud sync via rclone: one-way mirror vault → remote (local is the source of
// truth), with a dated backup dir so remote deletions are recoverable. Providers:
// Dropbox, Google Drive, MEGA. Interactive auth happens in the user's terminal
// through `claude-brain sync setup <provider>`; the server only runs non-interactive
// sync passes.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	STATE_DIR,
	loadConfig,
	reorganizeLockHeld,
	saveConfig,
	vaultReady,
	vaultRoot,
	type SyncProvider,
} from "./config";

export const RCLONE_TYPES: Record<SyncProvider, string> = {
	dropbox: "dropbox",
	gdrive: "drive",
	mega: "mega",
};

const LOG_PATH = join(STATE_DIR, "sync.log");
const CHANGE_SYNC_DELAY_MS = 5 * 60_000;

export interface SyncStatus {
	provider: SyncProvider | null;
	enabled: boolean;
	remoteConfigured: boolean;
	lastSync: string | null;
	lastResult: "ok" | "error" | null;
	running: boolean;
	log: string[];
}

const state = {
	lastSync: null as string | null,
	lastResult: null as "ok" | "error" | null,
	running: false,
	recentLog: [] as string[],
};

let intervalTimer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

function remoteName(provider: SyncProvider): string {
	return `claude-brain-${provider}`;
}

function log(line: string): void {
	const stamped = `${new Date().toISOString()} ${line}`;
	state.recentLog.push(stamped);
	if (state.recentLog.length > 50) state.recentLog.shift();
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		appendFileSync(LOG_PATH, `${stamped}\n`);
	} catch {
		/* logging is best-effort */
	}
}

async function rclone(args: string[]): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(["rclone", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { ok: code === 0, output: (stdout + stderr).trim() };
}

export async function remoteConfigured(provider: SyncProvider): Promise<boolean> {
	const { ok, output } = await rclone(["listremotes"]);
	return ok && output.includes(`${remoteName(provider)}:`);
}

/** Run one sync pass now. Serialized; concurrent calls are ignored while running. */
export async function syncNow(reason: string): Promise<boolean> {
	const cfg = loadConfig();
	const provider = cfg.sync.provider;
	if (!provider || state.running) return false;
	const root = vaultRoot();
	if (!root || !vaultReady()) {
		log(`skip (${reason}): vault not available`);
		return false;
	}
	// Every move is a delete plus an upload to rclone. Mirroring a half-moved vault
	// pushes thousands of now-stale paths into the dated remote trash for nothing.
	if (reorganizeLockHeld()) {
		log(`skip (${reason}): reorganize in progress`);
		return false;
	}
	if (!(await remoteConfigured(provider))) {
		log(`skip (${reason}): rclone remote missing — run \`claude-brain sync setup ${provider}\``);
		return false;
	}

	state.running = true;
	log(`sync start (${reason}) → ${provider}:${cfg.sync.remoteFolder}`);
	try {
		const remote = `${remoteName(provider)}:${cfg.sync.remoteFolder}`;
		const backup = `${remoteName(provider)}:${cfg.sync.remoteFolder}-trash/${new Date().toISOString().slice(0, 10)}`;
		const { ok, output } = await rclone([
			"sync",
			root,
			remote,
			"--backup-dir",
			backup,
			"--exclude", ".obsidian/**",
			"--exclude", ".git/**",
			"--exclude", "node_modules/**",
			"--exclude", ".trash/**",
			"--fast-list",
			"--transfers", "8",
		]);
		state.lastSync = new Date().toISOString();
		state.lastResult = ok ? "ok" : "error";
		log(ok ? "sync ok" : `sync FAILED: ${output.slice(-400)}`);
		return ok;
	} finally {
		state.running = false;
	}
}

/** Debounced sync after vault changes, so edits reach the cloud without a manual step. */
export function scheduleChangeSync(): void {
	const cfg = loadConfig();
	if (!cfg.sync.enabled || !cfg.sync.provider) return;
	if (changeTimer) clearTimeout(changeTimer);
	changeTimer = setTimeout(() => {
		changeTimer = null;
		void syncNow("vault changed");
	}, CHANGE_SYNC_DELAY_MS);
}

export function startSyncSchedule(): void {
	if (intervalTimer) clearInterval(intervalTimer);
	const cfg = loadConfig();
	if (!cfg.sync.enabled || !cfg.sync.provider) return;
	const ms = Math.max(cfg.sync.intervalMinutes, 5) * 60_000;
	intervalTimer = setInterval(() => void syncNow("interval"), ms);
	log(`schedule: every ${Math.max(cfg.sync.intervalMinutes, 5)} min`);
}

export async function configureSync(patch: {
	provider?: SyncProvider | null;
	enabled?: boolean;
	intervalMinutes?: number;
	remoteFolder?: string;
}): Promise<void> {
	const cfg = loadConfig();
	await saveConfig({ sync: { ...cfg.sync, ...patch } });
	startSyncSchedule();
}

export async function syncStatus(): Promise<SyncStatus> {
	const cfg = loadConfig();
	return {
		provider: cfg.sync.provider,
		enabled: cfg.sync.enabled,
		remoteConfigured: cfg.sync.provider ? await remoteConfigured(cfg.sync.provider) : false,
		lastSync: state.lastSync,
		lastResult: state.lastResult,
		running: state.running,
		log: state.recentLog.slice(-10),
	};
}

/**
 * Interactive remote creation — must run in a real terminal (OAuth browser flow for
 * Dropbox/Drive, credential prompts for MEGA). Called by the CLI, never the server.
 */
export async function setupRemoteInteractive(provider: SyncProvider): Promise<number> {
	const proc = Bun.spawn(
		["rclone", "config", "create", remoteName(provider), RCLONE_TYPES[provider]],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
	return proc.exited;
}
