// Spreading activation over the wikilink graph. Retrieval in a brain doesn't stop at
// what matched the cue — activation flows outward along associations, which is why
// remembering one thing hands you the neighbouring thing you didn't ask for.
//
// The existing graph boost only re-ranked notes that already matched. This pulls in
// notes that matched nothing, purely because a strong match points at them.

import { openBrainDb } from "./index-db";

/** Fraction of a seed's score that reaches a neighbour before fan-out is divided out. */
const SPREAD_RATIO = 0.35;
/** Seeds worth spreading from — activation is a limited budget, weak cues don't spread. */
const MAX_SEEDS = 5;

export interface SpreadHit {
	docId: number;
	score: number;
	/** The matched note this one came in through, for explaining the association. */
	viaDocId: number;
}

/**
 * One hop out from the strongest matches. A note's contribution is divided by the
 * square root of its degree, so a hub linking forty notes doesn't flood the result —
 * the same fan-out normalisation that keeps spreading-activation models stable.
 */
export function spreadActivation(seeds: Map<number, number>, limit = 3): SpreadHit[] {
	const { db } = openBrainDb();
	const top = [...seeds.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEDS);
	if (top.length === 0 || limit <= 0) return [];

	const ids = top.map(([id]) => id);
	const list = ids.map(() => "?").join(",");
	const edges = db
		.query(
			`SELECT source_doc, target_doc FROM links
			 WHERE source_doc IN (${list}) OR target_doc IN (${list})`,
		)
		.all(...ids, ...ids) as Array<{ source_doc: number; target_doc: number }>;

	const degree = new Map<number, number>();
	const neighbours = new Map<number, Set<number>>();
	for (const { source_doc, target_doc } of edges) {
		for (const [from, to] of [
			[source_doc, target_doc],
			[target_doc, source_doc],
		] as const) {
			if (!seeds.has(from)) continue;
			degree.set(from, (degree.get(from) ?? 0) + 1);
			const set = neighbours.get(from) ?? new Set<number>();
			set.add(to);
			neighbours.set(from, set);
		}
	}

	const received = new Map<number, SpreadHit>();
	for (const [seedId, seedScore] of top) {
		const targets = neighbours.get(seedId);
		if (!targets) continue;
		const damping = SPREAD_RATIO / Math.sqrt(degree.get(seedId) ?? 1);
		for (const target of targets) {
			if (seeds.has(target)) continue;
			const score = seedScore * damping;
			const prev = received.get(target);
			// Several seeds pointing at the same note is itself evidence — take the
			// strongest path rather than summing, which would over-reward hubs again.
			if (!prev || score > prev.score) received.set(target, { docId: target, score, viaDocId: seedId });
		}
	}

	return [...received.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
