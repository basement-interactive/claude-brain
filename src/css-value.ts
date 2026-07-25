// Turning a CSS value into something a design note can state as fact.
//
// The whole URL capture rests on one check: every hex the model hands back must appear in
// the evidence we actually measured, or it is a colour it invented and gets dropped. That
// check only works if we can reduce what the page really wrote to the same form the model
// answers in.
//
// Which makes colour conversion load-bearing rather than a nicety. Current Tailwind and
// shadcn ship their palettes as `oklch()`, and a DesignSpec palette is hex. Pass oklch
// through untouched and every hex the model returns is a conversion that appears nowhere
// in the payload — so the guard deletes the entire palette on exactly the modern sites
// people most want to copy, and the design lands empty while looking like it worked.
//
// So: convert locally, and print both forms in the payload (`#533afd (from oklch(...))`),
// which keeps the containment check honest AND lets the model quote either.

const NAMED: Record<string, string> = {
	black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
	yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff",
	gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000",
	purple: "#800080", teal: "#008080", navy: "#000080", lime: "#00ff00", orange: "#ffa500",
	pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee",
	beige: "#f5f5dc", ivory: "#fffff0", khaki: "#f0e68c", coral: "#ff7f50", salmon: "#fa8072",
	crimson: "#dc143c", turquoise: "#40e0d0", tan: "#d2b48c", plum: "#dda0dd", orchid: "#da70d6",
	slategray: "#708090", slategrey: "#708090", whitesmoke: "#f5f5f5", snow: "#fffafa",
	ghostwhite: "#f8f8ff", aliceblue: "#f0f8ff", lavender: "#e6e6fa", azure: "#f0ffff",
	midnightblue: "#191970", darkslategray: "#2f4f4f", dimgray: "#696969", lightgray: "#d3d3d3",
	lightgrey: "#d3d3d3", gainsboro: "#dcdcdc", rebeccapurple: "#663399",
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function toByte(channel: number): string {
	return Math.round(clamp01(channel) * 255)
		.toString(16)
		.padStart(2, "0");
}

/** Linear-light sRGB to the gamma-encoded values a hex string holds. */
function gammaEncode(c: number): number {
	return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function linearRgbToHex(r: number, g: number, b: number): string {
	return `#${toByte(gammaEncode(r))}${toByte(gammaEncode(g))}${toByte(gammaEncode(b))}`;
}

/**
 * OKLab to sRGB, with the coefficients from Björn Ottosson's published derivation. Pinned
 * by fixtures in the test suite — a transposed digit here silently shifts every colour the
 * capture reports, which is the kind of wrong that still looks plausible.
 */
function oklabToHex(L: number, a: number, b: number): string {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	return linearRgbToHex(
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	);
}

/** CIE Lab is D50-referenced in CSS; XYZ then Bradford-adapted to D65 for sRGB. */
function labToHex(L: number, a: number, bb: number): string {
	const fy = (L + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - bb / 200;
	const d = 6 / 29;
	const inv = (t: number): number => (t > d ? t * t * t : 3 * d * d * (t - 4 / 29));
	// D50 white point
	const X = 0.9642956 * inv(fx);
	const Y = 1.0 * inv(fy);
	const Z = 0.8251046 * inv(fz);
	// Bradford D50 -> D65, then XYZ -> linear sRGB, pre-multiplied.
	const r = 3.1341359 * X - 1.6172247 * Y - 0.4906146 * Z;
	const g = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
	const b2 = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
	return linearRgbToHex(r, g, b2);
}

function hslToHex(h: number, s: number, l: number): string {
	const hh = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x]
		: hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
	return `#${toByte(r + m)}${toByte(g + m)}${toByte(b + m)}`;
}

/** Split a function's arguments, honouring nesting and both separators CSS allows. */
function args(inner: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of inner) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (depth === 0 && (ch === "," || ch === "/" || ch === " ")) {
			if (ch === "/") {
				// alpha separator — everything after it is opacity, which a hex palette drops
				if (cur.trim()) out.push(cur.trim());
				cur = "";
				break;
			}
			if (cur.trim()) out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/** A number, resolving % against `scale` and treating `none` as 0 (CSS Color 4). */
function num(token: string | undefined, scale = 1): number {
	if (!token) return 0;
	const t = token.trim().toLowerCase();
	if (t === "none") return 0;
	if (t.endsWith("%")) return (Number.parseFloat(t) / 100) * scale;
	if (t.endsWith("deg")) return Number.parseFloat(t);
	if (t.endsWith("turn")) return Number.parseFloat(t) * 360;
	if (t.endsWith("rad")) return (Number.parseFloat(t) * 180) / Math.PI;
	const n = Number.parseFloat(t);
	return Number.isFinite(n) ? n : 0;
}

function fnBody(value: string, name: string): string | null {
	const lower = value.trim().toLowerCase();
	if (!lower.startsWith(`${name}(`)) return null;
	const open = value.indexOf("(");
	const close = value.lastIndexOf(")");
	return open >= 0 && close > open ? value.slice(open + 1, close) : null;
}

/**
 * Any CSS colour to `#rrggbb`, or null when the value is not a colour at all. Alpha is
 * dropped on purpose: a design note states "the accent is #533afd", and an opacity that
 * only exists in one component is noise at that level.
 */
export function toHex(input: string): string | null {
	const value = input.trim();
	if (!value) return null;
	const lower = value.toLowerCase();

	if (lower.startsWith("#")) {
		const h = lower.slice(1);
		if (/^[0-9a-f]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
		if (/^[0-9a-f]{4}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
		if (/^[0-9a-f]{6}$/.test(h)) return `#${h}`;
		if (/^[0-9a-f]{8}$/.test(h)) return `#${h.slice(0, 6)}`;
		return null;
	}

	if (NAMED[lower]) return NAMED[lower] ?? null;

	let body = fnBody(value, "rgb") ?? fnBody(value, "rgba");
	if (body !== null) {
		const p = args(body);
		const scale = (p[0] ?? "").includes("%") ? 1 : 255;
		return `#${toByte(num(p[0], 1) / (scale === 255 ? 255 : 1))}${toByte(num(p[1], 1) / (scale === 255 ? 255 : 1))}${toByte(num(p[2], 1) / (scale === 255 ? 255 : 1))}`;
	}

	body = fnBody(value, "hsl") ?? fnBody(value, "hsla");
	if (body !== null) {
		const p = args(body);
		return hslToHex(num(p[0]), num(p[1], 1) / (p[1]?.includes("%") ? 1 : 1), num(p[2], 1) / (p[2]?.includes("%") ? 1 : 1));
	}

	body = fnBody(value, "oklch");
	if (body !== null) {
		const p = args(body);
		const L = num(p[0], 1);
		const C = num(p[1], 0.4);
		const H = num(p[2]);
		const rad = (H * Math.PI) / 180;
		return oklabToHex(L, C * Math.cos(rad), C * Math.sin(rad));
	}

	body = fnBody(value, "oklab");
	if (body !== null) {
		const p = args(body);
		return oklabToHex(num(p[0], 1), num(p[1], 0.4), num(p[2], 0.4));
	}

	body = fnBody(value, "lch");
	if (body !== null) {
		const p = args(body);
		const L = num(p[0], 100);
		const C = num(p[1], 150);
		const H = num(p[2]);
		const rad = (H * Math.PI) / 180;
		return labToHex(L, C * Math.cos(rad), C * Math.sin(rad));
	}

	body = fnBody(value, "lab");
	if (body !== null) {
		const p = args(body);
		return labToHex(num(p[0], 100), num(p[1], 125), num(p[2], 125));
	}

	// color-mix(in <space>, A p%, B q%) — shadcn and Tailwind v4 use this for hover and
	// border tints, so the mixed result IS the colour that appears on screen.
	body = fnBody(value, "color-mix");
	if (body !== null) {
		const parts: string[] = [];
		let depth = 0;
		let cur = "";
		for (const ch of body) {
			if (ch === "(") depth++;
			if (ch === ")") depth--;
			if (ch === "," && depth === 0) {
				parts.push(cur.trim());
				cur = "";
				continue;
			}
			cur += ch;
		}
		if (cur.trim()) parts.push(cur.trim());
		if (parts.length >= 3) {
			const readStop = (stop: string): { hex: string | null; pct: number | null } => {
				const m = /(.*?)\s+([\d.]+)%\s*$/.exec(stop);
				return m ? { hex: toHex(m[1] ?? ""), pct: Number.parseFloat(m[2] ?? "") } : { hex: toHex(stop), pct: null };
			};
			const a = readStop(parts[1] ?? "");
			const b = readStop(parts[2] ?? "");
			if (a.hex && b.hex) {
				const wa = a.pct !== null ? a.pct / 100 : b.pct !== null ? 1 - b.pct / 100 : 0.5;
				const mix = (i: number): number => {
					const ca = Number.parseInt((a.hex as string).slice(1 + i * 2, 3 + i * 2), 16) / 255;
					const cb = Number.parseInt((b.hex as string).slice(1 + i * 2, 3 + i * 2), 16) / 255;
					return ca * wa + cb * (1 - wa);
				};
				return `#${toByte(mix(0))}${toByte(mix(1))}${toByte(mix(2))}`;
			}
		}
		return null;
	}

	return null;
}

/**
 * Substitute `var(--x)` from a token table, honouring the fallback arm. Without this,
 * every colour on a token-driven site resolves to nothing: the declaration says
 * `color: var(--text-primary)` and the hex lives three indirections away.
 */
export function resolveVars(value: string, table: Map<string, string>, depth = 0): string {
	if (depth > 8 || !value.includes("var(")) return value;
	let out = "";
	let i = 0;
	while (i < value.length) {
		const at = value.indexOf("var(", i);
		if (at < 0) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, at);
		let d = 0;
		let j = at + 3;
		for (; j < value.length; j++) {
			if (value[j] === "(") d++;
			else if (value[j] === ")") {
				d--;
				if (d === 0) break;
			}
		}
		const inner = value.slice(at + 4, j);
		const comma = ((): number => {
			let dd = 0;
			for (let k = 0; k < inner.length; k++) {
				if (inner[k] === "(") dd++;
				else if (inner[k] === ")") dd--;
				else if (inner[k] === "," && dd === 0) return k;
			}
			return -1;
		})();
		const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
		const fallback = comma < 0 ? "" : inner.slice(comma + 1).trim();
		const hit = table.get(name);
		out += hit !== undefined ? resolveVars(hit, table, depth + 1) : resolveVars(fallback, table, depth + 1);
		i = j + 1;
	}
	return out;
}

/**
 * The single-operation `calc()` that token systems actually emit — Tailwind v4 writes its
 * whole spacing scale as `calc(var(--spacing) * 6)`. Also recognises the sentinel a pill
 * radius is written as, which must not be reported as a 3.4e38px corner.
 */
export function evalCalc(value: string): string {
	const v = value.trim();
	// Browsers serialise `calc(infinity * 1px)` with varying precision — 3.40282e38px on
	// Tailwind v4, 3.4028235e38px elsewhere — so match the float rather than one spelling.
	if (/^(calc\()?\s*(infinity\s*\*\s*1px|3\.40282\d*e\+?38px)\s*\)?$/i.test(v)) return "9999px";
	const body = fnBody(v, "calc");
	if (body === null) return v;
	const m = /^\s*([\d.]+)(px|rem|em|%)?\s*([*/+-])\s*([\d.]+)(px|rem|em|%)?\s*$/.exec(body);
	if (!m) return v;
	const a = Number.parseFloat(m[1] ?? "0");
	const b = Number.parseFloat(m[4] ?? "0");
	const unit = m[2] ?? m[5] ?? "";
	const op = m[3];
	const r = op === "*" ? a * b : op === "/" ? (b === 0 ? a : a / b) : op === "+" ? a + b : a - b;
	return `${Number.isInteger(r) ? r : Number(r.toFixed(4))}${unit}`;
}

/** Perceptual distance in OKLab, for deciding whether a model's hex is one we measured. */
export function deltaEOk(a: string, b: string): number {
	const lab = (hex: string): [number, number, number] => {
		const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		const r = toLinear(Number.parseInt(hex.slice(1, 3), 16) / 255);
		const g = toLinear(Number.parseInt(hex.slice(3, 5), 16) / 255);
		const bl = toLinear(Number.parseInt(hex.slice(5, 7), 16) / 255);
		const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
		const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
		const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
		return [
			0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
			1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
			0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
		];
	};
	if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return Number.POSITIVE_INFINITY;
	const [l1, a1, b1] = lab(a.toLowerCase());
	const [l2, a2, b2] = lab(b.toLowerCase());
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
