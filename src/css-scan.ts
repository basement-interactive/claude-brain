// A CSS scanner that survives what real stylesheets contain.
//
// Regex over a whole sheet looks fine on hand-written CSS and quietly destroys generated
// CSS, which is nearly all of it now. The four things that actually break naive parsers,
// each of which produces plausible-looking output while losing most of the file:
//
//   - `\` escapes the NEXT character anywhere, selectors included. Tailwind emits
//     `.bg-\[url\(\'\/x\.png\'\)\]`; read that `'` as a string opener and everything after
//     it is misparsed. A measured prototype lost 80% of its rules exactly here.
//   - `url(...)` is one token. Unquoted data URIs contain `;`, `,` and `{`, so splitting
//     declarations on `;` without knowing about url() truncates the sheet.
//   - `/* */` must be stripped by the tokenizer, not by a global replace: a data URI
//     containing the two characters `/*` swallows the rest of the file.
//   - At-rules nest. `@media` children are ordinary rules and must be kept (that is where
//     the dark theme lives); `@font-face` and `@property` are not rules at all.
//
// Anything unparseable is skipped and counted, never thrown: one malformed block should
// cost its own rule, not the other six thousand.

export interface CssRule {
	selector: string;
	decls: Array<[string, string]>;
	/** The @media/@supports/@container chain this rule sits under, joined with " and ". */
	cond: string;
	/** Document order, so later rules can be understood to win. */
	order: number;
}

export interface CssSheet {
	rules: CssRule[];
	/** Custom properties by scope, e.g. ":root" -> { "--bg": "#0d0d0d" }. */
	vars: Map<string, Map<string, string>>;
	fontFaces: Array<Record<string, string>>;
	imports: string[];
	keyframes: string[];
	/** Blocks the scanner could not make sense of. Ships in the payload as honesty. */
	skipped: number;
}

const AT_CONDITIONAL = new Set(["media", "supports", "container", "layer", "scope", "document"]);

/**
 * `url(` starts a token that runs to its matching `)` and means nothing inside: no comment
 * opener, no string delimiter. An unquoted data URI routinely contains `/*`, `'` and `;`,
 * and treating any of them as syntax silently truncates the rest of the sheet.
 * Returns the index just past the closing paren, or -1 if this is not a url( at `at`.
 */
function urlTokenEnd(text: string, at: number): number {
	if (text.slice(at, at + 4).toLowerCase() !== "url(") return -1;
	let depth = 1;
	let j = at + 4;
	let quote = "";
	while (j < text.length) {
		const ch = text[j] as string;
		if (quote) {
			if (ch === "\\") j++;
			else if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return j + 1;
		}
		j++;
	}
	return text.length;
}

/** Split a declaration list, honouring strings, url() and nesting. */
function splitDecls(body: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	let buf = "";
	let depth = 0;
	let quote = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (quote) {
			buf += ch;
			if (ch === "\\") {
				buf += body[i + 1] ?? "";
				i++;
			} else if (ch === quote) quote = "";
			continue;
		}
		if (ch === "\\") {
			buf += ch + (body[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === "(") depth++;
		if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch === ";" && depth === 0) {
			pushDecl(out, buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	pushDecl(out, buf);
	return out;
}

function pushDecl(out: Array<[string, string]>, raw: string): void {
	const text = raw.trim();
	if (!text) return;
	// Only the FIRST colon separates; `background: url(a:b)` and `grid: a/b` must survive.
	const at = text.indexOf(":");
	if (at <= 0) return;
	const prop = text.slice(0, at).trim().toLowerCase();
	const value = text.slice(at + 1).trim();
	if (!prop || !value) return;
	out.push([prop, value]);
}

/**
 * Scan one stylesheet. `order` continues across sheets so the caller can reason about
 * which declaration would have won.
 */
export function scanCss(text: string, startOrder = 0): CssSheet {
	const sheet: CssSheet = {
		rules: [],
		vars: new Map(),
		fontFaces: [],
		imports: [],
		keyframes: [],
		skipped: 0,
	};
	let order = startOrder;
	const conds: string[] = [];
	let i = 0;
	const n = text.length;

	// Read forward to a delimiter at nesting depth 0, respecting escapes, strings,
	// comments and url(). Returns the raw slice and leaves `i` past the delimiter.
	function readUntil(stops: string): string {
		let buf = "";
		let quote = "";
		let depth = 0;
		while (i < n) {
			const ch = text[i] as string;
			if (quote) {
				if (ch === "\\") {
					buf += ch + (text[i + 1] ?? "");
					i += 2;
					continue;
				}
				if (ch === quote) quote = "";
				buf += ch;
				i++;
				continue;
			}
			if (ch === "\\") {
				buf += ch + (text[i + 1] ?? "");
				i += 2;
				continue;
			}
			if (ch === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				i = end < 0 ? n : end + 2;
				continue;
			}
			const urlEnd = urlTokenEnd(text, i);
			if (urlEnd >= 0) {
				buf += text.slice(i, urlEnd);
				i = urlEnd;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				buf += ch;
				i++;
				continue;
			}
			if (ch === "(") depth++;
			if (ch === ")") depth = Math.max(0, depth - 1);
			if (depth === 0 && stops.includes(ch)) {
				i++;
				return buf;
			}
			buf += ch;
			i++;
		}
		return buf;
	}

	/** Consume a balanced { ... } starting at the brace, returning its inside. */
	function readBlock(): string {
		let buf = "";
		let depth = 1;
		let quote = "";
		while (i < n && depth > 0) {
			const ch = text[i] as string;
			if (quote) {
				if (ch === "\\") {
					buf += ch + (text[i + 1] ?? "");
					i += 2;
					continue;
				}
				if (ch === quote) quote = "";
				buf += ch;
				i++;
				continue;
			}
			if (ch === "\\") {
				buf += ch + (text[i + 1] ?? "");
				i += 2;
				continue;
			}
			if (ch === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				i = end < 0 ? n : end + 2;
				continue;
			}
			const urlEnd = urlTokenEnd(text, i);
			if (urlEnd >= 0) {
				buf += text.slice(i, urlEnd);
				i = urlEnd;
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					i++;
					return buf;
				}
			}
			buf += ch;
			i++;
		}
		return buf;
	}

	function record(selector: string, body: string): void {
		const decls = splitDecls(body);
		if (decls.length === 0) return;
		const sel = selector.trim().replace(/\s+/g, " ");
		const cond = conds.join(" and ");
		// Custom properties are the token layer; keep them keyed by the selector that
		// scopes them, because :root and [data-theme=dark] are two different palettes.
		for (const [prop, value] of decls) {
			if (!prop.startsWith("--")) continue;
			let scope = sheet.vars.get(sel);
			if (!scope) {
				scope = new Map();
				sheet.vars.set(sel, scope);
			}
			scope.set(prop, value);
		}
		sheet.rules.push({ selector: sel, decls, cond, order: order++ });
	}

	function walk(depth: number): void {
		while (i < n) {
			// skip whitespace and comments between rules
			const ch = text[i] as string;
			if (ch === undefined) break;
			if (ch === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				i = end < 0 ? n : end + 2;
				continue;
			}
			if (ch === "}") {
				i++;
				// Only ends something if we are inside an at-rule. At the top level this is
				// stray punctuation — from a truncated fetch, or a sheet concatenated badly
				// — and returning here would abandon every rule after it.
				if (depth > 0) return;
				sheet.skipped++;
				continue;
			}
			if (/\s/.test(ch)) {
				i++;
				continue;
			}

			if (ch === "@") {
				const prelude = readUntil("{;");
				const closedWithBrace = text[i - 1] === "{";
				const name = (/^@([a-z-]+)/i.exec(prelude)?.[1] ?? "").toLowerCase();
				if (!closedWithBrace) {
					if (name === "import") sheet.imports.push(prelude.slice(prelude.indexOf(" ") + 1).trim());
					continue;
				}
				if (AT_CONDITIONAL.has(name)) {
					conds.push(prelude.trim());
					walk(depth + 1);
					conds.pop();
					continue;
				}
				const body = readBlock();
				if (name === "font-face") {
					const face: Record<string, string> = {};
					for (const [p, v] of splitDecls(body)) face[p] = v;
					sheet.fontFaces.push(face);
				} else if (name === "keyframes" || name === "-webkit-keyframes") {
					const kf = prelude.trim().split(/\s+/)[1];
					if (kf) sheet.keyframes.push(kf);
				} else if (name === "property") {
					// @property declares a token's type; the initial-value is a real default.
					const decls = splitDecls(body);
					const initial = decls.find(([p]) => p === "initial-value");
					const token = /--[\w-]+/.exec(prelude)?.[0];
					if (token && initial) {
						let scope = sheet.vars.get(":root");
						if (!scope) {
							scope = new Map();
							sheet.vars.set(":root", scope);
						}
						if (!scope.has(token)) scope.set(token, initial[1]);
					}
				}
				continue;
			}

			const selector = readUntil("{");
			if (i > n) {
				sheet.skipped++;
				return;
			}
			if (!selector.trim()) {
				// A stray block with no selector — skip its body rather than desync.
				readBlock();
				sheet.skipped++;
				continue;
			}
			record(selector, readBlock());
		}
	}

	try {
		walk(0);
	} catch {
		sheet.skipped++;
	}
	return sheet;
}

/** Every custom property, flattened for var() resolution. Later scopes win. */
export function flattenVars(sheets: CssSheet[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const sheet of sheets) {
		for (const scope of sheet.vars.values()) {
			for (const [k, v] of scope) out.set(k, v);
		}
	}
	return out;
}

/** Custom properties referenced somewhere but defined nowhere — the demand signal that
 *  tells the caller another stylesheet is worth fetching. */
export function undefinedVars(sheets: CssSheet[]): Set<string> {
	const defined = new Set<string>();
	for (const sheet of sheets) {
		for (const scope of sheet.vars.values()) for (const k of scope.keys()) defined.add(k);
	}
	const wanted = new Set<string>();
	for (const sheet of sheets) {
		for (const rule of sheet.rules) {
			for (const [, value] of rule.decls) {
				for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
					const name = m[1];
					if (name && !defined.has(name)) wanted.add(name);
				}
			}
		}
	}
	return wanted;
}
