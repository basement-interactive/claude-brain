// Text rendering for the graph verbs. Kept apart from traverse.ts so the traversal
// stays pure data — the API returns JSON from the same functions.

import {
	affected,
	communityMap,
	explainNode,
	findPath,
	type NodeRef,
	resolutionCandidates,
	resolveWithConfidence,
} from "./traverse";

function label(node: NodeRef): string {
	return `${node.title}  \`${node.path}\``;
}

/**
 * Resolve a described note, collecting any caveat the caller should print. A loose match
 * is still used — refusing outright would reject good queries, since confident and vague
 * descriptions overlap in score — but the reader is told what it settled on.
 */
async function resolveOrExplain(query: string): Promise<{ node: NodeRef; note: string } | string> {
	const resolved = await resolveWithConfidence(query);
	if (!resolved) {
		const candidates = await resolutionCandidates(query);
		if (candidates.length === 0) return `Nothing in the vault matches: "${query}"`;
		return [
			`"${query}" doesn't identify a note. Closest matches — name one directly:`,
			...candidates.map((c) => `  · ${c.title}  \`${c.path}\``),
		].join("\n");
	}
	if (!resolved.loose) return { node: resolved.node, note: "" };
	const others = resolved.alternatives.map((c) => c.title).join(", ");
	return {
		node: resolved.node,
		note: `note: "${query}" matched loosely → ${resolved.node.title}${others ? ` (also close: ${others})` : ""}`,
	};
}

export async function renderPath(fromQuery: string, toQuery: string): Promise<string> {
	const fromResult = await resolveOrExplain(fromQuery);
	if (typeof fromResult === "string") return fromResult;
	const toResult = await resolveOrExplain(toQuery);
	if (typeof toResult === "string") return toResult;
	const { node: from } = fromResult;
	const { node: to } = toResult;

	const hops = findPath(from.id, to.id);
	if (hops === null) return `No path between "${from.title}" and "${to.title}" — they sit in different parts of the vault.`;
	if (hops.length === 0) return `Same note: ${label(from)}`;

	const lines = [fromResult.note, toResult.note].filter(Boolean);
	if (lines.length > 0) lines.push("");
	lines.push(`${hops.length} hop${hops.length === 1 ? "" : "s"}: ${from.title} → ${to.title}`, "");
	lines.push(`  ${from.title}`);
	for (const hop of hops) {
		const detail = hop.detail ? ` (${hop.detail})` : "";
		lines.push(`    ──${hop.kind}${detail}──▶`);
		lines.push(`  ${hop.to.title}`);
	}
	lines.push("", `\`${from.path}\` → \`${to.path}\``);
	return lines.join("\n");
}

export async function renderExplain(query: string): Promise<string> {
	const resolved = await resolveOrExplain(query);
	if (typeof resolved === "string") return resolved;
	const report = explainNode(resolved.node.id);
	if (!report) return `No note matches: ${query}`;

	const lines = [
		...(resolved.note ? [resolved.note, ""] : []),
		`# ${report.node.title}`,
		`\`${report.node.path}\``,
		`community: ${report.community ? `${report.community.label} (${report.community.size} notes)` : "unclustered"}`,
		`degree: ${report.degree}   recalled: ${report.accessCount}×`,
		"",
	];
	const byKind = new Map<string, typeof report.neighbours>();
	for (const n of report.neighbours) {
		const list = byKind.get(n.kind) ?? [];
		list.push(n);
		byKind.set(n.kind, list);
	}
	const ARROW = { out: "→", in: "←", both: "↔" } as const;
	for (const [kind, group] of byKind) {
		lines.push(`## ${kind}`);
		for (const n of group) {
			lines.push(`  ${ARROW[n.direction]} ${n.title}${n.detail ? `  [${n.detail}]` : ""}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export async function renderAffected(query: string, depth: number): Promise<string> {
	const resolved = await resolveOrExplain(query);
	if (typeof resolved === "string") return resolved;
	const { node } = resolved;
	const hits = affected(node.id, depth);
	if (hits.length === 0) return `Nothing points at ${node.title}.`;
	const lines = [
		...(resolved.note ? [resolved.note, ""] : []),
		`${hits.length} reach ${node.title} (depth ≤ ${depth}, strongest first)`,
		"",
	];
	for (const hit of hits) lines.push(`  ${"·".repeat(hit.depth)} ${hit.title}  [${hit.via}]`);
	return lines.join("\n");
}

/**
 * The map is an orientation aid, so it defaults to labels only. Examples triple its
 * size and are worth it only when a label alone doesn't identify the cluster.
 */
export function renderMap(withExamples = false): string {
	const map = communityMap();
	if (map.length === 0) return "No communities yet — run `claude-brain reindex` first.";
	const lines = [`${map.length} clusters across the vault`, ""];
	for (const c of map) {
		lines.push(`${String(c.size).padStart(3)}  ${c.label}`);
		if (withExamples && c.examples.length > 0) lines.push(`     e.g. ${c.examples.join(" · ")}`);
	}
	return lines.join("\n");
}
