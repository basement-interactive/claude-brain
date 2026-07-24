// User configuration: XDG-placed JSON, mutable at runtime (the settings UI edits it).
// The vault path is unset until the user picks one — every consumer must tolerate null.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SyncProvider = "dropbox" | "gdrive" | "mega";

export interface SyncConfig {
	provider: SyncProvider | null;
	enabled: boolean;
	intervalMinutes: number;
	remoteFolder: string;
}

export interface BrainConfig {
	vault: string | null;
	port: number;
	sync: SyncConfig;
}

const XDG_CONFIG = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const XDG_DATA = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const XDG_CACHE = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const XDG_STATE = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

export const CONFIG_DIR = join(XDG_CONFIG, "claude-brain");
export const DATA_DIR = join(XDG_DATA, "claude-brain");
export const CACHE_DIR = join(XDG_CACHE, "claude-brain");
export const STATE_DIR = join(XDG_STATE, "claude-brain");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export const DEFAULT_PORT = 6868;

const DEFAULTS: BrainConfig = {
	vault: null,
	port: DEFAULT_PORT,
	sync: { provider: null, enabled: false, intervalMinutes: 30, remoteFolder: "ClaudeBrain" },
};

let current: BrainConfig | null = null;

export function loadConfig(): BrainConfig {
	if (current) return current;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<BrainConfig>;
		current = {
			...DEFAULTS,
			...raw,
			sync: { ...DEFAULTS.sync, ...(raw.sync ?? {}) },
		};
	} catch {
		current = structuredClone(DEFAULTS);
	}
	return current;
}

export async function saveConfig(patch: Partial<BrainConfig>): Promise<BrainConfig> {
	const merged: BrainConfig = {
		...loadConfig(),
		...patch,
		sync: { ...loadConfig().sync, ...(patch.sync ?? {}) },
	};
	mkdirSync(CONFIG_DIR, { recursive: true });
	await Bun.write(CONFIG_PATH, `${JSON.stringify(merged, null, "\t")}\n`);
	current = merged;
	return merged;
}

export function vaultRoot(): string | null {
	return loadConfig().vault;
}

/** A usable vault is a mounted, readable directory. */
export function vaultReady(): boolean {
	const root = vaultRoot();
	if (!root) return false;
	try {
		return statSync(root).isDirectory();
	} catch {
		return false;
	}
}

export function ensureDirs(): void {
	for (const dir of [CONFIG_DIR, DATA_DIR, CACHE_DIR, STATE_DIR]) {
		mkdirSync(dir, { recursive: true });
	}
}

/** Directory names never scanned for notes inside a vault. */
export const IGNORED_DIR_NAMES = new Set([
	".obsidian",
	".claude",
	".claudian",
	".git",
	".DS_Store",
	"graphify-out",
	"node_modules",
	"Trash",
	".trash",
	".stfolder",
	".stversions",
]);

/** Best-effort scan for Obsidian vaults (dirs containing .obsidian) to offer as picks. */
export function detectVaults(): string[] {
	const found: string[] = [];
	const roots = [homedir(), join(homedir(), "Documents"), join(homedir(), "Notes")];
	const seen = new Set<string>();
	const scan = (dir: string, depth: number) => {
		if (depth > 2 || seen.has(dir)) return;
		seen.add(dir);
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		if (entries.includes(".obsidian")) {
			found.push(dir);
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || IGNORED_DIR_NAMES.has(entry)) continue;
			const full = join(dir, entry);
			try {
				if (statSync(full).isDirectory()) scan(full, depth + 1);
			} catch {
				/* unreadable — skip */
			}
		}
	};
	for (const root of roots) if (existsSync(root)) scan(root, 0);
	return found.slice(0, 20);
}
