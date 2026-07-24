// The DOM/fetch primitives every dashboard tab needs. They lived in settings.js until the
// Designs tab needed the same ones; copying them a second time is how a codebase ends up
// so a new tab does not have to restate them. settings.js and brain.js still carry
// their own copies; folding those in is a separate change from adding a tab.
//
// `api` deliberately takes a relative path. server.ts rejects any POST whose
// Sec-Fetch-Site or Origin says it came from another page, and a relative URL is what
// makes the browser send "same-origin" for both. Never route a POST through a full
// URL or a custom fetch mode — the guard will 403 it.

/** For static markup written in this repo. Anything from a user, a model or the disk
 *  belongs in text() instead. */
export function el(tag, className, html) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (html !== undefined) node.innerHTML = html;
	return node;
}

export function text(tag, className, value) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.textContent = value ?? "";
	return node;
}

/** For the callers that still assemble a string of markup by hand. */

/**
 * Resolves to an object, always. A daemon restarted mid-session answers a plain 404 with a
 * text/plain body, and an endpoint this build does not know about answers the same way —
 * both are ordinary states for a local tool, not programming errors. Rejecting there would
 * abort the caller before it renders anything, leaving a blank tab and a console trace; the
 * failure belongs in the value, where the caller can put it on screen.
 */
export async function api(path, body) {
	let res;
	try {
		res = await fetch(path, body === undefined
			? undefined
			: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		return { error: "the brain is not responding" };
	}
	const data = await res.json().catch(() => null);
	if (data && typeof data === "object") return data;
	return { error: res.ok ? "the brain sent a reply this page cannot read" : `request failed (${res.status})` };
}
