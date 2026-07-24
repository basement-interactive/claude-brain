// Public recall API over the persistent hybrid index.

import { hybridRecall, type RecallHit } from "./hybrid-search";
import { reindex } from "./indexer";

export type { RecallHit };

/** Hybrid recall over the vault. Returns the top-k most relevant note sections. */
export async function recall(query: string, k = 6, pathPrefix?: string): Promise<RecallHit[]> {
	return hybridRecall(query, k, pathPrefix);
}

/** Compact markdown rendering for CLI / agent consumption. */
export async function recallMarkdown(query: string, k = 6, pathPrefix?: string): Promise<string> {
	const hits = await recall(query, k, pathPrefix);
	if (hits.length === 0) return `No vault matches for: ${query}`;
	return hits
		.map(
			(h, i) =>
				`### ${i + 1}. ${h.title}${h.heading !== h.title ? ` › ${h.heading}` : ""}\n` +
				`\`${h.path}\` (score ${h.score})\n\n${h.snippet}`,
		)
		.join("\n\n---\n\n");
}

/** Direct-import path for the CLI when the server is down: index once, then search. */
export async function recallMarkdownStandalone(query: string, k = 6): Promise<string> {
	await reindex();
	return recallMarkdown(query, k);
}
