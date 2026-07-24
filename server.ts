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
import { buildGraph } from "./src/graph-builder";
import { indexStatus } from "./src/hybrid-search";
import { resetIndex } from "./src/index-db";
import { reindex } from "./src/indexer";
import { integrate, integrationStatus, unintegrate } from "./src/integrate";
import { recall, recallMarkdown } from "./src/recall";
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
	async fetch(req) {
		const url = new URL(req.url);
		const post = req.method === "POST";

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
			const k = Number(url.searchParams.get("k") ?? "6") || 6;
			const p = url.searchParams.get("p") ?? undefined;
			if (!q.trim()) return jsonResponse({ error: "missing q" }, 400);
			if (url.searchParams.get("format") === "md") {
				return new Response(await recallMarkdown(q, k, p), {
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}
			return jsonResponse({ query: q, hits: await recall(q, k, p) });
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

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
