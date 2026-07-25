// The only place in the brain that fetches something the user typed.
//
// A design capture takes a URL from a text box and asks the server to go get it, which is
// the textbook shape of an SSRF: the request comes from inside the machine, so it reaches
// whatever the machine can reach — the cloud metadata endpoint, a router admin page, a
// service bound to loopback that assumed nothing local was hostile. Everything here exists
// to make "go fetch this" mean "go fetch something on the public internet, and nothing
// else, no matter how the address is dressed up".
//
// The parts that are easy to get subtly wrong, and why they are written the way they are:
//
//   - Resolution is checked for EVERY address a name returns, not the first. A name that
//     answers with one public address and one private address is a deliberate attack, and
//     a guard that reads addrs[0] waves it through half the time.
//   - IPv6 has three ways to spell an IPv4 address (::ffff: mapped, NAT64, 6to4). Each is
//     unwrapped and the embedded v4 re-checked, or 64:ff9b::7f00:1 walks straight past a
//     v6-only deny-list to 127.0.0.1.
//   - Redirects are walked by hand with the full gate re-run per hop. `redirect: "follow"`
//     resolves later hops inside fetch where no check can see them, which turns any open
//     redirector into a bypass.
//   - Byte caps count DECOMPRESSED bytes. Bun inflates transparently, so Content-Length
//     describes the compressed stream and a 2 MB cap on it happily accepts a 2 GB bomb.
//
// Deliberately NOT solved here: DNS rebinding between the gate and the connect. Closing it
// needs the socket pinned to the validated address; `pinnedFetch` does that where it can
// and reports honestly when it cannot, because a pin that has been silently defeated is
// worse than one the caller knows is absent.

import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Ports a design lives on. Anything else is a service scan wearing a URL. */
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** Suffixes that only ever name something inside the fence. */
const PRIVATE_SUFFIXES = [".local", ".internal", ".home.arpa", ".lan", ".localdomain"];

const DENY = new BlockList();
// v4: unspecified, RFC1918, CGNAT, loopback, link-local (incl. cloud metadata at
// 169.254.169.254), IETF protocol assignments, benchmarking, multicast, reserved.
for (const [addr, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as Array<[string, number]>) {
	DENY.addSubnet(addr, prefix, "ipv4");
}
// v6: unspecified, loopback, unique-local, link-local, multicast.
for (const [addr, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as Array<[string, number]>) {
	DENY.addSubnet(addr, prefix, "ipv6");
}

/**
 * Every IPv4 address hiding inside an IPv6 one. `::ffff:7f00:1`, NAT64's `64:ff9b::/96`
 * and 6to4's `2002::/16` all carry a v4 address in their low bits, and each is a complete
 * bypass of a v6-only deny-list.
 */
function embeddedV4(addr: string): string[] {
	const out: string[] = [];
	const lower = addr.toLowerCase();
	// The dotted form the platform hands back for mapped addresses.
	const dotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
	if (dotted?.[1]) out.push(dotted[1]);
	// Hex forms: pull the last two groups and read them as the four v4 octets.
	const groups = lower.split(":").filter(Boolean);
	const isNat64 = lower.startsWith("64:ff9b:");
	const isSixToFour = lower.startsWith("2002:");
	const isMapped = lower.includes("ffff:") && groups.length >= 2;
	if ((isNat64 || isMapped) && groups.length >= 2) {
		const hi = Number.parseInt(groups[groups.length - 2] ?? "", 16);
		const lo = Number.parseInt(groups[groups.length - 1] ?? "", 16);
		if (Number.isFinite(hi) && Number.isFinite(lo)) {
			out.push(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
		}
	}
	if (isSixToFour && groups.length >= 3) {
		const hi = Number.parseInt(groups[1] ?? "", 16);
		const lo = Number.parseInt(groups[2] ?? "", 16);
		if (Number.isFinite(hi) && Number.isFinite(lo)) {
			out.push(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
		}
	}
	return out;
}

/** Is this address off-limits, counting every v4 address embedded in a v6 one? */
export function addressIsBlocked(addr: string): boolean {
	const family = isIP(addr);
	if (family === 0) return true; // unparseable is not something we connect to
	if (DENY.check(addr, family === 4 ? "ipv4" : "ipv6")) return true;
	for (const v4 of embeddedV4(addr)) {
		if (isIP(v4) === 4 && DENY.check(v4, "ipv4")) return true;
	}
	return false;
}

export type Rejected = { reject: string };

/**
 * Parse and vet the shape of a URL, before any name is resolved. WHATWG `URL` does the
 * hardest part for free: it normalises IDN to ASCII and collapses the classic obfuscations
 * (`0177.0.0.1` and `2130706433` both come out as `127.0.0.1`), so those need no special
 * case here — verified on Bun 1.3.
 */
export function canonicalUrl(input: string): URL | Rejected {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { reject: "that is not a URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { reject: `${url.protocol.replace(":", "")} links cannot be captured — use http or https` };
	}
	// Credentials in a URL are never how a public page is addressed, and they would be
	// forwarded on redirect.
	if (url.username || url.password) return { reject: "a URL with credentials in it will not be fetched" };
	if (!ALLOWED_PORTS.has(url.port)) return { reject: `port ${url.port} is not a website port` };

	const host = url.hostname.toLowerCase();
	if (!host) return { reject: "that URL has no host" };
	// A bare label ("http://intranet/") can only mean something on the local network.
	if (isIP(host) === 0 && !host.includes(".")) return { reject: "that looks like a name on your own network" };
	for (const suffix of PRIVATE_SUFFIXES) {
		if (host.endsWith(suffix)) return { reject: `${suffix} names are on your own network` };
	}
	// A literal address skips DNS entirely, so gate it here too.
	if (isIP(host) !== 0 && addressIsBlocked(host)) return { reject: "that address is on your own network" };
	return url;
}

export interface GateResult {
	addresses: string[];
}

/**
 * Resolve a host and refuse it unless EVERY address it answers with is public. Returning
 * the addresses lets the caller pin the connection to one it has actually checked.
 */
export async function resolveAndGate(host: string): Promise<GateResult | Rejected> {
	if (isIP(host) !== 0) {
		return addressIsBlocked(host) ? { reject: "that address is on your own network" } : { addresses: [host] };
	}
	let answers: Array<{ address: string }>;
	try {
		answers = await lookup(host, { all: true, verbatim: true });
	} catch {
		return { reject: `could not look up ${host}` };
	}
	if (answers.length === 0) return { reject: `${host} does not resolve` };
	for (const a of answers) {
		if (addressIsBlocked(a.address)) return { reject: `${host} points at your own network` };
	}
	return { addresses: answers.map((a) => a.address) };
}

export interface FetchLimits {
	/** Cap on DECOMPRESSED bytes. Content-Length describes the compressed stream. */
	maxBytes: number;
	/** Whole-request deadline. */
	timeoutMs: number;
	/** Abort if no chunk arrives for this long, so a trickle cannot hold the slot open. */
	stallMs: number;
	/** Substrings, any of which the content-type may contain. */
	accept: string[];
}

export interface GuardedResponse {
	url: string;
	status: number;
	contentType: string;
	/** UTF-8 decode of `bytes`. Meaningless for an image — use `bytes` for those. */
	body: string;
	/** The octets as they arrived. Decoding binary as UTF-8 is lossy and irreversible, so
	 *  anything that is not text has to read this instead. */
	bytes: Uint8Array;
	/** True when a proxy env var was set, so the address pin could not be trusted. */
	proxied: boolean;
	truncated: boolean;
}

const MAX_HOPS = 3;

const UA = "claude-brain (local design capture; contact: the person running this)";

function proxyConfigured(): boolean {
	for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
		if (process.env[key]) return true;
	}
	return false;
}

/**
 * Read a body with both caps enforced. The stall watchdog is separate from the overall
 * deadline on purpose: a server that sends one byte a second stays under any total timeout
 * while holding the connection for as long as it likes.
 */
async function readCapped(
	res: Response,
	limits: FetchLimits,
): Promise<{ bytes: Uint8Array; truncated: boolean } | Rejected> {
	if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const step = await Promise.race([
				reader.read(),
				new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), limits.stallMs)),
			]);
			if (step === "stalled") {
				await reader.cancel().catch(() => {});
				return { reject: "the server stopped sending" };
			}
			if (step.done) break;
			const chunk = step.value;
			if (!chunk) continue;
			total += chunk.byteLength;
			if (total > limits.maxBytes) {
				chunks.push(chunk.subarray(0, Math.max(0, chunk.byteLength - (total - limits.maxBytes))));
				truncated = true;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(chunk);
		}
	} catch {
		await reader.cancel().catch(() => {});
		return { reject: "the connection failed while reading" };
	}
	const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
	let at = 0;
	for (const c of chunks) {
		joined.set(c, at);
		at += c.byteLength;
	}
	return { bytes: joined, truncated };
}

/**
 * Fetch one resource with every guard applied, walking redirects by hand so each hop is
 * gated exactly like the first.
 */
export async function guardedFetch(input: string, limits: FetchLimits): Promise<GuardedResponse | Rejected> {
	const proxied = proxyConfigured();
	let current = canonicalUrl(input);
	if ("reject" in current) return current;

	const deadline = AbortSignal.timeout(limits.timeoutMs);

	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		const gate = await resolveAndGate(current.hostname);
		if ("reject" in gate) return gate;

		let res: Response;
		try {
			res = await fetch(current.href, {
				redirect: "manual",
				signal: deadline,
				credentials: "omit",
				// A proxy would make an address pin meaningless; the DNS gate still stands.
				proxy: proxied ? undefined : "",
				headers: {
					"user-agent": UA,
					accept: limits.accept.includes("text/css") ? "text/css,*/*;q=0.1" : "text/html,*/*;q=0.1",
					"accept-language": "en",
				},
			} as RequestInit);
		} catch {
			return { reject: `could not reach ${current.hostname}` };
		}

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			await res.body?.cancel().catch(() => {});
			if (!location) return { reject: "the server redirected to nowhere" };
			if (hop === MAX_HOPS) return { reject: "too many redirects" };
			let next: URL;
			try {
				next = new URL(location, current.href);
			} catch {
				return { reject: "the server redirected to something unreadable" };
			}
			// Never let a redirect walk https down to http; that is a downgrade, not a move.
			if (current.protocol === "https:" && next.protocol === "http:") {
				return { reject: "that link redirects to an insecure address" };
			}
			const vetted = canonicalUrl(next.href);
			if ("reject" in vetted) return vetted;
			current = vetted;
			continue;
		}

		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return { reject: `the site answered ${res.status}` };
		}

		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		if (limits.accept.length && !limits.accept.some((a) => contentType.includes(a))) {
			await res.body?.cancel().catch(() => {});
			return { reject: `expected ${limits.accept.join(" or ")} but got ${contentType || "nothing"}` };
		}

		const body = await readCapped(res, limits);
		if ("reject" in body) return body;
		return {
			url: current.href,
			status: res.status,
			contentType,
			body: new TextDecoder("utf-8", { fatal: false }).decode(body.bytes),
			bytes: body.bytes,
			proxied,
			truncated: body.truncated,
		};
	}
	return { reject: "too many redirects" };
}

export const HTML_LIMITS: FetchLimits = {
	maxBytes: 2 * 1024 * 1024,
	timeoutMs: 8000,
	stallMs: 5000,
	accept: ["text/html", "application/xhtml"],
};

export const CSS_LIMITS: FetchLimits = {
	maxBytes: 768 * 1024,
	timeoutMs: 6000,
	stallMs: 5000,
	accept: ["text/css"],
};
