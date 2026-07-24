// Typing a wikilink from where it sits. A `[[link]]` under "## Root cause" preceded by
// "caused by" is a different fact than the same link under "## See also", and the vault
// already encodes that distinction — in headings and in the sentence around the link.
//
// This is the cheap half of what an LLM extractor buys you: no tokens, no staleness,
// and it re-derives itself on every save.

export type Relation =
	| "caused_by"
	| "fixed_by"
	| "supersedes"
	| "same_as"
	| "depends_on"
	| "part_of"
	| "example_of"
	| "related_to"
	| "references";

/** Cue phrases in the sentence carrying the link, strongest first. */
const CONTEXT_CUES: Array<[RegExp, Relation]> = [
	[/\b(caused by|because of|root cause|stems from|due to)\b/i, "caused_by"],
	[/\b(fixed (in|by)|fix(ed)? (is|was)|solved (in|by)|solution (in|is))\b/i, "fixed_by"],
	[/\b(supersed|replac|obsolet|deprecat)\w*\b/i, "supersedes"],
	[/\b(same (lesson|issue|bug|problem|thing)|duplicate of|same as)\b/i, "same_as"],
	[/\b(depends on|requires|needs|built on|relies on)\b/i, "depends_on"],
	[/\b(part of|belongs to|lives in|section of)\b/i, "part_of"],
	[/\b(example of|instance of|case of|see .* for an example)\b/i, "example_of"],
	[/\b(see also|related|cross-ref|compare)\b/i, "related_to"],
];

/** Section headings that type every link beneath them, when the sentence says nothing. */
const HEADING_CUES: Array<[RegExp, Relation]> = [
	[/^(root cause|cause|why)/i, "caused_by"],
	[/^(fix|solution|workaround|resolution)/i, "fixed_by"],
	[/^(follow-?up|update|superseded)/i, "supersedes"],
	[/^(see also|related|notes ?\/ ?links|links|cross-note)/i, "related_to"],
	[/^(depends|requires|prereq)/i, "depends_on"],
];

/**
 * Classify one wikilink. `context` is the line it appeared on, `heading` the section
 * it sits under. Sentence cues win over section cues — a "superseded by" inside a
 * "See also" block is still a supersession.
 */
export function classifyRelation(context: string, heading: string): Relation {
	for (const [re, relation] of CONTEXT_CUES) {
		if (re.test(context)) return relation;
	}
	for (const [re, relation] of HEADING_CUES) {
		if (re.test(heading.trim())) return relation;
	}
	return "references";
}

export interface ParsedLink {
	target: string;
	relation: Relation;
	context: string;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const HEADING_LINE_RE = /^(#{1,6})\s+(.+)$/;
const MAX_CONTEXT = 200;

/**
 * Walk a note body once, tracking the current heading, and emit every wikilink with
 * the relation implied by its surroundings. Fenced code is skipped — a `[[link]]` in
 * an example block is not an assertion about the vault.
 */
export function parseLinks(body: string): ParsedLink[] {
	const out: ParsedLink[] = [];
	let heading = "";
	let insideFence = false;

	for (const line of body.split(/\r?\n/)) {
		if (/^```/.test(line)) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence) continue;
		const headingMatch = line.match(HEADING_LINE_RE);
		if (headingMatch?.[2]) {
			heading = headingMatch[2].trim();
			// A heading can itself carry links; they belong to the section it opens.
		}
		for (const match of line.matchAll(WIKILINK_RE)) {
			const target = match[1] ?? "";
			if (!target) continue;
			const context = line.trim().slice(0, MAX_CONTEXT);
			out.push({ target, relation: classifyRelation(context, heading), context });
		}
	}
	return out;
}

/** Frontmatter tags, used to derive shared-topic edges the author never wrote. */
export function parseTags(raw: string): string[] {
	const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	if (!block) return [];
	const line = block.match(/^tags:\s*\[(.*)\]\s*$/im)?.[1];
	if (!line) return [];
	return line
		.split(",")
		.map((t) => t.trim().replace(/^["']|["']$/g, "").toLowerCase())
		.filter(Boolean);
}
