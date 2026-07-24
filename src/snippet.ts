// Returning the part of a chunk that answers the question, instead of its first 700
// characters. A chunk is a section of a note; the answer is usually a few lines inside
// it. Sending the whole section costs tokens for text the reader skips.
//
// Everything here is lexical — the chunk was already selected by the hybrid ranker, so
// this only has to decide *where inside it* to look.

const CONTEXT_LINES = 2;

function queryTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 2);
}

/** Prefix match rather than equality, so "crashes" still scores against "crash". */
function lineScore(line: string, terms: string[]): number {
	if (!line.trim()) return 0;
	const lower = line.toLowerCase();
	let score = 0;
	for (const term of terms) {
		const stem = term.length > 5 ? term.slice(0, Math.ceil(term.length * 0.7)) : term;
		if (lower.includes(stem)) score++;
	}
	// A heading that matches is worth more than a body line that matches: it labels
	// everything under it.
	return /^#{1,6}\s/.test(line.trim()) ? score * 1.5 : score;
}

interface Window {
	start: number;
	end: number;
	score: number;
}

/** Widen around the best line until the character budget is spent. */
function bestWindow(lines: string[], scores: number[], maxChars: number): Window {
	let peak = 0;
	for (let i = 1; i < scores.length; i++) {
		if (scores[i]! > scores[peak]!) peak = i;
	}
	let start = Math.max(0, peak - CONTEXT_LINES);
	let end = Math.min(lines.length - 1, peak + CONTEXT_LINES);
	const size = () => lines.slice(start, end + 1).join("\n").length;

	while (size() < maxChars && (start > 0 || end < lines.length - 1)) {
		// Grow toward whichever side still carries query terms; ties extend forward,
		// because the explanation usually follows the line that matched.
		const scoreBefore = start > 0 ? scores[start - 1]! : -1;
		const scoreAfter = end < lines.length - 1 ? scores[end + 1]! : -1;
		if (scoreAfter >= scoreBefore && end < lines.length - 1) end++;
		else if (start > 0) start--;
		else break;
		if (size() > maxChars) {
			if (scoreAfter >= scoreBefore) end--;
			else start++;
			break;
		}
	}
	return { start, end, score: scores[peak]! };
}

/**
 * The answering region of `text` for `query`, capped at `maxChars`. Falls back to the
 * head of the chunk when nothing matches lexically — that happens on a purely semantic
 * hit, where the opening lines are the best available summary.
 */
export function focusSnippet(text: string, query: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const lines = text.split("\n");
	const terms = queryTerms(query);
	if (terms.length === 0) return `${text.slice(0, maxChars)}…`;

	const scores = lines.map((l) => lineScore(l, terms));
	if (scores.every((s) => s === 0)) return `${text.slice(0, maxChars)}…`;

	const { start, end } = bestWindow(lines, scores, maxChars);
	const body = lines.slice(start, end + 1).join("\n").trim();
	// Ellipses mark that this is an excerpt, so the reader knows to open the file for more.
	// A hard clip already ends in one; don't stack a second.
	const truncated = body.length > maxChars;
	const head = start > 0 ? "…" : "";
	const tail = truncated || end < lines.length - 1 ? "…" : "";
	return `${head}${truncated ? body.slice(0, maxChars) : body}${tail}`;
}
