// User configuration: XDG-placed JSON, mutable at runtime (the settings UI edits it).
// The vault path is unset until the user picks one — every consumer must tolerate null.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SyncProvider = "dropbox" | "gdrive" | "mega";

export interface SyncConfig {
	provider: SyncProvider | null;
	enabled: boolean;
	intervalMinutes: number;
	remoteFolder: string;
}

export interface LlmConfig {
	/** Master consent switch. Nothing in claude-brain spends the user's Claude quota
	 *  until this is on — it ships to strangers who did not ask to be billed. */
	enabled: boolean;
	model: "haiku" | "sonnet" | "opus";
	dailyBudgetUsd: number;
	/** Escape hatch when the binary is somewhere Bun.which cannot see. */
	binaryPath: string | null;
}

export interface DesignsConfig {
	folder: string;
	autoExtract: boolean;
	copyImages: boolean;
}

export interface BrainConfig {
	vault: string | null;
	port: number;
	sync: SyncConfig;
	llm: LlmConfig;
	designs: DesignsConfig;
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
	llm: { enabled: false, model: "haiku", dailyBudgetUsd: 2, binaryPath: null },
	designs: { folder: "Design Library", autoExtract: true, copyImages: true },
};

let current: BrainConfig | null = null;

// Sub-objects are merged key by key, never replaced: a config file written before a
// field existed, or a patch carrying one field, must not blank out the rest.
export function loadConfig(): BrainConfig {
	if (current) return current;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<BrainConfig>;
		current = {
			...DEFAULTS,
			...raw,
			sync: { ...DEFAULTS.sync, ...(raw.sync ?? {}) },
			llm: { ...DEFAULTS.llm, ...(raw.llm ?? {}) },
			designs: { ...DEFAULTS.designs, ...(raw.designs ?? {}) },
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
		llm: { ...loadConfig().llm, ...(patch.llm ?? {}) },
		designs: { ...loadConfig().designs, ...(patch.designs ?? {}) },
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

const IGNORED_DIR_LOWER = new Set([...IGNORED_DIR_NAMES].map((name) => name.toLowerCase()));

/** One folder level: must start alphanumeric, so `.obsidian`, `..` and `.` are out by construction. */
export const SAFE_FOLDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

/** Vault folders are at most two levels deep — deeper taxonomies are how a "tidy" pass
 *  ends up burying notes where nobody looks for them again. */
const MAX_FOLDER_DEPTH = 2;

/**
 * The single gate for any vault-relative folder claude-brain proposes to create or move
 * notes into — reorganize's taxonomy and designFolder() both go through here.
 *
 * Returns the normalised path, or null if the name is not one we are willing to write.
 * The rejections that matter: a segment in IGNORED_DIR_NAMES (a note moved into `Trash`
 * or `.obsidian` disappears from walkVault, so recall loses it while the file still
 * exists), and anything absolute or dot-prefixed (`.trash` is emptied by Obsidian itself).
 */
export function safeVaultFolder(rel: string): string | null {
	const trimmed = rel.trim();
	if (!trimmed || /^[\\/]/.test(trimmed)) return null;
	const segments = trimmed.split(/[\\/]+/);
	if (segments.length > MAX_FOLDER_DEPTH) return null;
	for (const segment of segments) {
		if (!SAFE_FOLDER_SEGMENT.test(segment)) return null;
		// A trailing space or dot survives on Linux but not on the other end of a sync.
		if (/[ .]$/.test(segment)) return null;
		if (IGNORED_DIR_LOWER.has(segment.toLowerCase())) return null;
	}
	return segments.join("/");
}

/** Configured design folder, sanitised. Falls back to the default rather than refusing,
 *  since an unusable value here would strand uploads with nowhere to land. */
export function designFolder(): string {
	const collapsed = loadConfig()
		.designs.folder.trim()
		.replace(/^[\\/]+|[\\/]+$/g, "")
		.split(/[\\/]+/)
		.slice(0, MAX_FOLDER_DEPTH)
		.join("/");
	return safeVaultFolder(collapsed) ?? DEFAULTS.designs.folder;
}

/**
 * The one lock file the watcher, the sync scheduler and `reorganize` agree on. It lives
 * here because config.ts owns STATE_DIR and is the only module all three already import.
 * Written by reorganize (JSON: `{ pid, startedAt }`), read-only for everyone else.
 */
export const REORGANIZE_LOCK = join(STATE_DIR, "reorganize.lock");

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the pid exists and belongs to someone else — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Liveness is decided by the pid, not by the lock's mtime: applying a few thousand moves
 * across a portable disk easily outlives any plausible staleness window, and reindexing
 * halfway through is exactly the churn the lock exists to prevent. A lock whose writer
 * died is deleted here so a crashed reorganize cannot freeze indexing forever.
 */
export function reorganizeLockHeld(): boolean {
	let raw: string;
	try {
		raw = readFileSync(REORGANIZE_LOCK, "utf-8");
	} catch {
		return false;
	}
	let pid = 0;
	try {
		pid = Number((JSON.parse(raw) as { pid?: unknown }).pid) || 0;
	} catch {
		/* unreadable lock: treat as stale */
	}
	if (pid && pidAlive(pid)) return true;
	try {
		unlinkSync(REORGANIZE_LOCK);
	} catch {
		/* someone else already cleaned it up */
	}
	return false;
}

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
