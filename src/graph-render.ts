// Text rendering for the graph verbs. Kept apart from traverse.ts so the traversal
// stays pure data — the API returns JSON from the same functions.

import {
	affected,
	communityMap,
	explainNode,
	findPath,
	type NodeRef,
	resolveNode,
} from "./traverse";

function label(node: NodeRef): string {
	return `${node.title}  \`${node.path}\``;
}

async function resolveOrExplain(query: string): Promise<NodeRef | string> {
	const node = await resolveNode(query);
	return node ?? `No note matches: ${query}`;
}

export async function renderPath(fromQuery: string, toQuery: string): Promise<string> {
	const from = await resolveOrExplain(fromQuery);
	if (typeof from === "string") return from;
	const to = await resolveOrExplain(toQuery);
	if (typeof to === "string") return to;

	const hops = findPath(from.id, to.id);
	if (hops === null) return `No path between "${from.title}" and "${to.title}" — they sit in different parts of the vault.`;
	if (hops.length === 0) return `Same note: ${label(from)}`;

	const lines = [`${hops.length} hop${hops.length === 1 ? "" : "s"}: ${from.title} → ${to.title}`, ""];
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
	const node = await resolveOrExplain(query);
	if (typeof node === "string") return node;
	const report = explainNode(node.id);
	if (!report) return `No note matches: ${query}`;

	const lines = [
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
	const node = await resolveOrExplain(query);
	if (typeof node === "string") return node;
	const hits = affected(node.id, depth);
	if (hits.length === 0) return `Nothing points at ${node.title}.`;
	const lines = [`${hits.length} reach ${node.title} (depth ≤ ${depth}, strongest first)`, ""];
	for (const hit of hits) lines.push(`  ${"·".repeat(hit.depth)} ${hit.title}  [${hit.via}]`);
	return lines.join("\n");
}

/**
 * The map is an orientation aid, so it defaults to labels only. Examples triple its
 * size and are worth it only when a label alone doesn't identify the cluster.
 */
export function renderMap(withExamples = false): string {
	const map = communityMap();
	if (map.length === 0) return "No communities yet — run `brain reindex` first.";
	const lines = [`${map.length} clusters across the vault`, ""];
	for (const c of map) {
		lines.push(`${String(c.size).padStart(3)}  ${c.label}`);
		if (withExamples && c.examples.length > 0) lines.push(`     e.g. ${c.examples.join(" · ")}`);
	}
	return lines.join("\n");
}
