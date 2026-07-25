// Each case here is a shape that defeats a regex-based parser while still producing
// output that looks fine, which is the dangerous kind of wrong.

import { describe, expect, test } from "bun:test";
import { flattenVars, scanCss, undefinedVars } from "../src/css-scan";

describe("scanCss — the shapes generated CSS actually contains", () => {
	test("an escaped Tailwind selector keeps its declarations", () => {
		// Reading the escaped quote as a string opener misparses everything after it.
		const s = scanCss(String.raw`.bg-\[url\(\'\/x\.png\'\)\] { color: #fff }`);
		expect(s.rules).toHaveLength(1);
		expect(s.rules[0]?.decls).toEqual([["color", "#fff"]]);
		expect(s.skipped).toBe(0);
	});

	test("a comment containing a brace does not desync the block structure", () => {
		const s = scanCss(`/* here { is a brace */ .a { color: red } .b { color: blue }`);
		expect(s.rules.map((r) => r.selector)).toEqual([".a", ".b"]);
	});

	test("a data URI containing the comment opener does not swallow the sheet", () => {
		const s = scanCss(`.a { background: url(data:image/svg+xml;base64,AA/*BB) } .b { color: red }`);
		expect(s.rules.map((r) => r.selector)).toEqual([".a", ".b"]);
	});

	test("a value's internal commas and colons survive", () => {
		const s = scanCss(`.btn { transition: color .3s cubic-bezier(.25,1,.5,1), transform .2s }`);
		expect(s.rules[0]?.decls[0]?.[1]).toBe("color .3s cubic-bezier(.25,1,.5,1), transform .2s");
	});

	test("only the first colon splits a declaration", () => {
		const s = scanCss(`.a { background: url(http://x/y.png) }`);
		expect(s.rules[0]?.decls[0]).toEqual(["background", "url(http://x/y.png)"]);
	});
});

describe("scanCss — at-rules", () => {
	test("media children are kept, carrying their condition", () => {
		const s = scanCss(`@media (min-width: 768px) { .btn { padding: 10px } }`);
		expect(s.rules).toHaveLength(1);
		expect(s.rules[0]?.cond).toContain("min-width: 768px");
		expect(s.rules[0]?.selector).toBe(".btn");
	});

	test("font-face and keyframes are separated from ordinary rules", () => {
		const s = scanCss(`@font-face { font-family: "Sohne"; src: url(/s.woff2) } @keyframes spin { from { opacity: 0 } }`);
		expect(s.fontFaces[0]?.["font-family"]).toBe('"Sohne"');
		expect(s.keyframes).toEqual(["spin"]);
		expect(s.rules).toHaveLength(0);
	});

	test("imports are captured rather than silently dropped", () => {
		const s = scanCss(`@import url("theme.css");`);
		expect(s.imports).toHaveLength(1);
	});
});

describe("scanCss — the token layer", () => {
	test("custom properties are kept per scope, because themes are scopes", () => {
		const s = scanCss(`:root { --bg: #0d0d0d } [data-theme="dark"] { --bg: #000 }`);
		expect(s.vars.get(":root")?.get("--bg")).toBe("#0d0d0d");
		expect(s.vars.get('[data-theme="dark"]')?.get("--bg")).toBe("#000");
	});

	test("undefined var references are reported as demand", () => {
		const s = scanCss(`.a { color: var(--defined); background: var(--absent) } :root { --defined: red }`);
		expect([...undefinedVars([s])]).toEqual(["--absent"]);
	});

	test("flattenVars merges across sheets", () => {
		const a = scanCss(`:root { --bg: #fff }`);
		const b = scanCss(`:root { --fg: #000 }`);
		const flat = flattenVars([a, b]);
		expect(flat.get("--bg")).toBe("#fff");
		expect(flat.get("--fg")).toBe("#000");
	});
});

describe("scanCss — damage control", () => {
	test("an unterminated block does not throw", () => {
		expect(() => scanCss(`.a { color: red`)).not.toThrow();
	});

	test("garbage is skipped and counted rather than crashing the capture", () => {
		const s = scanCss(`}}} .a { color: red }`);
		expect(s.rules.some((r) => r.selector === ".a")).toBe(true);
	});
});
