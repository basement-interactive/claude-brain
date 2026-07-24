// claude-brain server: hybrid recall API + 3D graph UI + settings + cloud sync.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	detectVaults,
	loadConfig,
	saveConfig,
	vaultReady,
	vaultRoot,
	type SyncProvider,
} from "./src/config";
import { status as claudeStatus } from "./src/claude-cli";
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
import { resetIndex } from "./src/index-db";
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
	return {
		index: indexStatus(),
		vault: cfg.vault,
		vaultReady: vaultReady(),
		port: cfg.port,
		sync: await syncStatus(),
		integration: integrationStatus(),
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

const server = Bun.serve({
	port: PORT,
	// A cold graph build or first consolidation can outrun the 10 s default.
	idleTimeout: 60,
	async fetch(req) {
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
			const body = (await req.json()) as { vault?: string };
			if (typeof body.vault === "string") return switchVault(body.vault);
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
});

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
const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
	const report = consolidate(3);
	if (report.ingestedEpisodes > 0 || report.forgotten.forgotten > 0) {
		console.log(`[consolidate] +${report.ingestedEpisodes} episodes, -${report.forgotten.forgotten} forgotten`);
	}
}, CONSOLIDATE_INTERVAL_MS).unref();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
