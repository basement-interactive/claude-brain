// Colour conversion is load-bearing for the URL capture: the only guard against a
// fabricated palette is that every hex the model returns appears in the evidence we
// measured, and modern token systems write their palettes in oklch. A transposed
// coefficient here would shift every reported colour while still looking plausible, so the
// published vectors are pinned.

import { describe, expect, test } from "bun:test";
import { deltaEOk, evalCalc, resolveVars, toHex } from "../src/css-value";

describe("toHex — the forms a stylesheet actually uses", () => {
	test("hex, including the alpha forms whose opacity a palette drops", () => {
		expect(toHex("#fff")).toBe("#ffffff");
		expect(toHex("#0D0D0D")).toBe("#0d0d0d");
		expect(toHex("#ff000080")).toBe("#ff0000");
	});

	test("rgb, comma and modern space separated", () => {
		expect(toHex("rgb(255, 0, 0)")).toBe("#ff0000");
		expect(toHex("rgb(13 13 13)")).toBe("#0d0d0d");
		expect(toHex("rgba(26, 26, 26, 0.5)")).toBe("#1a1a1a");
	});

	test("hsl", () => {
		expect(toHex("hsl(0, 100%, 50%)")).toBe("#ff0000");
		expect(toHex("hsl(240 100% 50%)")).toBe("#0000ff");
	});

	test("named colours", () => {
		expect(toHex("white")).toBe("#ffffff");
		expect(toHex("rebeccapurple")).toBe("#663399");
	});

	test("returns null for things that are not colours", () => {
		expect(toHex("not-a-colour")).toBeNull();
		expect(toHex("")).toBeNull();
		expect(toHex("1px solid")).toBeNull();
	});
});

describe("toHex — oklch, which is what Tailwind v4 and shadcn ship", () => {
	test("published vectors", () => {
		expect(toHex("oklch(1 0 0)")).toBe("#ffffff");
		expect(toHex("oklch(0 0 0)")).toBe("#000000");
		// Ottosson's sRGB red.
		expect(toHex("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
	});

	test("percentage lightness and chroma are accepted", () => {
		expect(toHex("oklch(100% 0 0)")).toBe("#ffffff");
	});

	test("an alpha arm does not derail the parse", () => {
		expect(toHex("oklch(1 0 0 / 0.5)")).toBe("#ffffff");
	});

	test("oklab agrees with the oklch spelling of the same colour", () => {
		const viaLch = toHex("oklch(0.628 0.2577 29.23)");
		const rad = (29.23 * Math.PI) / 180;
		const viaLab = toHex(`oklab(0.628 ${0.2577 * Math.cos(rad)} ${0.2577 * Math.sin(rad)})`);
		expect(viaLab).toBe(viaLch);
	});

	test("lab and lch parse to something sane", () => {
		expect(toHex("lab(100 0 0)")).toBe("#ffffff");
		expect(toHex("lch(0 0 0)")).toBe("#000000");
	});
});

describe("toHex — color-mix, used for hover and border tints", () => {
	test("an even mix of black and white is mid grey", () => {
		expect(toHex("color-mix(in srgb, #000000 50%, #ffffff)")).toBe("#808080");
	});

	test("the second stop's percentage implies the first", () => {
		// The percentage belongs to the stop it follows: 25% white over 75% black is
		// dark, not light. Worth pinning — it is the easy one to get backwards.
		expect(toHex("color-mix(in srgb, #000000, #ffffff 25%)")).toBe("#404040");
	});
});

describe("resolveVars", () => {
	test("resolves through indirection", () => {
		const t = new Map([
			["--bg", "#0d0d0d"],
			["--surface", "var(--bg)"],
		]);
		expect(resolveVars("var(--surface)", t)).toBe("#0d0d0d");
	});

	test("uses the fallback arm when the token is undefined", () => {
		expect(resolveVars("var(--nope, #ececf1)", new Map())).toBe("#ececf1");
	});

	test("a cycle terminates instead of hanging the capture", () => {
		const t = new Map([
			["--a", "var(--b)"],
			["--b", "var(--a)"],
		]);
		expect(() => resolveVars("var(--a)", t)).not.toThrow();
	});
});

describe("evalCalc", () => {
	test("the single operation token systems emit", () => {
		expect(evalCalc("calc(0.25rem * 6)")).toBe("1.5rem");
		expect(evalCalc("calc(16px + 8px)")).toBe("24px");
	});

	test("the pill sentinel is a pill, not a 3.4e38px corner", () => {
		expect(evalCalc("calc(infinity * 1px)")).toBe("9999px");
		// The serialised forms real engines emit; tailwindcss.com ships the 5-digit one.
		expect(evalCalc("3.40282e38px")).toBe("9999px");
		expect(evalCalc("3.4028235e38px")).toBe("9999px");
	});

	test("leaves anything more complicated alone rather than guessing", () => {
		expect(evalCalc("calc(100% - var(--x))")).toBe("calc(100% - var(--x))");
	});
});

describe("deltaEOk", () => {
	test("near-identical colours are close, opposites are far", () => {
		expect(deltaEOk("#ff0000", "#fe0000")).toBeLessThan(0.01);
		expect(deltaEOk("#ff0000", "#00ff00")).toBeGreaterThan(0.3);
	});

	test("a malformed hex is infinitely far, never accidentally near", () => {
		expect(deltaEOk("#ff0000", "nope")).toBe(Number.POSITIVE_INFINITY);
	});
});
