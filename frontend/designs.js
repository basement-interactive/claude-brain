// Designs tab: drop screenshots and mockups in, get them back as searchable memory.
//
// Three things here are not obvious.
//
// The browser is the image library. This package ships no image dependency, so the two
// downscaled copies the store wants — the card thumb and the copy the vision call can
// actually open — are encoded on canvas here and uploaded *alongside* the original. The
// original itself is never touched: a design's id is the hash of those exact bytes, so
// re-encoding them forks one screenshot into two library entries, two blobs and two notes.
//
// A card is honest about several different kinds of "no description yet": waiting its
// turn, being read right now, in a shape the model will not open, Claude switched off,
// Claude missing, and tried-and-failed. They are eight distinct statuses on the row and
// they mean eight different things to the user, so none of them collapse into "unknown".
//
// The grid is patched in place, never rebuilt. Extraction is asynchronous, so this tab
// polls; rebuilding on every tick would re-fetch every card image, steal focus from the
// filter box mid-keystroke and flash empty wells twice a second.

import { api, el, text } from "./ui.js";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";
const THUMB_EDGE = 320;
const RENDER_EDGE = 1568;
/** Mirrors VISION_MAX_BYTES / VISION_MAX_EDGE in src/design-extract.ts: past either of
 *  these the model will not open the file, and this page is the only thing that can make
 *  a smaller one. */
const VISION_MAX_BYTES = 4 * 1024 * 1024;
const VISION_MAX_EDGE = 2000;
const POLL_MS = 2500;
/** Extraction that has not finished in this long is stuck or waiting behind a budget cap;
 *  poll forever and the tab burns a request every 2.5 s for the rest of the day. */
const POLL_MAX_MS = 4 * 60 * 1000;
const HEX = /^#[0-9a-f]{6}$/i;

/** The eight members of DesignStatus (src/design-store.ts), in the user's words. */
const STATUS = {
	queued: { label: "waiting", tone: "wait", poll: true },
	extracting: { label: "reading it", tone: "wait", poll: true },
	described: { label: "described", tone: "ok", poll: false },
	thin: { label: "lightly described", tone: "ok", poll: false },
	"needs-render": { label: "needs a smaller copy", tone: "off", poll: false },
	disabled: { label: "needs Claude", tone: "off", poll: false },
	unavailable: { label: "Claude unavailable", tone: "off", poll: false },
	failed: { label: "failed", tone: "bad", poll: false },
};

/**
 * A retry re-runs the same vision call, so it only helps where the call itself was the
 * problem. `needs-render` is absent on purpose: that row is blocked on a file the model
 * cannot open, and re-queueing it lands straight back in the same state. Dropping the
 * image on this page again is the actual fix, because that is what attaches a render.
 */
const RETRYABLE = new Set(["failed", "unavailable", "disabled", "described", "thin"]);

const LLM_REASONS = {
	disabled: "Image description is off. Turn Claude on in Settings and new images are described by " +
		"your own CLI on this machine — the brain still uploads nothing anywhere.",
	"not-installed": "The claude CLI is not installed, so images are stored but not described.",
	"not-logged-in": "The claude CLI is not signed in, so images are stored but not described.",
	"too-old": "The installed claude CLI is too old to read images. Images are stored but not described.",
};

/** SaveDesignResult's three refusals, said out loud. */
const REFUSALS = {
	"not-an-image": "that is not an image type the brain can read",
	truncated: "that file is incomplete — re-save it and try again",
	"too-large": "too large for the design library",
};

/** What the drawer says when there is no spec yet, keyed by why. */
const NO_SPEC = {
	queued: "Waiting its turn. The description shows up here on its own.",
	extracting: "Reading the image now.",
	"needs-render": "The model will not open this file as it stands. Drop it onto this page again and " +
		"the dashboard will attach a smaller copy — but only if your browser can decode the format. " +
		"If nothing changes, save it as PNG or JPEG and upload that.",
	disabled: "Image description is off, so this has only been stored. Turn Claude on in Settings.",
	unavailable: "The claude CLI is not usable right now, so nothing has been read yet.",
	failed: "The last attempt did not come back with a usable description.",
};

const SPEC_SECTIONS = [
	["layout", "Layout"],
	["spacing", "Spacing"],
	["typography", "Typography"],
	["shape", "Shape & depth"],
	["motion", "Motion"],
	["signature", "Signature moves"],
	["avoid", "Avoid"],
	["recreate", "Recreating it"],
];

// --- Row reading -------------------------------------------------------------
// Everything below binds to DesignRow exactly as stored: snake_case columns, `palette` a
// JSON string, `mood` comma-joined, `spec` the raw JSON the model returned.

function statusOf(raw) {
	return STATUS[raw] ?? { label: String(raw ?? "unknown"), tone: "off", poll: false };
}

/** The same rule renderDesignNote() uses for its title, so a card and its note agree. */
function titleOf(row) {
	return row.name || row.caption || row.source_name || `Design ${row.id}`;
}

function hexes(raw) {
	if (typeof raw !== "string" || !raw) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return []; // the column is model output that went through JSON.stringify; trust nothing
	}
	return Array.isArray(parsed) ? parsed.map(String).filter((c) => HEX.test(c)) : [];
}

function moodWords(raw) {
	return String(raw ?? "").split(",").map((w) => w.trim()).filter(Boolean);
}

function strings(value) {
	return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()) : [];
}

/** Palette entries as design-note.ts writes them: `{ hex, role, note }`. */
function paletteEntries(spec) {
	if (!spec || !Array.isArray(spec.palette)) return [];
	return spec.palette
		.filter((p) => p && typeof p === "object" && HEX.test(String(p.hex)))
		.map((p) => ({ hex: String(p.hex), role: String(p.role ?? ""), note: String(p.note ?? "") }));
}

function parseSpec(raw) {
	if (typeof raw !== "string" || !raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function bytesLabel(bytes) {
	if (!bytes) return "";
	return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function whenLabel(ms) {
	return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

// --- Canvas ------------------------------------------------------------------

/** One decode, reused for both downscales — decoding a 30 MB PNG twice is seconds of jank. */
async function decode(file) {
	if (typeof createImageBitmap !== "function") return null;
	try {
		return await createImageBitmap(file);
	} catch {
		return null; // encodings this browser refuses; the original still uploads fine
	}
}

/** `edge` px on the long side, webp, never upscaled. */
function scaled(bitmap, edge, quality) {
	const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	// A canvas past the browser's area limit hands back a null context. Returning null is
	// the same answer as a failed encode, and the upload proceeds without a render.
	const ctx = canvas.getContext("2d");
	if (!ctx) return Promise.resolve(null);
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

/**
 * A render is only worth making when the original would be refused: 1568 px of a 900 px
 * screenshot is the same picture, one lossy generation worse, and the store would then
 * hand the model the worse copy.
 */
function wantsRender(file, bitmap) {
	return file.size > VISION_MAX_BYTES || Math.max(bitmap.width, bitmap.height) > VISION_MAX_EDGE;
}

/**
 * AVIF is stored happily but imageMeta() answers null for it — its dimensions live in a
 * box tree that parser deliberately does not walk — and the extractor refuses anything it
 * cannot vouch for. Such a row lands in `needs-render` no matter how small it is, and
 * re-dropping the file would not change that. Attaching a webp render does, and this page
 * is the only thing that can make one, so for AVIF it always does.
 *
 * Sniffed rather than trusted from `file.type`: a file dragged out of another app often
 * arrives with no type at all, and this decision has to be made before the upload.
 */
async function isAvif(file) {
	try {
		const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
		return String.fromCharCode(...head.subarray(4, 12)) === "ftypavif";
	} catch {
		// A file that vanished between drop and read. Not AVIF as far as we can tell, and
		// throwing here would abandon the rest of the batch.
		return false;
	}
}

async function renderCopy(bitmap) {
	const blob = await scaled(bitmap, RENDER_EDGE, 0.85);
	// A render over the byte ceiling would be rejected for exactly the reason it exists to
	// avoid, and a noisy photograph can get there even at 1568 px.
	if (!blob || blob.size <= VISION_MAX_BYTES) return blob;
	return scaled(bitmap, RENDER_EDGE, 0.5);
}

export function createDesignsTab(container) {
	container.classList.add("designs-tab");

	let designs = [];
	let llm = null;
	let filter = "";
	let message = "";
	let loadError = "";
	let openId = null;
	let dragDepth = 0;
	let live = false;
	let pollTimer = null;
	let pollStartedAt = 0;
	let pollStalled = false;
	/** Ids currently being watched, joined — a change in the set means new work. */
	let polledIds = "";
	let uploadSeq = 0;

	// Files still in flight; they have no id yet.
	const uploading = [];
	// One card object per key, built once and patched afterwards.
	const cards = new Map();

	// --- Shell ---------------------------------------------------------------

	const wrap = el("div", "designs-wrap");
	const head = el("div", "designs-head");
	head.appendChild(text("h2", "designs-title", "Design library"));
	head.appendChild(text("p", "designs-sub",
		"Screenshots, mockups and references become notes in your vault — described once, then " +
		"recalled like anything else you have written down."));

	const search = el("input", "settings-input designs-search");
	search.type = "search";
	search.placeholder = "Filter by name, caption, mood or hex";
	search.oninput = () => {
		filter = search.value;
		renderGrid();
	};
	const addBtn = text("button", "settings-btn primary", "Add images");
	addBtn.type = "button";
	addBtn.onclick = () => picker.click();
	const reloadBtn = text("button", "settings-btn ghost", "Refresh");
	reloadBtn.type = "button";
	reloadBtn.onclick = () => {
		pollStalled = false;
		message = "";
		refresh();
	};
	const tools = el("div", "designs-tools");
	tools.append(search, addBtn, reloadBtn);
	head.appendChild(tools);

	const notices = el("div", "designs-notices");
	head.appendChild(notices);

	// A button, not a div: this is the only way to add images without a mouse.
	const drop = el("button", "designs-drop",
		"<strong>Drop images here</strong>" +
		"<span>or paste from the clipboard, or press Enter — PNG, JPEG, WebP, GIF, AVIF</span>");
	drop.type = "button";
	drop.onclick = () => picker.click();

	const grid = el("div", "designs-grid");
	const empty = text("div", "designs-empty", "No designs yet.");
	grid.appendChild(empty);
	wrap.append(head, drop, grid);

	const picker = el("input");
	picker.type = "file";
	picker.accept = ACCEPT;
	picker.multiple = true;
	picker.hidden = true;
	picker.onchange = () => {
		addFiles([...picker.files]);
		picker.value = "";
	};

	const detail = el("div", "brain-panel design-detail");
	container.append(wrap, picker, detail);

	// The whole tab is the drop target; the dashed box is its affordance. Dropping an image
	// anywhere else in the window would otherwise navigate the dashboard to a file:// view
	// of it, rebooting the SPA and losing whatever was in flight.
	function onDragEnter(e) {
		e.preventDefault();
		dragDepth += 1;
		drop.classList.add("dragging");
	}
	function onDragOver(e) {
		e.preventDefault();
	}
	function onDragLeave() {
		dragDepth -= 1;
		if (dragDepth <= 0) drop.classList.remove("dragging");
	}
	function onDrop(e) {
		e.preventDefault();
		dragDepth = 0;
		drop.classList.remove("dragging");
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length) addFiles(files);
	}
	function blockDrop(e) {
		e.preventDefault();
	}
	wrap.addEventListener("dragenter", onDragEnter);
	wrap.addEventListener("dragover", onDragOver);
	wrap.addEventListener("dragleave", onDragLeave);
	wrap.addEventListener("drop", onDrop);

	// --- Data ----------------------------------------------------------------

	async function refresh() {
		const out = await api("/api/designs");
		if (!live) return;
		if (Array.isArray(out.designs)) {
			designs = out.designs;
			loadError = "";
		} else {
			loadError = out.error ?? "the design library could not be read";
		}
		// The llm state rides along with the list, so nothing here polls /api/status — that
		// endpoint shells out to rclone, and this tab only ever wanted one boolean from it.
		if (out.llm) llm = out.llm;
		renderNotices();
		renderGrid();
		syncPoll();
	}

	function llmBlocked() {
		return Boolean(llm && !llm.available);
	}

	// --- Upload --------------------------------------------------------------

	async function addFiles(files) {
		// An empty type is normal for a file dragged out of some apps; the store sniffs magic
		// bytes anyway and says so plainly when it is not an image.
		const images = files.filter((f) => !f.type || f.type.startsWith("image/"));
		message = images.length < files.length ? "Only images can be added to the design library." : "";
		renderNotices();
		if (!images.length) return;
		pollStalled = false;
		// One request per file, so a single rejected image does not lose the rest.
		for (const file of images) {
			const pending = { key: `upload:${(uploadSeq += 1)}`, name: file.name, thumb: null, error: null };
			uploading.push(pending);
			renderGrid();
			await uploadOne(file, pending);
		}
		await refresh();
	}

	async function post(blob, filename, parts) {
		const body = new FormData();
		body.append("file", blob, filename);
		if (parts.thumb) body.append("thumb", parts.thumb, "thumb.webp");
		if (parts.render) body.append("render", parts.render, "render.webp");
		if (parts.width && parts.height) {
			body.append("width", String(parts.width));
			body.append("height", String(parts.height));
		}
		let res;
		try {
			res = await fetch("/api/designs", { method: "POST", body });
		} catch {
			return { ok: false, error: "the brain is not responding" };
		}
		const out = await res.json().catch(() => null);
		if (out?.ok && out.row?.id) return out;
		const reason = out?.reason;
		return { ok: false, reason, error: REFUSALS[reason] ?? out?.error ?? `upload failed (${res.status})` };
	}

	async function uploadOne(file, pending) {
		const bitmap = await decode(file);
		let thumb = null;
		let render = null;
		if (!bitmap) pending.note = "this browser could not decode the image — it is stored, but may need a PNG or JPEG copy";
		if (bitmap) {
			thumb = await scaled(bitmap, THUMB_EDGE, 0.72);
			if (thumb) {
				pending.thumb = URL.createObjectURL(thumb);
				renderGrid();
			}
			if (wantsRender(file, bitmap) || (await isAvif(file))) {
				render = await renderCopy(bitmap);
				// Encode refused (canvas limit, no webp encoder). Saying so here is the only
				// chance the user gets; the row lands in needs-render either way.
				if (!render) pending.note = "this browser could not make a smaller copy — save it as PNG or JPEG";
			}
			pending.width = bitmap.width;
			pending.height = bitmap.height;
			bitmap.close();
		}

		const parts = { thumb, render, width: pending.width, height: pending.height };
		let out = await post(file, file.name, parts);
		if (!out.ok && out.reason === "too-large" && render) {
			// The one case where the user's own bytes cannot be kept. Say so rather than
			// quietly storing something else under the same name.
			out = await post(render, `${file.name.replace(/\.[^.]+$/, "")}.webp`, { thumb });
			if (out.ok) message = `${file.name} was too large to keep whole — a downscaled copy was saved instead.`;
		}

		if (!out.ok) {
			pending.error = out.error;
			renderGrid();
			return;
		}
		if (!out.fresh && !out.requeued) message = `${file.name} was already in the library.`;
		dropPending(pending);
	}

	/** Pending cards own an object URL, so they are only ever removed through here. */
	function dropPending(pending) {
		const at = uploading.indexOf(pending);
		if (at >= 0) uploading.splice(at, 1);
		if (pending.thumb) {
			URL.revokeObjectURL(pending.thumb);
			pending.thumb = null;
		}
		renderGrid();
	}

	// --- Polling -------------------------------------------------------------

	function stopPoll() {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = null;
	}

	function syncPoll() {
		// A refresh already in flight when the user leaves the tab resolves here afterwards;
		// without this it would start a fresh interval on a hidden panel.
		if (!live) {
			stopPoll();
			return;
		}
		const ids = designs.filter((d) => statusOf(d.status).poll).map((d) => d.id).sort().join(",");
		if (!ids) {
			polledIds = "";
			stopPoll();
			return;
		}
		// New work restarts the window. Otherwise a fresh upload inherits the deadline of an
		// image that has been stuck for three minutes and stops being watched ten seconds in.
		if (ids !== polledIds) {
			polledIds = ids;
			pollStartedAt = Date.now();
			pollStalled = false;
		}
		if (pollStalled) {
			stopPoll();
			return;
		}
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			if (Date.now() - pollStartedAt > POLL_MAX_MS) {
				stopPoll();
				pollStalled = true;
				renderNotices();
				return;
			}
			refresh();
		}, POLL_MS);
	}

	// --- Notices -------------------------------------------------------------

	function renderNotices() {
		notices.innerHTML = "";
		if (loadError) notices.appendChild(text("div", "designs-notice", loadError));
		if (llmBlocked()) {
			notices.appendChild(text("div", "designs-notice",
				LLM_REASONS[llm.reason] ?? "Description is unavailable right now; images are still stored."));
		}
		if (pollStalled) {
			notices.appendChild(text("div", "designs-notice",
				"Stopped watching for updates after a few minutes. Refresh to check again."));
		}
		if (message) notices.appendChild(text("div", "designs-notice", message));
	}

	// --- Grid ----------------------------------------------------------------

	/** The columns findDesigns() searches, so the box narrows the same way recall does. */
	function matchesFilter(row) {
		const needle = filter.trim().toLowerCase();
		if (!needle) return true;
		return [row.name, row.caption, row.source_name, row.mood, row.palette]
			.join(" ").toLowerCase().includes(needle);
	}

	function imageSrc(row) {
		const id = encodeURIComponent(row.id);
		// Falls back to the original for rows the CLI added, which have no thumb on disk.
		return row.thumb ? `/api/designs/${id}/thumb` : `/api/designs/${id}/image`;
	}


	/**
	 * Cards are created once and patched. Rebuilding the grid on every poll tick would drop
	 * keyboard focus and re-fetch every image the browser has no way to revalidate.
	 */
	function renderGrid() {
		const visible = designs.filter(matchesFilter);
		const entries = [
			...uploading.map((p) => ({ key: p.key, data: p, build: pendingCard })),
			...visible.map((row) => ({ key: row.id, data: row, build: designCard })),
		];
		const wanted = new Set(entries.map((e) => e.key));

		for (const [key, card] of cards) {
			if (wanted.has(key)) continue;
			card.node.remove();
			cards.delete(key);
		}

		let cursor = grid.firstChild;
		for (const entry of entries) {
			let card = cards.get(entry.key);
			if (!card) {
				card = entry.build();
				cards.set(entry.key, card);
			}
			card.update(entry.data);
			if (card.node === cursor) cursor = cursor.nextSibling;
			else grid.insertBefore(card.node, cursor);
		}

		empty.textContent = designs.length ? "Nothing matches that filter." : "No designs yet.";
		empty.hidden = entries.length > 0;
	}

	function pendingCard() {
		// A div, not a button: it holds a Dismiss button, and a button inside a button is
		// not a thing a browser will render.
		const node = el("div", "design-card is-uploading");
		const well = el("div", "design-thumb");
		const img = el("img");
		img.alt = "";
		well.appendChild(img);
		const name = text("div", "design-name", "");
		const status = text("span", "design-status st-wait", "uploading…");
		const foot = el("div", "design-foot");
		foot.appendChild(status);
		const dismiss = text("button", "settings-btn ghost design-dismiss", "Dismiss");
		dismiss.type = "button";
		dismiss.hidden = true;
		node.append(well, name, foot, dismiss);

		let current = null;
		dismiss.onclick = () => {
			if (current) dropPending(current);
		};
		return {
			node,
			update(pending) {
				current = pending;
				node.className = `design-card ${pending.error ? "has-error" : "is-uploading"}`;
				name.textContent = pending.name;
				if (pending.thumb && img.getAttribute("src") !== pending.thumb) img.src = pending.thumb;
				status.className = `design-status st-${pending.error ? "bad" : "wait"}`;
				status.textContent = pending.error ?? "uploading…";
				dismiss.hidden = !pending.error;
			},
		};
	}

	function designCard() {
		const node = el("button", "design-card");
		node.type = "button";
		const well = el("div", "design-thumb");
		const img = el("img");
		img.loading = "lazy";
		img.decoding = "async";
		img.alt = "";
		well.appendChild(img);
		const name = text("div", "design-name", "");
		const status = text("span", "design-status", "");
		const dims = text("span", "design-dims", "");
		const foot = el("div", "design-foot");
		foot.append(status, dims);
		const summary = text("p", "design-summary", "");
		node.append(well, name, foot, summary);

		let id = "";
		// The spec is a JSON blob per row and this runs on every poll tick, so it is parsed
		// again only when the row's copy of it actually changed.
		let specRaw = null;
		let vibe = "";
		node.onclick = () => openDetail(id);
		return {
			node,
			update(row) {
				id = row.id;
				const src = imageSrc(row);
				if (img.getAttribute("src") !== src) img.src = src;
				name.textContent = titleOf(row);
				const st = statusOf(row.status);
				status.className = `design-status st-${st.tone}`;
				status.textContent = st.label;
				dims.textContent = row.width && row.height ? `${row.width}×${row.height}` : "";
				dims.hidden = !dims.textContent;
				if (row.spec !== specRaw) {
					specRaw = row.spec;
					vibe = String(parseSpec(row.spec)?.vibe ?? "");
				}
				summary.textContent = row.caption || vibe || row.error || "";
				summary.hidden = !summary.textContent;
			},
		};
	}

	// --- Detail --------------------------------------------------------------

	async function openDetail(id) {
		openId = id;
		detail.innerHTML = "";
		detail.classList.add("open");
		detail.appendChild(text("div", "panel-loading", "Loading…"));
		const record = await api(`/api/designs/${encodeURIComponent(id)}`);
		if (openId !== id) return; // the user moved on while the record was in flight
		if (!record.row?.id) {
			detail.innerHTML = "";
			detail.appendChild(closeButton());
			detail.appendChild(text("div", "panel-error", record.error ?? "this design is no longer in the library"));
			return;
		}
		renderDetail(record.row, record.spec ?? parseSpec(record.row.spec));
	}

	function closeDetail() {
		if (!openId) return;
		const card = cards.get(openId);
		openId = null;
		detail.classList.remove("open");
		// Only when the tab is still on screen: hide() closes the drawer too, and pulling
		// focus into a panel the user just navigated away from is worse than losing it.
		if (live) card?.node.focus?.();
	}

	function closeButton() {
		const close = text("button", "panel-close", "×");
		close.type = "button";
		close.setAttribute("aria-label", "Close");
		close.onclick = closeDetail;
		return close;
	}

	function renderDetail(row, spec) {
		detail.innerHTML = "";
		const close = closeButton();
		detail.appendChild(close);

		const title = titleOf(row);
		const inner = el("div", "panel-inner");
		inner.appendChild(text("h2", null, title));

		const img = el("img", "design-detail-img");
		img.src = `/api/designs/${encodeURIComponent(row.id)}/image`;
		img.alt = title;
		inner.appendChild(img);

		const st = statusOf(row.status);
		const meta = el("div", "panel-meta");
		meta.appendChild(text("span", `design-status st-${st.tone}`, st.label));
		if (row.width && row.height) meta.appendChild(text("span", null, `${row.width}×${row.height}`));
		if (row.mime) meta.appendChild(text("span", null, row.mime));
		if (row.bytes) meta.appendChild(text("span", null, bytesLabel(row.bytes)));
		if (row.created) meta.appendChild(text("span", null, `added ${whenLabel(row.created)}`));
		inner.appendChild(meta);

		if (row.source_name && row.source_name !== title) {
			inner.appendChild(text("div", "design-source", row.source_name));
		}
		if (row.caption) inner.appendChild(text("p", "design-caption", `Saved because: ${row.caption}`));

		// The row's own sentence, written by the extractor for exactly this spot.
		if (row.error) inner.appendChild(text("div", "designs-notice", row.error));
		if (row.status === "failed" && row.next_attempt_at > Date.now()) {
			inner.appendChild(text("p", "design-hint", `Tries again on its own around ${whenLabel(row.next_attempt_at)}.`));
		}

		// The spec's palette carries roles; the row's column is the same hexes without them,
		// and is all there is for a row whose spec never parsed.
		const palette = paletteEntries(spec);
		const bare = hexes(row.palette);
		if (palette.length) inner.appendChild(paletteList(palette));
		else if (bare.length) inner.appendChild(swatchStrip(bare));

		const mood = moodWords(row.mood);
		if (mood.length) {
			const chips = el("div", "design-chips");
			for (const word of mood) chips.appendChild(text("span", "design-chip", word));
			inner.appendChild(chips);
		}

		inner.appendChild(specBody(row, spec));

		if (row.note_path) {
			inner.appendChild(text("div", "panel-path", row.note_path));
			if (row.note_missing) {
				inner.appendChild(text("p", "design-hint", "That note is not in the vault right now — the drive may be unplugged."));
			}
		}
		inner.appendChild(detailActions(row));
		detail.appendChild(inner);
		close.focus();
	}

	function swatchStrip(colours) {
		const strip = el("div", "design-swatches");
		for (const colour of colours) {
			const sw = el("span", "design-swatch");
			// A model wrote these and `background` accepts url(); the hex test upstream is
			// what makes assigning them safe.
			sw.style.background = colour;
			sw.title = colour;
			strip.appendChild(sw);
		}
		return strip;
	}

	function paletteList(entries) {
		const list = el("div", "design-palette");
		for (const entry of entries) {
			const row = el("div", "design-palette-row");
			const sw = el("span", "design-swatch");
			sw.style.background = entry.hex;
			row.appendChild(sw);
			row.appendChild(text("code", "design-hex", entry.hex));
			row.appendChild(text("span", "design-role", [entry.role, entry.note].filter(Boolean).join(" — ")));
			list.appendChild(row);
		}
		return list;
	}

	function specBody(row, spec) {
		const body = el("div", "design-spec");
		const vibe = typeof spec?.vibe === "string" ? spec.vibe : "";
		if (vibe) body.appendChild(text("p", "design-desc", vibe));

		let sections = 0;
		for (const [key, heading] of SPEC_SECTIONS) {
			const items = strings(spec?.[key]);
			if (!items.length) continue;
			sections += 1;
			const block = el("section", "design-spec-block");
			block.appendChild(text("h4", null, heading));
			const ul = el("ul");
			for (const item of items) ul.appendChild(text("li", null, item));
			block.appendChild(ul);
			body.appendChild(block);
		}

		if (!vibe && sections === 0) {
			body.appendChild(text("div", "design-desc empty",
				NO_SPEC[row.status] ?? "Nothing has been read out of this image yet."));
		}
		return body;
	}

	function detailActions(row) {
		const actions = el("div", "design-actions");

		// `needs-render` gets no button: the way out is stated where the description would
		// have been, and it is a drag-and-drop, not a call this page can make.
		if (RETRYABLE.has(row.status)) {
			const again = row.status === "described" || row.status === "thin";
			const retry = text("button", "settings-btn ghost", again ? "Describe again" : "Try again");
			retry.type = "button";
			retry.disabled = llmBlocked();
			if (retry.disabled) retry.title = "Claude is not available right now";
			retry.onclick = async () => {
				retry.disabled = true;
				const out = await api(`/api/designs/${encodeURIComponent(row.id)}/retry`, {});
				pollStalled = false;
				if (out.ok) {
					await refresh();
					openDetail(row.id);
					return;
				}
				retry.replaceWith(text("div", "designs-notice", out.error ?? "that could not be queued again"));
			};
			actions.appendChild(retry);
		}

		const forget = text("button", "settings-btn ghost design-forget", "Forget this design");
		forget.type = "button";
		forget.onclick = () => showForgetPlan(row, forget);
		actions.appendChild(forget);
		return actions;
	}

	/**
	 * forgetDesign() is dry-run by default and answers with the plan it would carry out, so
	 * the confirm box states that plan rather than a sentence written here months ago. What
	 * the server says it will keep is what the user is shown.
	 */
	async function showForgetPlan(row, trigger) {
		const box = el("div", "design-confirm");
		box.appendChild(text("p", null, "Checking what this would remove…"));
		trigger.replaceWith(box);

		const plan = await api(`/api/designs/${encodeURIComponent(row.id)}/forget`, {});
		if (openId !== row.id) return;
		box.innerHTML = "";
		if (!plan.id) {
			box.appendChild(text("p", null, plan.error ?? "that design could not be read"));
			const back = text("button", "settings-btn ghost", "Close");
			back.type = "button";
			back.onclick = () => openDetail(row.id);
			box.appendChild(back);
			return;
		}

		const removes = Array.isArray(plan.removes) ? plan.removes : [];
		box.appendChild(text("p", null, removes.length
			? `Frees ${removes.length} stored file${removes.length === 1 ? "" : "s"} and drops this design from the library.`
			: "Drops this design from the library. Its stored files are already gone."));
		if (removes.length) {
			const list = el("ul", "design-plan");
			for (const path of removes) list.appendChild(text("li", null, path));
			box.appendChild(list);
		}
		for (const line of Array.isArray(plan.keeps) ? plan.keeps : []) {
			box.appendChild(text("p", "design-plan-keep", line));
		}
		if (plan.noteMove) {
			box.appendChild(text("p", "design-plan-keep", `${plan.noteMove.from} → ${plan.noteMove.to}`));
		}

		const cancel = text("button", "settings-btn ghost", "Cancel");
		cancel.type = "button";
		cancel.onclick = () => openDetail(row.id);
		const go = text("button", "settings-btn ghost design-forget", "Forget");
		go.type = "button";
		go.onclick = async () => {
			go.disabled = true;
			const done = await api(`/api/designs/${encodeURIComponent(row.id)}/forget`, { confirm: true });
			if (!done.applied) {
				go.replaceWith(text("span", "design-hint", done.error ?? "nothing was removed"));
				return;
			}
			closeDetail();
			await refresh();
		};
		const buttons = el("div", "design-confirm-row");
		buttons.append(cancel, go);
		box.appendChild(buttons);
		cancel.focus();
	}

	// --- Lifecycle -----------------------------------------------------------

	function onPaste(e) {
		const files = [...(e.clipboardData?.files ?? [])];
		if (files.length) addFiles(files);
	}

	function onKeyDown(e) {
		if (e.key === "Escape" && openId) closeDetail();
	}

	return {
		show() {
			live = true;
			document.addEventListener("paste", onPaste);
			document.addEventListener("keydown", onKeyDown);
			window.addEventListener("dragover", blockDrop);
			window.addEventListener("drop", blockDrop);
			pollStalled = false;
			refresh();
		},
		hide() {
			live = false;
			document.removeEventListener("paste", onPaste);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("dragover", blockDrop);
			window.removeEventListener("drop", blockDrop);
			stopPoll();
			closeDetail();
		},
	};
}
