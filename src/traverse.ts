// Traversal verbs over the enriched graph: how two notes connect, what surrounds one,
// what points at it. The graph is mostly undirected, so "shortest path" is a weighted
// shortest path — strong edges (an explicit wikilink) cost less to cross than weak ones
// (a similarity guess), which keeps routes on real associations instead of hub detours.

import { adjacency, type WeightedEdge } from "./graph";
import { openBrainDb } from "./index-db";
import { recall } from "./recall";

export interface NodeRef {
	id: number;
	path: string;
	title: string;
}

function docByExactPath(value: string): NodeRef | null {
	const { db } = openBrainDb();
	return (db.query("SELECT id, path, title FROM docs WHERE path = ?").get(value) as NodeRef) ?? null;
}

/**
 * Accept whatever the user typed: a path, a filename, a title, or a description of the
 * thing. The last case falls through to recall, which is why `path "the audio crash"
 * "deploy notes"` works where a graph tool would demand exact node labels.
 */
export async function resolveNode(query: string): Promise<NodeRef | null> {
	const { db } = openBrainDb();
	const trimmed = query.trim();
	if (!trimmed) return null;

	const exact = docByExactPath(trimmed);
	if (exact) return exact;

	const byName = db
		.query(
			`SELECT id, path, title FROM docs
			 WHERE lower(title) = lower(?) OR lower(path) LIKE lower(?)
			 ORDER BY length(path) LIMIT 1`,
		)
		.get(trimmed, `%${trimmed.replace(/\.md$/i, "")}.md`) as NodeRef | null;
	if (byName) return byName;

	const hits = await recall(trimmed, { k: 3, episodeK: 0, reinforce: false });
	const top = hits.find((h) => h.kind === "note");
	if (!top || top.score < RESOLVE_FLOOR) return null;
	return docByExactPath(top.path);
}

/**
 * Below this the ranker is returning its least-bad option for a description that names
 * nothing ("the thing we discussed"), so refuse outright.
 */
const RESOLVE_FLOOR = 0.095;
/**
 * Above the floor but below this, the match is plausible and worth using — but the
 * caller should be told, because a path through a misidentified node still looks like
 * a path. Measured: confident descriptions land 0.136–0.207, vague ones 0.088–0.107,
 * and the ranges overlap, so a hard cut in the overlap would reject good queries.
 */
const RESOLVE_CONFIDENT = 0.13;

export interface Resolution {
	node: NodeRef;
	loose: boolean;
	alternatives: NodeRef[];
}

/** Resolve with provenance: what matched, how sure, and what else was close. */
export async function resolveWithConfidence(query: string): Promise<Resolution | null> {
	const node = await resolveNode(query);
	if (!node) return null;
	const hits = await recall(query, { k: 3, episodeK: 0, reinforce: false });
	const notes = hits.filter((h) => h.kind === "note");
	const loose = (notes[0]?.score ?? 0) < RESOLVE_CONFIDENT;
	const alternatives = loose
		? notes
				.slice(1)
				.map((h) => docByExactPath(h.path))
				.filter((n): n is NodeRef => n !== null)
		: [];
	return { node, loose, alternatives };
}

/** Best-effort alternatives, for telling the user what a failed description nearly matched. */
export async function resolutionCandidates(query: string): Promise<NodeRef[]> {
	const hits = await recall(query, { k: 3, episodeK: 0, reinforce: false });
	return hits
		.filter((h) => h.kind === "note")
		.map((h) => docByExactPath(h.path))
		.filter((n): n is NodeRef => n !== null);
}

export interface PathHop {
	from: NodeRef;
	to: NodeRef;
	kind: string;
	detail: string;
}

function nodesByIds(ids: number[]): Map<number, NodeRef> {
	const { db } = openBrainDb();
	if (ids.length === 0) return new Map();
	const rows = db
		.query(`SELECT id, path, title FROM docs WHERE id IN (${ids.map(() => "?").join(",")})`)
		.all(...ids) as NodeRef[];
	return new Map(rows.map((r) => [r.id, r]));
}

/** Weighted shortest path (Dijkstra, cost = 1/weight). Null when the two aren't connected. */
export function findPath(fromId: number, toId: number): PathHop[] | null {
	if (fromId === toId) return [];
	const adj = adjacency();
	const dist = new Map<number, number>([[fromId, 0]]);
	const prev = new Map<number, { node: number; edge: WeightedEdge }>();
	const visited = new Set<number>();

	// A vault graph is small; a linear scan for the next node beats a heap in both
	// code size and, at this scale, wall clock.
	for (;;) {
		let current = -1;
		let best = Number.POSITIVE_INFINITY;
		for (const [node, d] of dist) {
			if (!visited.has(node) && d < best) {
				best = d;
				current = node;
			}
		}
		if (current === -1) return null;
		if (current === toId) break;
		visited.add(current);
		for (const edge of adj.get(current) ?? []) {
			if (visited.has(edge.other)) continue;
			const cost = best + 1 / Math.max(edge.weight, 0.05);
			if (cost < (dist.get(edge.other) ?? Number.POSITIVE_INFINITY)) {
				dist.set(edge.other, cost);
				prev.set(edge.other, { node: current, edge });
			}
		}
	}

	const chain: Array<{ node: number; edge: WeightedEdge }> = [];
	let cursor = toId;
	while (cursor !== fromId) {
		const step = prev.get(cursor);
		if (!step) return null;
		chain.push({ node: cursor, edge: step.edge });
		cursor = step.node;
	}
	chain.reverse();

	const refs = nodesByIds([fromId, ...chain.map((c) => c.node)]);
	const hops: PathHop[] = [];
	let previous = fromId;
	for (const step of chain) {
		hops.push({
			from: refs.get(previous)!,
			to: refs.get(step.node)!,
			kind: step.edge.kind,
			detail: step.edge.detail,
		});
		previous = step.node;
	}
	return hops;
}

export interface Neighbour extends NodeRef {
	kind: string;
	detail: string;
	weight: number;
	direction: "out" | "in" | "both";
}

export interface NodeReport {
	node: NodeRef;
	community: { id: number; label: string; size: number } | null;
	degree: number;
	accessCount: number;
	neighbours: Neighbour[];
}

export function explainNode(id: number, limit = 20): NodeReport | null {
	const { db } = openBrainDb();
	const node = db.query("SELECT id, path, title FROM docs WHERE id = ?").get(id) as NodeRef | null;
	if (!node) return null;

	const community = db
		.query(
			`SELECT c.community AS id, l.label, l.size FROM communities c
			 JOIN community_labels l ON l.community = c.community WHERE c.doc_id = ?`,
		)
		.get(id) as { id: number; label: string; size: number } | null;

	const edges = adjacency().get(id) ?? [];
	const refs = nodesByIds(edges.map((e) => e.other));
	const neighbours: Neighbour[] = edges
		.map((e) => {
			const ref = refs.get(e.other);
			return ref ? { ...ref, kind: e.kind, detail: e.detail, weight: e.weight, direction: e.direction } : null;
		})
		.filter((n): n is Neighbour => n !== null)
		.sort((a, b) => b.weight - a.weight);

	const stats = db.query("SELECT access_count FROM docs WHERE id = ?").get(id) as { access_count: number };
	return {
		node,
		community,
		degree: edges.length,
		accessCount: stats.access_count,
		neighbours: neighbours.slice(0, limit),
	};
}

export interface AffectedHit extends NodeRef {
	depth: number;
	via: string;
}

/**
 * What points at this, transitively. Explicit wikilinks are followed backwards only —
 * a backlink is a claim about relevance in a way a similarity edge isn't — while derived
 * edges are symmetric and traversed as-is.
 */
export function affected(id: number, depth = 2, kinds?: Set<string>, limit = 15): AffectedHit[] {
	const { db } = openBrainDb();
	const incoming = new Map<number, Array<{ from: number; kind: string; detail: string }>>();
	for (const row of db.query("SELECT source_doc, target_doc, relation FROM links").all() as Array<{
		source_doc: number;
		target_doc: number;
		relation: string;
	}>) {
		const list = incoming.get(row.target_doc) ?? [];
		list.push({ from: row.source_doc, kind: "wikilink", detail: row.relation });
		incoming.set(row.target_doc, list);
	}
	for (const row of db.query("SELECT source_doc, target_doc, kind, detail FROM derived_links").all() as Array<{
		source_doc: number;
		target_doc: number;
		kind: string;
		detail: string;
	}>) {
		for (const [a, b] of [
			[row.source_doc, row.target_doc],
			[row.target_doc, row.source_doc],
		] as const) {
			const list = incoming.get(a) ?? [];
			list.push({ from: b, kind: row.kind, detail: row.detail });
			incoming.set(a, list);
		}
	}

	const seen = new Set<number>([id]);
	const found: Array<{ id: number; depth: number; via: string }> = [];
	let frontier = [id];
	for (let d = 1; d <= depth && frontier.length > 0; d++) {
		const next: number[] = [];
		for (const node of frontier) {
			for (const edge of incoming.get(node) ?? []) {
				if (seen.has(edge.from)) continue;
				if (kinds && !kinds.has(edge.kind)) continue;
				seen.add(edge.from);
				found.push({ id: edge.from, depth: d, via: `${edge.kind}:${edge.detail}` });
				next.push(edge.from);
			}
		}
		frontier = next;
	}

	const refs = nodesByIds(found.map((f) => f.id));
	// Explicit links first, then closeness. Past ~15 the tail is derived edges two hops
	// out, which is noise the caller pays tokens for.
	const rank = (via: string) => (via.startsWith("wikilink") ? 0 : via.startsWith("tag") ? 1 : 2);
	return found
		.map((f) => {
			const ref = refs.get(f.id);
			return ref ? { ...ref, depth: f.depth, via: f.via } : null;
		})
		.filter((a): a is AffectedHit => a !== null)
		.sort((a, b) => a.depth - b.depth || rank(a.via) - rank(b.via))
		.slice(0, limit);
}

export interface CommunitySummary {
	id: number;
	label: string;
	size: number;
	examples: string[];
}

/** The whole vault as a handful of named clusters — the map graphify's report gave you. */
export function communityMap(): CommunitySummary[] {
	const { db } = openBrainDb();
	const labels = db
		.query("SELECT community, label, size FROM community_labels ORDER BY size DESC")
		.all() as Array<{ community: number; label: string; size: number }>;
	const example = db.query(
		`SELECT d.title FROM communities c JOIN docs d ON d.id = c.doc_id
		 WHERE c.community = ? ORDER BY d.access_count DESC, length(d.path) LIMIT 3`,
	);
	return labels.map((l) => ({
		id: l.community,
		label: l.label,
		size: l.size,
		examples: (example.all(l.community) as Array<{ title: string }>).map((r) => r.title),
	}));
}
