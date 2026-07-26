// The URL guard is the only place the brain fetches something a user typed, so every way
// of spelling "actually, connect to my own machine" gets a test. These run offline: the
// shape checks and the address maths need no network, and the one DNS case uses localhost,
// which resolves everywhere.

import { describe, expect, test } from "bun:test";
import { addressIsBlocked, canonicalUrl, resolveAndGate } from "../src/url-guard";

function rejected(input: string): string | null {
	const out = canonicalUrl(input);
	return "reject" in out ? out.reject : null;
}

describe("canonicalUrl — shape", () => {
	test("accepts an ordinary public URL", () => {
		const out = canonicalUrl("https://stripe.com/pricing");
		expect("reject" in out).toBe(false);
	});

	test("refuses non-http schemes", () => {
		expect(rejected("file:///etc/passwd")).toBeTruthy();
		expect(rejected("ftp://example.com/x")).toBeTruthy();
		// gopher:// and friends parse fine as URLs, which is exactly why the check is
		// an allow-list rather than a deny-list.
		expect(rejected("gopher://example.com/x")).toBeTruthy();
	});

	test("refuses credentials, which would be replayed on redirect", () => {
		expect(rejected("http://user:pass@example.com/")).toBeTruthy();
	});

	test("refuses ports that are not website ports", () => {
		expect(rejected("http://example.com:22/")).toBeTruthy();
		expect(rejected("http://example.com:6379/")).toBeTruthy();
		expect("reject" in canonicalUrl("http://example.com:8443/")).toBe(false);
	});

	test("refuses names that can only be local", () => {
		expect(rejected("http://intranet/")).toBeTruthy();
		expect(rejected("http://printer.local/")).toBeTruthy();
		expect(rejected("http://db.internal/")).toBeTruthy();
	});
});

describe("canonicalUrl — literal addresses", () => {
	test("refuses loopback and RFC1918", () => {
		expect(rejected("http://127.0.0.1/")).toBeTruthy();
		expect(rejected("http://10.1.2.3/")).toBeTruthy();
		expect(rejected("http://192.168.0.1/")).toBeTruthy();
		expect(rejected("http://172.16.5.4/")).toBeTruthy();
	});

	test("refuses the cloud metadata endpoint", () => {
		expect(rejected("http://169.254.169.254/latest/meta-data/")).toBeTruthy();
	});

	test("refuses obfuscated spellings of loopback", () => {
		// WHATWG URL normalises these before we ever look, which is the point: the guard
		// does not need its own octal/decimal parser, but it must not regress if the
		// platform stops doing it.
		expect(rejected("http://0177.0.0.1/")).toBeTruthy();
		expect(rejected("http://2130706433/")).toBeTruthy();
		expect(rejected("http://0x7f.0x0.0x0.0x1/")).toBeTruthy();
	});

	test("refuses IPv6 loopback and unique-local", () => {
		expect(rejected("http://[::1]/")).toBeTruthy();
		expect(rejected("http://[fc00::1]/")).toBeTruthy();
		expect(rejected("http://[fe80::1]/")).toBeTruthy();
	});
});

describe("addressIsBlocked — IPv4 smuggled inside IPv6", () => {
	test("v4-mapped", () => {
		expect(addressIsBlocked("::ffff:127.0.0.1")).toBe(true);
		expect(addressIsBlocked("::ffff:7f00:1")).toBe(true);
		expect(addressIsBlocked("::ffff:169.254.169.254")).toBe(true);
	});

	test("NAT64 — the bypass a v6-only deny-list misses entirely", () => {
		// 64:ff9b::/96 carries the v4 address in the low 32 bits; 7f00:1 is 127.0.0.1.
		expect(addressIsBlocked("64:ff9b::7f00:1")).toBe(true);
		expect(addressIsBlocked("64:ff9b::a9fe:a9fe")).toBe(true); // 169.254.169.254
	});

	test("6to4", () => {
		// 2002:<v4>::/48 — 2002:7f00:1:: embeds 127.0.0.1.
		expect(addressIsBlocked("2002:7f00:1::")).toBe(true);
		expect(addressIsBlocked("2002:a9fe:a9fe::")).toBe(true);
	});

	test("a public address that merely contains ffff: is not treated as mapped", () => {
		// The test was a substring search, so 2001:ffff::1 had its last two groups read as
		// octets — blocking an ordinary public host.
		expect(addressIsBlocked("2001:ffff::1")).toBe(false);
		expect(addressIsBlocked("2606:4700:ffff::1111")).toBe(false);
		// ...while the real mapped prefix is still caught.
		expect(addressIsBlocked("::ffff:127.0.0.1")).toBe(true);
	});

	test("leaves genuinely public addresses alone", () => {
		expect(addressIsBlocked("1.1.1.1")).toBe(false);
		expect(addressIsBlocked("2606:4700:4700::1111")).toBe(false);
		// 2002: prefix carrying a PUBLIC v4 must still pass.
		expect(addressIsBlocked("2002:0101:0101::")).toBe(false); // 1.1.1.1
	});

	test("treats an unparseable address as blocked rather than unknown", () => {
		expect(addressIsBlocked("not-an-address")).toBe(true);
		expect(addressIsBlocked("")).toBe(true);
	});
});

describe("resolveAndGate", () => {
	test("refuses a name that resolves into the machine", async () => {
		const out = await resolveAndGate("localhost");
		expect("reject" in out).toBe(true);
	});

	test("passes a literal public address straight through", async () => {
		const out = await resolveAndGate("1.1.1.1");
		expect("reject" in out).toBe(false);
		if (!("reject" in out)) expect(out.addresses).toEqual(["1.1.1.1"]);
	});

	test("refuses a literal private address without touching DNS", async () => {
		const out = await resolveAndGate("192.168.1.1");
		expect("reject" in out).toBe(true);
	});
});
