// Vault file watcher: debounced incremental reindex on any change. Survives vault
// unmount/switch by polling for the directory until it is usable again.

import { watch, type FSWatcher } from "node:fs";
import { IGNORED_DIR_NAMES, reorganizeLockHeld, vaultReady, vaultRoot } from "./config";
import { reindex } from "./indexer";
import { scheduleChangeSync } from "./sync";

const DEBOUNCE_MS = 1_500;
const RETRY_POLL_MS = 30_000;
/** How often to re-check while a reorganize holds the lock. */
const LOCKED_POLL_MS = 5_000;

let watcher: FSWatcher | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

// Only filter by directory — editors write via tmp-file + rename, so gating on a .md
// suffix can miss the event that actually carries the content. A no-op incremental
// reindex is a few ms of stat calls; false positives are cheaper than missed updates.
function relevant(filename: string | null): boolean {
	if (!filename) return true;
	return !filename.split("/").some((p) => IGNORED_DIR_NAMES.has(p));
}

let waitingOnReorganize = false;

function scheduleReindex(delayMs = DEBOUNCE_MS): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		// An apply pass emits thousands of events and rewrites paths as it goes; indexing
		// the half-moved vault is pure churn, so wait it out rather than drop the events.
		if (reorganizeLockHeld()) {
			if (!waitingOnReorganize) {
				waitingOnReorganize = true;
				console.log("[watch] reorganize in progress — indexing paused");
			}
			scheduleReindex(LOCKED_POLL_MS);
			return;
		}
		waitingOnReorganize = false;
		void reindex().then((s) => {
			if (s.indexed || s.updated || s.removed || s.moved) {
				console.log(
					`[watch] reindexed: +${s.indexed} ~${s.updated} -${s.removed} →${s.moved} (${s.docs} docs, ${s.chunks} chunks)`,
				);
				scheduleChangeSync();
			}
		});
	}, delayMs);
}

export function startWatcher(): void {
	if (watcher) return;
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	const root = vaultRoot();
	if (!root || !vaultReady()) {
		retryTimer = setTimeout(startWatcher, RETRY_POLL_MS);
		return;
	}
	try {
		watcher = watch(root, { recursive: true }, (_event, filename) => {
			if (relevant(filename)) scheduleReindex();
		});
		watcher.on("error", (err) => {
			console.warn(`[watch] error, restarting: ${err}`);
			stopWatcher();
			retryTimer = setTimeout(startWatcher, RETRY_POLL_MS);
		});
		console.log(`[watch] watching ${root}`);
		scheduleReindex();
	} catch (err) {
		console.warn(`[watch] failed to start: ${err}`);
		retryTimer = setTimeout(startWatcher, RETRY_POLL_MS);
	}
}

export function stopWatcher(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	watcher?.close();
	watcher = null;
}

/** Called after the user switches vaults: re-attach the watcher to the new root. */
export function restartWatcher(): void {
	stopWatcher();
	startWatcher();
}
