// Deriving the edges the author never wrote, and grouping what results into communities.
//
// An LLM extractor buys density by reading every note and inventing relations. This
// buys the same density from signals the vault already carries — embeddings, frontmatter
// tags, folder structure, journal chronology — which costs nothing per rebuild and can
// therefore run on every save instead of once a month.

import { openBrainDb } from "./index-db";

export type DerivedKind = "semantic" | "tag" | "timeline";

/** How much each edge kind counts when clustering and when routing a path. */
export const EDGE_WEIGHT: Record<string, number> = {
	wikilink: 1,
	semantic: 0.6,
	tag: 0.5,
	timeline: 0.2,
};

/** Cosine floor for a similarity edge. Below this, MiniLM pairs notes that merely share a register. */
const SEMANTIC_MIN_COSINE = 0.62;
const SEMANTIC_PER_DOC = 3;
/**
 * Tag edges are a clique per tag, so their count grows with the square of the tag's
 * membership. A tag on 20 notes would contribute 190 edges of near-zero information and
 * drown the graph — cap membership, and discount what survives by how common it is.
 */
const TAG_MAX_MEMBERS = 8;
const EMBED_DIM = 384;

interface DocRow {
	id: number;
	path: string;
	title: string;
}

function toFloats(raw: Uint8Array): Float32Array {
	return new Float32Array(raw.buffer, raw.byteOffset, EMBED_DIM);
}

/** Mean of a note's chunk vectors — one point standing for the whole note. */
function docCentroids(): Map<number, Float32Array> {
	const { db, vectors } = openBrainDb();
	const centroids = new Map<number, Float32Array>();
	if (!vectors) return centroids;
	const rows = db
		.query(
			`SELECT c.doc_id AS docId, v.embedding AS embedding
			 FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id`,
		)
		.all() as Array<{ docId: number; embedding: Uint8Array }>;

	const counts = new Map<number, number>();
	for (const row of rows) {
		const vec = toFloats(row.embedding);
		let acc = centroids.get(row.docId);
		if (!acc) {
			acc = new Float32Array(EMBED_DIM);
			centroids.set(row.docId, acc);
		}
		for (let i = 0; i < EMBED_DIM; i++) acc[i]! += vec[i]!;
		counts.set(row.docId, (counts.get(row.docId) ?? 0) + 1);
	}
	for (const [docId, acc] of centroids) {
		const n = counts.get(docId) ?? 1;
		let norm = 0;
		for (let i = 0; i < EMBED_DIM; i++) {
			acc[i]! /= n;
			norm += acc[i]! * acc[i]!;
		}
		norm = Math.sqrt(norm) || 1;
		for (let i = 0; i < EMBED_DIM; i++) acc[i]! /= norm;
	}
	return centroids;
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < EMBED_DIM; i++) dot += a[i]! * b[i]!;
	return dot;
}

/**
 * Notes that read alike but were never linked. This is the edge kind that most directly
 * replaces LLM extraction: 157 centroids compared pairwise is ~12k dot products, which
 * is faster than one API call and never goes stale.
 */
function semanticEdges(): Array<[number, number, number]> {
	const centroids = [...docCentroids().entries()];
	const out: Array<[number, number, number]> = [];
	for (const [docId, vec] of centroids) {
		const scored: Array<[number, number]> = [];
		for (const [otherId, otherVec] of centroids) {
			if (otherId === docId) continue;
			const score = cosine(vec, otherVec);
			if (score >= SEMANTIC_MIN_COSINE) scored.push([otherId, score]);
		}
		scored.sort((a, b) => b[1] - a[1]);
		for (const [otherId, score] of scored.slice(0, SEMANTIC_PER_DOC)) {
			// Undirected: store once, lower id first, so the pair isn't double-counted.
			if (docId < otherId) out.push([docId, otherId, score]);
			else out.push([otherId, docId, score]);
		}
	}
	return out;
}

/** Notes sharing a tag specific enough to mean something, weighted by that tag's rarity. */
function tagEdges(): Array<[number, number, string, number]> {
	const { db } = openBrainDb();
	const rows = db.query("SELECT doc_id, tag FROM doc_tags").all() as Array<{ doc_id: number; tag: string }>;
	const byTag = new Map<string, number[]>();
	for (const { doc_id, tag } of rows) {
		const list = byTag.get(tag) ?? [];
		list.push(doc_id);
		byTag.set(tag, list);
	}
	const out: Array<[number, number, string, number]> = [];
	for (const [tag, docs] of byTag) {
		if (docs.length < 2 || docs.length > TAG_MAX_MEMBERS) continue;
		const weight = EDGE_WEIGHT.tag! / Math.log2(2 + docs.length);
		const sorted = [...docs].sort((a, b) => a - b);
		for (let i = 0; i < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) out.push([sorted[i]!, sorted[j]!, tag, weight]);
		}
	}
	return out;
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** Consecutive journal entries — the vault's timeline, so "what came next" is traversable. */
function timelineEdges(docs: DocRow[]): Array<[number, number, string]> {
	const journals = docs
		.filter((d) => d.path.startsWith("01 Journals") && DATE_RE.test(d.path))
		.map((d) => ({ id: d.id, date: d.path.match(DATE_RE)![1]! }))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const out: Array<[number, number, string]> = [];
	for (let i = 1; i < journals.length; i++) {
		out.push([journals[i - 1]!.id, journals[i]!.id, journals[i]!.date]);
	}
	return out;
}

export interface DerivedStats {
	semantic: number;
	tag: number;
	timeline: number;
}

/**
 * Recompute every derived edge. Cheap enough to run on any structural change.
 *
 * Deliberately absent: a "same folder" edge kind. Folder cliques are O(n²) — one
 * 33-note Bible folder produced 528 edges saying nothing more than "filed together" —
 * and they glued the whole vault into 5 communities. Semantic edges already carry that
 * signal where it is real, with evidence attached.
 */
export function rebuildDerivedEdges(): DerivedStats {
	const { db } = openBrainDb();
	const docs = db.query("SELECT id, path, title FROM docs").all() as DocRow[];
	const semantic = semanticEdges();
	const tag = tagEdges();
	const timeline = timelineEdges(docs);

	db.transaction(() => {
		db.run("DELETE FROM derived_links");
		const insert = db.query(
			"INSERT OR REPLACE INTO derived_links (source_doc, target_doc, kind, weight, detail) VALUES (?, ?, ?, ?, ?)",
		);
		for (const [a, b, score] of semantic) insert.run(a, b, "semantic", score, `cosine ${score.toFixed(3)}`);
		for (const [a, b, t, weight] of tag) insert.run(a, b, "tag", weight, t);
		for (const [a, b, date] of timeline) insert.run(a, b, "timeline", EDGE_WEIGHT.timeline!, date);
	})();

	return { semantic: semantic.length, tag: tag.length, timeline: timeline.length };
}

export interface WeightedEdge {
	other: number;
	weight: number;
	kind: string;
	detail: string;
	/** Which way the edge was written. Derived edges are symmetric and report "both". */
	direction: "out" | "in" | "both";
}

/**
 * The whole graph as an adjacency map: explicit links plus everything derived.
 * Traversal treats every edge as walkable in both directions — association doesn't
 * care who wrote the link — but the original direction is preserved for display.
 */
export function adjacency(): Map<number, WeightedEdge[]> {
	const { db } = openBrainDb();
	const adj = new Map<number, WeightedEdge[]>();
	const add = (a: number, edge: WeightedEdge) => {
		const list = adj.get(a) ?? [];
		list.push(edge);
		adj.set(a, list);
	};
	for (const row of db.query("SELECT source_doc, target_doc, relation FROM links").all() as Array<{
		source_doc: number;
		target_doc: number;
		relation: string;
	}>) {
		const w = EDGE_WEIGHT.wikilink!;
		add(row.source_doc, { other: row.target_doc, weight: w, kind: "wikilink", detail: row.relation, direction: "out" });
		add(row.target_doc, { other: row.source_doc, weight: w, kind: "wikilink", detail: row.relation, direction: "in" });
	}
	for (const row of db.query("SELECT source_doc, target_doc, kind, weight, detail FROM derived_links").all() as Array<{
		source_doc: number;
		target_doc: number;
		kind: string;
		weight: number;
		detail: string;
	}>) {
		const w = row.kind === "semantic" ? EDGE_WEIGHT.semantic! * row.weight : row.weight;
		add(row.source_doc, { other: row.target_doc, weight: w, kind: row.kind, detail: row.detail, direction: "both" });
		add(row.target_doc, { other: row.source_doc, weight: w, kind: row.kind, detail: row.detail, direction: "both" });
	}
	return adj;
}

const LABEL_PROP_ROUNDS = 12;
/**
 * Resolution. Plain label propagation has one degenerate attractor — every node in one
 * community — and this vault fell into it (3 communities for 157 notes). Subtracting each
 * candidate community's expected attachment, as modularity does, penalises joining an
 * already-large group and holds the partition open. Higher = more, smaller communities.
 */
const RESOLUTION = 1.4;

/**
 * Weighted label propagation with a modularity-style resolution penalty. Nodes adopt the
 * neighbouring label with the best gain; ties break toward the lower label so runs are
 * reproducible and community ids don't churn between rebuilds.
 */
export function detectCommunities(): number {
	const { db } = openBrainDb();
	const docs = (db.query("SELECT id FROM docs ORDER BY id").all() as Array<{ id: number }>).map((d) => d.id);
	const adj = adjacency();
	const label = new Map<number, number>(docs.map((id) => [id, id]));

	const strength = new Map<number, number>();
	let totalWeight = 0;
	for (const id of docs) {
		const w = (adj.get(id) ?? []).reduce((sum, e) => sum + e.weight, 0);
		strength.set(id, w);
		totalWeight += w;
	}
	// Running total of edge weight attached to each community, kept current as nodes move.
	const communityWeight = new Map<number, number>(docs.map((id) => [id, strength.get(id) ?? 0]));
	// Highest-degree first: hubs settle early and pull their neighbourhoods in behind them.
	const order = [...docs].sort((a, b) => (adj.get(b)?.length ?? 0) - (adj.get(a)?.length ?? 0) || a - b);

	for (let round = 0; round < LABEL_PROP_ROUNDS; round++) {
		let moved = 0;
		for (const id of order) {
			const edges = adj.get(id);
			if (!edges?.length) continue;
			const own = label.get(id)!;
			const nodeStrength = strength.get(id) ?? 0;
			const score = new Map<number, number>();
			for (const e of edges) score.set(label.get(e.other)!, (score.get(label.get(e.other)!) ?? 0) + e.weight);

			let best = own;
			let bestGain = Number.NEGATIVE_INFINITY;
			for (const [l, w] of score) {
				// Exclude this node's own contribution when judging its current community.
				const attached = (communityWeight.get(l) ?? 0) - (l === own ? nodeStrength : 0);
				const gain = w - (RESOLUTION * nodeStrength * attached) / Math.max(totalWeight, 1);
				if (gain > bestGain || (gain === bestGain && l < best)) {
					best = l;
					bestGain = gain;
				}
			}
			if (best !== own) {
				communityWeight.set(own, (communityWeight.get(own) ?? 0) - nodeStrength);
				communityWeight.set(best, (communityWeight.get(best) ?? 0) + nodeStrength);
				label.set(id, best);
				moved++;
			}
		}
		if (moved === 0) break;
	}

	// Renumber to dense 0..n-1, largest community first, so ids are stable and readable.
	const members = new Map<number, number[]>();
	for (const [id, l] of label) {
		const list = members.get(l) ?? [];
		list.push(id);
		members.set(l, list);
	}
	const ranked = [...members.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);

	db.transaction(() => {
		db.run("DELETE FROM communities");
		const insert = db.query("INSERT INTO communities (doc_id, community) VALUES (?, ?)");
		ranked.forEach((group, community) => {
			for (const id of group) insert.run(id, community);
		});
	})();
	return ranked.length;
}

const STOPWORDS = new Set(
	("the a an and or of for to in on with is are was were be been it its this that then than " +
		"how why what when not no you your we our my i use used using dont doesnt cant wont " +
		"note notes bible fix fixes fixed issue issues bug bugs from into out only just also " +
		"md 2026 2025 journal journals").split(" "),
);

function terms(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 2 && t.length < 24 && !STOPWORDS.has(t));
}

/**
 * Name each community by the terms that distinguish it from the vault as a whole
 * (term frequency over document frequency). No model involved, so a label is always a
 * word that literally appears in the member notes — it can be wrong, but never invented.
 */
export function labelCommunities(): number {
	const { db } = openBrainDb();
	const rows = db
		.query(
			`SELECT c.community, d.title, d.path FROM communities c JOIN docs d ON d.id = c.doc_id`,
		)
		.all() as Array<{ community: number; title: string; path: string }>;

	const global = new Map<string, number>();
	const byCommunity = new Map<number, string[]>();
	for (const row of rows) {
		const list = byCommunity.get(row.community) ?? [];
		list.push(`${row.title} ${row.path.replace(/[/_-]/g, " ")}`);
		byCommunity.set(row.community, list);
	}
	for (const docs of byCommunity.values()) {
		for (const doc of docs) {
			for (const t of new Set(terms(doc))) global.set(t, (global.get(t) ?? 0) + 1);
		}
	}

	db.transaction(() => {
		db.run("DELETE FROM community_labels");
		const insert = db.query("INSERT INTO community_labels (community, label, size) VALUES (?, ?, ?)");
		for (const [community, docs] of byCommunity) {
			const local = new Map<string, number>();
			for (const doc of docs) {
				for (const t of terms(doc)) local.set(t, (local.get(t) ?? 0) + 1);
			}
			const scored = [...local.entries()]
				.map(([term, count]) => [term, count / Math.sqrt(global.get(term) ?? 1)] as const)
				.sort((a, b) => b[1] - a[1]);
			const label = scored.slice(0, 3).map(([t]) => t).join(" · ") || `community ${community}`;
			insert.run(community, label, docs.length);
		}
	})();
	return byCommunity.size;
}

export interface GraphBuildStats extends DerivedStats {
	communities: number;
	wikilinks: number;
}

const REBUILD_DEBOUNCE_MS = 3_000;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Coalesce rebuild requests. A save fires the indexer, which fires an embedding pass,
 * which changes the semantic edges — three triggers for one logical change, and the
 * whole rebuild is only ~100 ms, so waiting for the burst to settle costs nothing.
 */
export function scheduleGraphRebuild(): void {
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(() => {
		rebuildTimer = null;
		const stats = rebuildGraph();
		console.log(
			`[graph] ${stats.wikilinks} links + ${stats.semantic} semantic + ${stats.tag} tag → ${stats.communities} communities`,
		);
	}, REBUILD_DEBOUNCE_MS);
	rebuildTimer.unref?.();
}

/** Full graph rebuild: derived edges, then clustering, then labels. */
export function rebuildGraph(): GraphBuildStats {
	const derived = rebuildDerivedEdges();
	const communities = detectCommunities();
	labelCommunities();
	const { db } = openBrainDb();
	return {
		...derived,
		communities,
		wikilinks: (db.query("SELECT count(*) AS n FROM links").get() as { n: number }).n,
	};
}
