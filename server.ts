// claude-brain server: hybrid recall API + 3D graph UI + settings + cloud sync.

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	detectVaults,
	loadConfig,
	saveConfig,
	vaultReady,
	vaultRoot,
	type SyncProvider,
} from "./src/config";
import { killChildren, status as claudeStatus } from "./src/claude-cli";
import { consolidate } from "./src/consolidate";
import { enqueueDesign, restoreDesignNote, resumeExtractions, retryExtraction } from "./src/design-extract";
import {
	forgetDesign,
	getDesign,
	imagePath,
	listDesigns,
	MAX_DESIGN_BYTES,
	saveDesign,
	sweepPartFiles,
	thumbPath,
	validId,
} from "./src/design-store";
import { embedPendingEpisodes, recordEpisode } from "./src/episodic";
import { rebuildGraph } from "./src/graph";
import { buildGraph } from "./src/graph-builder";
import { renderAffected, renderExplain, renderMap, renderPath } from "./src/graph-render";
import { indexStatus } from "./src/hybrid-search";
import { openBrainDb, resetIndex } from "./src/index-db";
import { reindex } from "./src/indexer";
import { integrate, integrationStatus, unintegrate } from "./src/integrate";
import { recall, recallMarkdown } from "./src/recall";
import { digest, finishSession, prime } from "./src/session-memory";
import type { EpisodeKind } from "./src/transcript";
import { configureSync, startSyncSchedule, syncNow, syncStatus } from "./src/sync";
import { restartWatcher, startWatcher } from "./src/watcher";

const PORT = Number(process.env.PORT ?? loadConfig().port);
const PUBLIC_DIR = join(import.meta.dir, "public");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

const ALLOWED_ORIGINS = new Set([
	`http://localhost:${PORT}`,
	`http://127.0.0.1:${PORT}`,
	`http://[::1]:${PORT}`,
]);

/**
 * Every POST here writes into the user's vault, repoints the vault itself, or spends
 * their Claude quota. multipart/form-data and text/plain are CORS-simple, so no preflight
 * protects them: any page the user happens to be visiting can reach this port by guessing
 * it. Sec-Fetch-Site is sent by every current browser; the CLI's own fetch sends neither
 * header, which is why absent means allowed.
 */
function sameOrigin(req: Request): boolean {
	const site = req.headers.get("sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers.get("origin");
	return !origin || ALLOWED_ORIGINS.has(origin);
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function serveStatic(fileName: string): Response {
	const ext = fileName.slice(fileName.lastIndexOf("."));
	return new Response(Bun.file(join(PUBLIC_DIR, fileName)), {
		headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
	});
}

function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

async function fullStatus() {
	const cfg = loadConfig();
	const installed = readInstalledVersion();
	return {
		index: indexStatus(),
		vault: cfg.vault,
		vaultReady: vaultReady(),
		port: cfg.port,
		sync: await syncStatus(),
		integration: integrationStatus(),
		// The Settings tab tells people to "turn Claude on" — it needs to know both
		// whether they have (enabled) and whether it would work (the CLI probe).
		// status() short-circuits to reason "disabled" while enabled is false, so the
		// binary is only ever looked for after opting in.
		llm: await llmStatus(),
		// A package upgrade rewrites these files underneath the running process, and
		// systemd does not restart user services on upgrade. The old server then keeps
		// serving the NEW dashboard off disk, the new dashboard calls routes that
		// version has never heard of, and the user gets a bare "request failed (404)"
		// with nothing pointing at the cause — which is exactly how 0.3.0's design tab
		// looked to anyone who upgraded without restarting. RUNNING_VERSION is what
		// booted; re-reading package.json per request is what is installed now.
		version: RUNNING_VERSION,
		installedVersion: installed,
		stale: installed !== null && RUNNING_VERSION !== null && installed !== RUNNING_VERSION,
	};
}

const LLM_MODELS = ["haiku", "sonnet", "opus"] as const;

function readInstalledVersion(): string | null {
	try {
		const raw = readFileSync(join(import.meta.dir, "package.json"), "utf-8");
		return (JSON.parse(raw) as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

/** Read once, at process start — this is the code actually running. */
const RUNNING_VERSION = readInstalledVersion();

async function llmStatus() {
	const cfg = loadConfig();
	const probe = await claudeStatus();
	return {
		enabled: cfg.llm.enabled,
		model: cfg.llm.model,
		available: probe.available,
		reason: probe.reason ?? null,
		binary: probe.binary,
		account: probe.account ?? null,
		version: probe.version ?? null,
	};
}

function textResponse(text: string): Response {
	return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Traversal verbs. Arguments are resolved through recall, so plain English works. */
async function handleGraphVerb(verb: string, url: URL): Promise<Response> {
	const q = url.searchParams.get("q") ?? "";
	if (verb === "path") {
		const from = url.searchParams.get("from") ?? "";
		const to = url.searchParams.get("to") ?? "";
		if (!from || !to) return jsonResponse({ error: "missing from/to" }, 400);
		return textResponse(await renderPath(from, to));
	}
	if (verb === "map") return textResponse(renderMap(url.searchParams.has("examples")));
	if (verb === "rebuild") return jsonResponse(rebuildGraph());
	if (!q) return jsonResponse({ error: "missing q" }, 400);
	if (verb === "explain") return textResponse(await renderExplain(q));
	if (verb === "affected") {
		return textResponse(await renderAffected(q, Number(url.searchParams.get("depth") ?? "2") || 2));
	}
	return jsonResponse({ error: `unknown graph verb: ${verb}` }, 404);
}

/** Session lifecycle for the Claude Code hooks: start / prompt / end. */
async function handleSession(action: string, payload: unknown): Promise<Response> {
	const body = (payload ?? {}) as Record<string, unknown>;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	if (!sessionId) return jsonResponse({ error: "missing sessionId" }, 400);
	const cwd = typeof body.cwd === "string" ? body.cwd : "";

	if (action === "start") return textResponse(digest({ sessionId, cwd }));
	if (action === "prompt") {
		const prompt = typeof body.prompt === "string" ? body.prompt : "";
		return textResponse(await prime({ sessionId, cwd, prompt }));
	}
	if (action === "end") return jsonResponse(await finishSession(sessionId));
	return jsonResponse({ error: `unknown session action: ${action}` }, 404);
}

function blobResponse(path: string, mime: string): Response {
	const file = Bun.file(path);
	// Blobs are content-addressed by id, so a hit can be cached hard; the dashboard
	// re-fetches by id when the id changes.
	return new Response(file, {
		headers: { "content-type": mime, "cache-control": "private, max-age=31536000, immutable" },
	});
}

/**
 * Design library. The only endpoints in the package that accept a file upload, so the
 * size ceiling and the magic-byte check both live behind saveDesign() rather than being
 * re-implemented per caller.
 */
async function handleDesigns(url: URL, req: Request, post: boolean): Promise<Response> {
	const rest = url.pathname.slice("/api/designs".length).replace(/^\//, "");

	if (!rest) {
		if (!post) {
			const status = await claudeStatus();
			return jsonResponse({
				designs: listDesigns({ all: url.searchParams.has("all") }),
				llm: { available: status.available, reason: status.reason ?? null, enabled: loadConfig().llm.enabled },
			});
		}
		const form = await req.formData();
		const file = form.get("file");
		if (!(file instanceof Blob)) return jsonResponse({ ok: false, reason: "no-file" }, 400);
		if (file.size > MAX_DESIGN_BYTES) return jsonResponse({ ok: false, reason: "too-large" }, 413);

		type FormValue = Blob | string | null;
		const asBytes = async (v: FormValue) =>
			v instanceof Blob ? new Uint8Array(await v.arrayBuffer()) : undefined;
		const num = (v: FormValue) => (typeof v === "string" && v ? Number(v) || undefined : undefined);
		const result = await saveDesign({
			bytes: new Uint8Array(await file.arrayBuffer()),
			sourceName: (file instanceof File ? file.name : "") || String(form.get("sourceName") ?? "upload"),
			caption: typeof form.get("caption") === "string" ? String(form.get("caption")) : undefined,
			width: num(form.get("width")),
			height: num(form.get("height")),
			thumb: await asBytes(form.get("thumb")),
			render: await asBytes(form.get("render")),
		});
		if (!result.ok) return jsonResponse(result, result.reason === "too-large" ? 413 : 415);
		if (result.fresh || result.requeued) enqueueDesign(result.row.id);
		return jsonResponse(result);
	}

	const [id, action] = rest.split("/");
	if (!id || !validId(id)) return jsonResponse({ error: "bad id" }, 400);
	const row = getDesign(id);
	if (!row) return jsonResponse({ error: "no such design" }, 404);

	if (!post) {
		if (action === "image") return blobResponse(imagePath(row), row.mime);
		if (action === "thumb") {
			if (!row.thumb) return jsonResponse({ error: "no thumbnail" }, 404);
			return blobResponse(thumbPath(id), "image/webp");
		}
		if (!action) {
			let spec: unknown = null;
			try {
				spec = row.spec ? JSON.parse(row.spec) : null;
			} catch {
				// Provenance is frozen text; a malformed blob must not take the row down with it.
			}
			return jsonResponse({ row, spec });
		}
		return jsonResponse({ error: `unknown design action: ${action}` }, 404);
	}

	if (action === "retry") return jsonResponse({ ok: retryExtraction(id) });
	if (action === "restore") return jsonResponse(restoreDesignNote(id));
	if (action === "forget") {
		const body = (await req.json().catch(() => ({}))) as { confirm?: boolean; trashNote?: boolean };
		// Dry-run unless the caller explicitly confirms: the plan tells the dashboard
		// exactly what would be removed so the user can see it before agreeing.
		return jsonResponse(forgetDesign(id, { confirm: body.confirm === true, trashNote: body.trashNote === true }));
	}
	return jsonResponse({ error: `unknown design action: ${action}` }, 404);
}

/** Switch vaults: validate, persist, wipe the old corpus index, rebuild, re-watch. */
async function switchVault(path: string): Promise<Response> {
	try {
		if (!statSync(path).isDirectory()) return jsonResponse({ error: "not a directory" }, 400);
	} catch {
		return jsonResponse({ error: "path does not exist" }, 400);
	}
	const previous = vaultRoot();
	await saveConfig({ vault: path });
	if (previous && previous !== path) resetIndex();
	const stats = await reindex();
	restartWatcher();
	return jsonResponse({ ok: true, stats });
}

// A package upgrade rewrites these files underneath the running process, and systemd
// does not restart user services on upgrade. The old server then keeps serving the NEW
// dashboard off disk and answers 404 to every route it has never had — which is exactly
// how 0.3.0's design tab looked to anyone who upgraded. Under systemd we can repair that
// without asking anyone: step aside and let Restart=always bring us back on the new code.
//
// Only under systemd. INVOCATION_ID is set by it, and a hand-started server has nothing
// to bring it back — exiting there would turn a cosmetic skew into a dead brain.
function watchForUpgrade(stop: () => void): void {
	if (!process.env.INVOCATION_ID) return;
	setInterval(() => {
		const installed = readInstalledVersion();
		if (!installed || !RUNNING_VERSION || installed === RUNNING_VERSION) return;
		console.log(`[upgrade] ${RUNNING_VERSION} -> ${installed}: restarting onto the new code`);
		stop();
		process.exit(0);
	}, 30_000).unref();
}

/** Numeric dotted compare. -1 / 0 / 1, unknown sorts lowest. */
function compareVersions(a: string | null, b: string | null): number {
	if (!a) return b ? -1 : 0;
	if (!b) return 1;
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (Number.isNaN(x) || Number.isNaN(y)) return 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * The pid listening on `port`, or null. Read straight out of /proc rather than shelling
 * out to ss or lsof, so this needs nothing installed: find the listening socket's inode
 * in /proc/net/tcp{,6}, then find whose fd points at it. Only our own processes are
 * readable, which is exactly the case that matters — a stale server of ours.
 */
function pidOnPort(port: number): number | null {
	const wanted = port.toString(16).toUpperCase().padStart(4, "0");
	const inodes = new Set<string>();
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let raw: string;
		try {
			raw = readFileSync(table, "utf-8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n").slice(1)) {
			const f = line.trim().split(/\s+/);
			// st 0A is LISTEN; local_address is host:port in hex
			if (f.length < 10 || f[3] !== "0A" || !f[1]?.endsWith(`:${wanted}`)) continue;
			if (f[9]) inodes.add(f[9]);
		}
	}
	if (inodes.size === 0) return null;
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${entry}/fd`);
		} catch {
			continue; // another user's process, or it exited mid-scan
		}
		for (const fd of fds) {
			try {
				if (inodes.has(readlinkSync(`/proc/${entry}/fd/${fd}`).slice(8, -1))) return Number(entry);
			} catch {
				/* fd closed under us */
			}
		}
	}
	return null;
}

/**
 * Something already holds our port. If it is an OLDER copy of us, take it over.
 *
 * A stale instance nothing will restart — a hand-started `bun server.ts`, or one the
 * upgrade hook could not reach — otherwise keeps the port forever. The new server cannot
 * bind, systemd retries it every few seconds for good, and the only way out is finding
 * and killing bun by hand. That is exactly what the first person to upgrade had to do.
 *
 * Two independent confirmations before any signal, because SIGTERM to the wrong pid is
 * unforgivable: the incumbent has to answer /api/status the way we do, AND the process
 * holding the socket has to look like one of ours. Strictly older only, so a newer server
 * is never displaced by an older one and two instances cannot ping-pong the port.
 */
async function evictStaleInstance(port: number): Promise<boolean> {
	let theirs: { version?: string | null; vault?: unknown; index?: unknown };
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
			signal: AbortSignal.timeout(3000),
		});
		theirs = (await res.json()) as typeof theirs;
	} catch {
		console.error(`[port] ${port} is held by something that is not a claude-brain — not touching it`);
		return false;
	}
	if (!("index" in theirs) || !("vault" in theirs)) {
		console.error(`[port] ${port} answers, but not like a claude-brain — not touching it`);
		return false;
	}
	const theirVersion = theirs.version ?? null;
	if (compareVersions(theirVersion, RUNNING_VERSION) >= 0) {
		console.error(
			`[port] ${port} is already served by claude-brain ${theirVersion ?? "(pre-0.3.1)"}, ` +
				`which is not older than this one (${RUNNING_VERSION}) — leaving it alone`,
		);
		return false;
	}
	const pid = pidOnPort(port);
	if (pid === null || pid === process.pid) {
		console.error(`[port] could not identify the process on ${port} — stop it by hand`);
		return false;
	}
	let cmdline = "";
	try {
		cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
	} catch {
		/* raced with its exit */
	}
	if (!cmdline.includes("server.ts") && !cmdline.includes("claude-brain")) {
		console.error(`[port] pid ${pid} holds ${port} but does not look like a claude-brain — not touching it`);
		return false;
	}
	console.log(`[port] claude-brain ${theirVersion ?? "(pre-0.3.1)"} (pid ${pid}) is stale — asking it to exit`);
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}
	// Its SIGTERM handler stops in-flight children and checkpoints the WAL before exiting.
	for (let i = 0; i < 50; i++) {
		await Bun.sleep(100);
		try {
			process.kill(pid, 0);
		} catch {
			return true; // gone
		}
	}
	console.error(`[port] pid ${pid} did not exit after 5 s — stop it by hand`);
	return false;
}

const serveOptions = {
	port: PORT,
	// A cold graph build or first consolidation can outrun the 10 s default.
	idleTimeout: 60,
	async fetch(req: Request) {
		const url = new URL(req.url);
		const post = req.method === "POST";
		if (post && !sameOrigin(req)) return jsonResponse({ error: "cross-origin request rejected" }, 403);

		if (url.pathname === "/") return serveStatic("index.html");
		if (url.pathname === "/bundle.js") return serveStatic("bundle.js");
		if (url.pathname === "/style.css") return serveStatic("style.css");

		if (url.pathname === "/api/graph") {
			try {
				return jsonResponse(buildGraph());
			} catch (err) {
				return jsonResponse({ error: String(err) }, 500);
			}
		}

		if (url.pathname === "/api/recall") {
			const q = url.searchParams.get("q") ?? "";
			if (!q.trim()) return jsonResponse({ error: "missing q" }, 400);
			const options = {
				k: Number(url.searchParams.get("k") ?? "6") || 6,
				pathPrefix: url.searchParams.get("p") ?? undefined,
				sessionId: url.searchParams.get("session") ?? undefined,
				episodeK: url.searchParams.has("episodes") ? Number(url.searchParams.get("episodes")) || 0 : undefined,
				full: url.searchParams.has("full"),
			};
			if (url.searchParams.get("format") === "md") {
				return new Response(await recallMarkdown(q, options), {
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}
			return jsonResponse({ query: q, hits: await recall(q, options) });
		}

		if (url.pathname.startsWith("/api/graph/")) {
			return handleGraphVerb(url.pathname.slice("/api/graph/".length), url);
		}

		if (url.pathname.startsWith("/api/session/") && post) {
			return handleSession(url.pathname.slice("/api/session/".length), await req.json());
		}

		if (url.pathname === "/api/episode" && post) {
			const body = (await req.json()) as Record<string, unknown>;
			const str = (v: unknown) => (typeof v === "string" ? v : "");
			return jsonResponse({
				id: recordEpisode({
					sessionId: str(body.sessionId) || "manual",
					cwd: str(body.cwd),
					kind: (str(body.kind) || "decision") as EpisodeKind,
					text: str(body.text),
					salience: typeof body.salience === "number" ? body.salience : 1.6,
				}),
			});
		}

		if (url.pathname === "/api/consolidate" && post) {
			return jsonResponse(consolidate(Number(url.searchParams.get("days") ?? "30") || 30));
		}

		if (url.pathname === "/api/note") {
			const noteId = url.searchParams.get("path");
			const root = vaultRoot();
			if (!noteId || !root) return jsonResponse({ error: "missing path or vault" }, 400);
			const graph = buildGraph();
			const node = graph.nodes.find((n) => n.id === noteId);
			if (!node) return jsonResponse({ error: "note not found" }, 404);
			const backlinks = graph.edges
				.filter((e) => e.target === noteId || e.source === noteId)
				.map((e) => (e.target === noteId ? e.source : e.target));
			try {
				const raw = readFileSync(join(root, noteId), "utf-8");
				return jsonResponse({ node, content: stripFrontmatter(raw).trim(), backlinks: [...new Set(backlinks)] });
			} catch (err) {
				return jsonResponse({ error: String(err) }, 500);
			}
		}

		if (url.pathname === "/api/designs" || url.pathname.startsWith("/api/designs/")) {
			return handleDesigns(url, req, post);
		}

		if (url.pathname === "/api/status") return jsonResponse(await fullStatus());
		if (url.pathname === "/api/reindex" && post) return jsonResponse(await reindex());
		if (url.pathname === "/api/vaults") return jsonResponse({ vaults: detectVaults() });

		if (url.pathname === "/api/config" && post) {
			const body = (await req.json()) as { vault?: string; llm?: { enabled?: boolean; model?: string } };
			if (typeof body.vault === "string") return switchVault(body.vault);
			// model is a closed union, so an arbitrary string from a POST body must not
			// reach the config file — an unknown model would be written once and then
			// fail on every call afterwards.
			const llm = body.llm;
			const model = LLM_MODELS.find((m) => m === llm?.model);
			if (llm && (typeof llm.enabled === "boolean" || model)) {
				const patch: { enabled?: boolean; model?: (typeof LLM_MODELS)[number] } = {};
				if (typeof llm.enabled === "boolean") patch.enabled = llm.enabled;
				if (model) patch.model = model;
				await saveConfig({ llm: { ...loadConfig().llm, ...patch } });
				// The probe caches for a TTL, so without a forced re-read the dashboard
				// would keep showing "disabled" for a minute after being switched on.
				await claudeStatus(true);
				return jsonResponse({ ok: true, llm: await llmStatus() });
			}
			return jsonResponse({ error: "nothing to update" }, 400);
		}

		if (url.pathname === "/api/sync/config" && post) {
			const body = (await req.json()) as {
				provider?: SyncProvider | null;
				enabled?: boolean;
				intervalMinutes?: number;
				remoteFolder?: string;
			};
			await configureSync(body);
			return jsonResponse(await syncStatus());
		}
		if (url.pathname === "/api/sync/now" && post) {
			void syncNow("manual");
			return jsonResponse({ started: true });
		}

		if (url.pathname === "/api/integrate" && post) return jsonResponse(await integrate());
		if (url.pathname === "/api/integrate/remove" && post) return jsonResponse(await unintegrate());

		return new Response("Not found", { status: 404 });
	},
};

async function listen() {
	try {
		return Bun.serve(serveOptions);
	} catch (err) {
		if ((err as { code?: string })?.code !== "EADDRINUSE") throw err;
		if (!(await evictStaleInstance(PORT))) {
			console.error(`[port] ${PORT} is in use — claude-brain cannot start`);
			process.exit(1);
		}
		return Bun.serve(serveOptions);
	}
}

const server = await listen();

console.log(`claude-brain serving on http://localhost:${server.port}`);
startWatcher();
startSyncSchedule();

// Drain any episodes captured while the server was down, then keep consolidating in
// the background so a long-running daemon doesn't accumulate unabstracted history.
void embedPendingEpisodes();

// Designs interrupted mid-flight: reclaim expired extraction leases and clear scratch
// files a killed run left behind. Both are no-ops on a clean start.
const reclaimed = resumeExtractions();
const swept = sweepPartFiles();
if (reclaimed > 0 || swept > 0) console.log(`[designs] resumed ${reclaimed}, cleared ${swept} partial file(s)`);

watchForUpgrade(() => server.stop(true));
const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
	const report = consolidate(3);
	if (report.ingestedEpisodes > 0 || report.forgotten.forgotten > 0) {
		console.log(`[consolidate] +${report.ingestedEpisodes} episodes, -${report.forgotten.forgotten} forgotten`);
	}
}, CONSOLIDATE_INTERVAL_MS).unref();

/**
 * Exiting immediately orphaned any in-flight `claude` child — still running, still
 * billing, output going nowhere. Stop them, let SQLite finish its WAL checkpoint, then go.
 * Guarded because systemd sends SIGTERM and may follow with another.
 */
let shuttingDown = false;
function shutdown(): void {
	if (shuttingDown) return;
	shuttingDown = true;
	const killed = killChildren();
	if (killed > 0) console.log(`[shutdown] stopped ${killed} in-flight claude call(s)`);
	try {
		openBrainDb().db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		/* a reader still holds it; the next open recovers from the WAL anyway */
	}
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
