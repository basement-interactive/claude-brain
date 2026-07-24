// Image identification from bytes alone, no dependency and no decoding.
//
// Two things force this to exist. First, the browser-supplied Content-Type on an upload
// is user input, and we store those bytes and serve them back from our own origin — so
// the type has to come from the file itself, and SVG has to be refused outright (it is
// script-capable, and "an image" that can run JS in the dashboard's origin is not one).
// Second, a vision call costs real money: a file that is truncated, or larger than the
// model will accept, is worth catching here for free rather than paying to find out.

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";

export interface ImageMeta {
	mime: ImageMime;
	width: number;
	height: number;
	/** The terminating marker is present, so the file is not a half-finished copy. */
	complete: boolean;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16be(bytes: Uint8Array, at: number): number {
	return (bytes[at]! << 8) | bytes[at + 1]!;
}

function u32be(bytes: Uint8Array, at: number): number {
	return ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
}

function u16le(bytes: Uint8Array, at: number): number {
	return bytes[at]! | (bytes[at + 1]! << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
	return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

function u32le(bytes: Uint8Array, at: number): number {
	return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Magic bytes only. Never the declared type. */
export function sniffMime(bytes: Uint8Array): ImageMime | null {
	if (bytes.length < 12) return null;
	if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
	if (ascii(bytes, 4, 8) === "ftypavif") return "image/avif";
	return null;
}

function pngMeta(bytes: Uint8Array): ImageMeta | null {
	// IHDR is mandated to be the first chunk, so its offsets are fixed.
	if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
	const tail = ascii(bytes.subarray(Math.max(0, bytes.length - 12)), 0, Math.min(12, bytes.length));
	return {
		mime: "image/png",
		width: u32be(bytes, 16),
		height: u32be(bytes, 20),
		complete: tail.includes("IEND"),
	};
}

function jpegMeta(bytes: Uint8Array): ImageMeta | null {
	// Walk the segment chain to the first start-of-frame; everything before it is
	// metadata of unpredictable length, so the dimensions have no fixed offset.
	let at = 2;
	let width = 0;
	let height = 0;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) break;
		const marker = bytes[at + 1]!;
		// Standalone markers carry no length field.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2;
			continue;
		}
		// Start of scan: compressed data follows and segment walking ends here.
		if (marker === 0xda) break;
		const length = u16be(bytes, at + 2);
		if (length < 2) break;
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			height = u16be(bytes, at + 5);
			width = u16be(bytes, at + 7);
			break;
		}
		at += 2 + length;
	}
	if (!width || !height) return null;
	// Some encoders pad after EOI, so look at the tail rather than the last two bytes.
	const tail = bytes.subarray(Math.max(0, bytes.length - 32));
	let complete = false;
	for (let i = 0; i + 1 < tail.length; i++) {
		if (tail[i] === 0xff && tail[i + 1] === 0xd9) complete = true;
	}
	return { mime: "image/jpeg", width, height, complete };
}

function webpMeta(bytes: Uint8Array): ImageMeta | null {
	// RIFF declares its own payload size, which is the honest completeness check.
	const complete = u32le(bytes, 4) + 8 <= bytes.length;
	const format = ascii(bytes, 12, 4);
	const data = 20;
	if (format === "VP8 " && bytes.length >= data + 10) {
		if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null;
		return {
			mime: "image/webp",
			width: u16le(bytes, data + 6) & 0x3fff,
			height: u16le(bytes, data + 8) & 0x3fff,
			complete,
		};
	}
	if (format === "VP8L" && bytes.length >= data + 5) {
		if (bytes[data] !== 0x2f) return null;
		// 14 bits of width-1 then 14 bits of height-1, little-endian bitstream.
		const packed = u32le(bytes, data + 1);
		return {
			mime: "image/webp",
			width: (packed & 0x3fff) + 1,
			height: ((packed >> 14) & 0x3fff) + 1,
			complete,
		};
	}
	if (format === "VP8X" && bytes.length >= data + 10) {
		return {
			mime: "image/webp",
			width: u24le(bytes, data + 4) + 1,
			height: u24le(bytes, data + 7) + 1,
			complete,
		};
	}
	return null;
}

function gifMeta(bytes: Uint8Array): ImageMeta | null {
	if (bytes.length < 10) return null;
	return {
		mime: "image/gif",
		width: u16le(bytes, 6),
		height: u16le(bytes, 8),
		complete: bytes[bytes.length - 1] === 0x3b,
	};
}

/**
 * Dimensions and completeness from the header. Null means "we cannot vouch for this
 * file" — including a well-formed AVIF, whose dimensions live in a nested ISO-BMFF box
 * tree that is not worth parsing here. Callers that pay per call (the vision path) treat
 * null as a refusal; callers that only store bytes can still trust sniffMime().
 */
export function imageMeta(bytes: Uint8Array): ImageMeta | null {
	const mime = sniffMime(bytes);
	if (mime === "image/png") return pngMeta(bytes);
	if (mime === "image/jpeg") return jpegMeta(bytes);
	if (mime === "image/webp") return webpMeta(bytes);
	if (mime === "image/gif") return gifMeta(bytes);
	return null;
}
