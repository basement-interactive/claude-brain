// Vault graph for the 3D view: one node per note, wikilink edges, plus a
// chronological "timeline" thread through dated notes. Categories are derived from
// the vault's own top-level folders, so any layout works without configuration.

import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { IGNORED_DIR_NAMES, vaultRoot } from "./config";

export interface GraphNode {
	id: string;
	title: string;
	category: string;
	tags: string[];
	date: string | null;
	status: string | null;
	excerpt: string;
	connections: number;
}

export type EdgeKind = "wikilink" | "timeline";

export interface GraphEdge {
	source: string;
	target: string;
	kind: EdgeKind;
}

export interface CategoryInfo {
	id: string;
	label: string;
	color: string;
	anchor: { x: number; y: number; z: number };
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	categories: CategoryInfo[];
	scannedAt: string;
	vaultRoot: string;
}

const ROOT_CATEGORY = "__root__";

const PALETTE = [
	"#38bdf8",
	"#fbbf24",
	"#a78bfa",
	"#34d399",
	"#f472b6",
	"#fb923c",
	"#a3e635",
	"#f87171",
	"#22d3ee",
	"#e879f9",
	"#facc15",
	"#4ade80",
];

const CLUSTER_RADIUS = 130;

/** Evenly spread N points on a sphere (golden-angle spiral) so category lobes don't overlap. */
function fibonacciSphere(index: number, total: number, radius: number) {
	if (total <= 1) return { x: 0, y: 0, z: 0 };
	const goldenAngle = Math.PI * (3 - Math.sqrt(5));
	const y = 1 - (index / (total - 1)) * 2;
	const r = Math.sqrt(1 - y * y);
	const theta = goldenAngle * index;
	return {
		x: Math.cos(theta) * r * radius,
		y: y * radius,
		z: Math.sin(theta) * r * radius,
	};
}

/** "01 Journals" → "Journals"; folders keep their own names otherwise. */
function labelFor(category: string): string {
	if (category === ROOT_CATEGORY) return "Root";
	return category.replace(/^\d+[\s._-]+/, "") || category;
}

function walkMarkdownFiles(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (IGNORED_DIR_NAMES.has(entry)) continue;
		const full = join(dir, entry);
		let stat: Stats;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			walkMarkdownFiles(full, out);
		} else if (stat.isFile() && extname(entry).toLowerCase() === ".md") {
			out.push(full);
		}
	}
}

interface ParsedFrontmatter {
	tags: string[];
	date: string | null;
	status: string | null;
	body: string;
}

/** Minimal frontmatter reader — tags / date / status only, no YAML dependency. */
function parseFrontmatter(raw: string): ParsedFrontmatter {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { tags: [], date: null, status: null, body: raw };
	const block = match[1] ?? "";
	const body = raw.slice(match[0].length);
	let tags: string[] = [];
	let date: string | null = null;
	let status: string | null = null;
	for (const line of block.split(/\r?\n/)) {
		const tagsMatch = line.match(/^tags:\s*\[(.*)\]\s*$/i);
		if (tagsMatch) {
			tags = (tagsMatch[1] ?? "")
				.split(",")
				.map((t) => t.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
			continue;
		}
		const dateMatch = line.match(/^date:\s*(\S+)\s*$/i);
		if (dateMatch) {
			date = dateMatch[1] ?? null;
			continue;
		}
		const statusMatch = line.match(/^status:\s*(\S+)\s*$/i);
		if (statusMatch) status = statusMatch[1] ?? null;
	}
	return { tags, date, status, body };
}

const HEADING_RE = /^#\s+(.+)$/m;
const DATE_IN_FILENAME_RE = /(\d{4}-\d{2}-\d{2})/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function titleFor(body: string, fileBasename: string): string {
	const heading = body.match(HEADING_RE);
	if (heading) return (heading[1] ?? "").trim();
	return fileBasename.replace(/\.md$/i, "");
}

function excerptFor(body: string): string {
	const withoutHeading = body.replace(HEADING_RE, "");
	const plain = withoutHeading
		.replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, "$1")
		.replace(/[#*_`>-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > 260 ? `${plain.slice(0, 260)}…` : plain;
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Resolve a `[[link]]` target against the set of known note basenames. */
export function resolveLink(
	target: string,
	byBasename: Map<string, string[]>,
	fromId: string,
): string | null {
	const cleaned = target.split("|")[0]!.split("#")[0]!.trim();
	if (!cleaned) return null;
	const key = basename(cleaned).replace(/\.md$/i, "").toLowerCase();
	const candidates = byBasename.get(key);
	if (!candidates || candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0]!;
	// Prefer a candidate sharing the linking note's top-level folder, else the shortest path.
	const fromTop = fromId.split("/")[0];
	const sameFolder = candidates.find((c) => c.split("/")[0] === fromTop);
	if (sameFolder) return sameFolder;
	return [...candidates].sort((a, b) => a.length - b.length)[0]!;
}

export function buildGraph(): GraphData {
	const root = vaultRoot();
	if (!root) {
		return { nodes: [], edges: [], categories: [], scannedAt: new Date().toISOString(), vaultRoot: "" };
	}

	const files: string[] = [];
	walkMarkdownFiles(root, files);

	const nodes: GraphNode[] = [];
	const bodies = new Map<string, string>();
	const byBasename = new Map<string, string[]>();

	for (const abs of files) {
		const relPath = toPosix(relative(root, abs));
		let raw: string;
		try {
			raw = readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		const { tags, date, status, body } = parseFrontmatter(raw);
		const fileBasename = basename(abs);
		const filenameDate = fileBasename.match(DATE_IN_FILENAME_RE)?.[1] ?? null;
		const category = relPath.includes("/") ? relPath.split("/")[0]! : ROOT_CATEGORY;

		nodes.push({
			id: relPath,
			title: titleFor(body, fileBasename),
			category,
			tags,
			date: date ?? filenameDate,
			status,
			excerpt: excerptFor(body),
			connections: 0,
		});
		bodies.set(relPath, body);

		const key = fileBasename.replace(/\.md$/i, "").toLowerCase();
		const list = byBasename.get(key) ?? [];
		list.push(relPath);
		byBasename.set(key, list);
	}

	// Stable category order: root first, then folders alphabetically.
	const categoryIds = [...new Set(nodes.map((n) => n.category))].sort((a, b) =>
		a === ROOT_CATEGORY ? -1 : b === ROOT_CATEGORY ? 1 : a.localeCompare(b),
	);
	const categories: CategoryInfo[] = categoryIds.map((id, i) => ({
		id,
		label: labelFor(id),
		color: PALETTE[i % PALETTE.length]!,
		anchor: fibonacciSphere(i, categoryIds.length, CLUSTER_RADIUS),
	}));

	const edges: GraphEdge[] = [];
	const seenPairs = new Set<string>();

	for (const node of nodes) {
		const body = bodies.get(node.id) ?? "";
		for (const m of body.matchAll(WIKILINK_RE)) {
			const targetId = resolveLink(m[1]!, byBasename, node.id);
			if (!targetId || targetId === node.id) continue;
			const pairKey = `wikilink:${node.id}->${targetId}`;
			if (seenPairs.has(pairKey)) continue;
			seenPairs.add(pairKey);
			edges.push({ source: node.id, target: targetId, kind: "wikilink" });
		}
	}

	// Chronological thread through dated notes — the vault's own timeline.
	const dated = nodes
		.filter((n) => n.date && DATE_IN_FILENAME_RE.test(basename(n.id)))
		.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
	for (let i = 1; i < dated.length; i++) {
		edges.push({ source: dated[i - 1]!.id, target: dated[i]!.id, kind: "timeline" });
	}

	const connectionCount = new Map<string, number>();
	for (const edge of edges) {
		connectionCount.set(edge.source, (connectionCount.get(edge.source) ?? 0) + 1);
		connectionCount.set(edge.target, (connectionCount.get(edge.target) ?? 0) + 1);
	}
	for (const node of nodes) {
		node.connections = connectionCount.get(node.id) ?? 0;
	}

	return {
		nodes,
		edges,
		categories,
		scannedAt: new Date().toISOString(),
		vaultRoot: root,
	};
}
