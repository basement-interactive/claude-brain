import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_ROTATE_DELAY_MS = 5000;
const IDLE_ROTATE_SPEED = 0.045; // radians / second
const CLUSTER_STRENGTH = 0.9;
const HUB_LABEL_MIN_CONNECTIONS = 7;
const PULSE_INTERVAL_MS = 1000 / 30; // halo breathing runs at most 30fps
const MAX_PIXEL_RATIO = 1.5;
const COOLDOWN_TICKS = 480; // ~8s of layout at 60fps; ticks (unlike wall clock) survive pause gating
const DIM_COLOR = new THREE.Color("#171b2e");
const BACKGROUND = "#050508";
// One unit sphere shared by every node core (scaled per node); per-node geometries were pure waste.
const CORE_GEOMETRY = new THREE.SphereGeometry(1, 24, 24);

export function createBrainTab(container) {
	container.classList.add("brain-tab");

	const el = document.createElement("div");
	el.className = "brain-graph";
	container.appendChild(el);

	const chrome = document.createElement("div");
	chrome.className = "brain-chrome";
	chrome.innerHTML =
		'<div class="brain-search glass">' +
		'<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.1"/><path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>' +
		'<input class="brain-search-input" type="text" placeholder="Search memories" autocomplete="off" spellcheck="false" />' +
		'<kbd>/</kbd><ul class="brain-results"></ul></div>' +
		'<div class="brain-stats glass"></div>' +
		'<div class="brain-legend glass"></div>' +
		'<div class="brain-loading"><div class="pulse-rings"><span></span><span></span><span></span></div><div class="loading-text">waking the cortex</div></div>';
	container.appendChild(chrome);

	const panel = document.createElement("aside");
	panel.className = "brain-panel";
	container.appendChild(panel);

	const statsEl = chrome.querySelector(".brain-stats");
	const legendEl = chrome.querySelector(".brain-legend");
	const searchInput = chrome.querySelector(".brain-search-input");
	const searchResults = chrome.querySelector(".brain-results");
	const loadingEl = chrome.querySelector(".brain-loading");

	let visible = false;
	let running = false;
	let rafId = 0;
	let resizeObs = null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const categoryVisibility = new Map(); // category id -> visible
const nodeVisuals = new Map(); // node id -> { core, glowInner, glowOuter, label, baseColor, radius, phase, state, hidden }
const visualList = []; // flat mirror of nodeVisuals for allocation-free per-frame iteration
const rgbaCache = new Map(); // "hex|alpha" -> rgba string; keeps THREE.Color churn out of link restyles
let graphData = { nodes: [], edges: [], categories: [] };
let categoryById = new Map();
let nodeById = new Map();
let neighborsOf = new Map(); // node id -> Set<node id>
let hoveredNode = null;
let selectedNode = null;
let searchMatchIds = null; // Set<string> | null
let lastInteraction = Date.now();

function categoryOf(node) {
	return categoryById.get(node.category);
}

function nodeVisible(node) {
	return categoryVisibility.get(node.category) !== false;
}

function endpointNode(end) {
	return typeof end === "object" ? end : nodeById.get(end);
}

function linkVisibleFn(link) {
	const s = endpointNode(link.source);
	const t = endpointNode(link.target);
	return !!(s && t && nodeVisible(s) && nodeVisible(t));
}

// "focus" = the node whose neighborhood is emphasized right now
function focusNode() {
	return hoveredNode ?? selectedNode;
}

/** Visual state of a node under current hover / selection / search. */
function emphasisOf(node) {
	if (searchMatchIds) return searchMatchIds.has(node.id) ? "hi" : "dim";
	const focus = focusNode();
	if (!focus) return "normal";
	if (node.id === focus.id) return "hi";
	return neighborsOf.get(focus.id)?.has(node.id) ? "hi" : "dim";
}

function linkEmphasis(link) {
	const s = endpointNode(link.source);
	const t = endpointNode(link.target);
	if (!s || !t) return "normal";
	if (searchMatchIds) {
		return searchMatchIds.has(s.id) && searchMatchIds.has(t.id) ? "hi" : "dim";
	}
	const focus = focusNode();
	if (!focus) return "normal";
	return s.id === focus.id || t.id === focus.id ? "hi" : "dim";
}

// ---------------------------------------------------------------------------
// Node objects: emissive core + additive halo + hub label
// ---------------------------------------------------------------------------

function makeRadialTexture() {
	const size = 128;
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext("2d");
	const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	grad.addColorStop(0, "rgba(255,255,255,0.95)");
	grad.addColorStop(0.3, "rgba(255,255,255,0.4)");
	grad.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, size, size);
	return new THREE.CanvasTexture(canvas);
}
const HALO_TEXTURE = makeRadialTexture();

function makeLabelSprite(text, colorHex) {
	const pad = 18;
	const fontPx = 44;
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	ctx.font = `500 ${fontPx}px "Space Grotesk", sans-serif`;
	const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
	const h = fontPx + pad * 2;
	canvas.width = w;
	canvas.height = h;
	const c2 = canvas.getContext("2d");
	c2.font = `500 ${fontPx}px "Space Grotesk", sans-serif`;
	c2.textBaseline = "middle";
	c2.textAlign = "center";
	c2.shadowColor = colorHex;
	c2.shadowBlur = 18;
	c2.fillStyle = "rgba(232,236,248,0.92)";
	c2.fillText(text, w / 2, h / 2);
	const texture = new THREE.CanvasTexture(canvas);
	texture.anisotropy = 4;
	const sprite = new THREE.Sprite(
		new THREE.SpriteMaterial({
			map: texture,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
		}),
	);
	const scale = 0.11;
	sprite.scale.set(w * scale, h * scale, 1);
	return sprite;
}

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildNodeObject(node) {
	const colorHex = categoryOf(node)?.color ?? "#94a3b8";
	const baseColor = new THREE.Color(colorHex);
	const radius = 2.6 + Math.sqrt(node.connections + 1) * 1.3;
	const group = new THREE.Group();

	const core = new THREE.Mesh(CORE_GEOMETRY, new THREE.MeshBasicMaterial({ color: baseColor }));
	core.scale.setScalar(radius);
	group.add(core);

	// Inner glow: hot, tight. Outer glow: wide ambient falloff.
	const glowInner = new THREE.Sprite(
		new THREE.SpriteMaterial({
			map: HALO_TEXTURE,
			color: baseColor,
			transparent: true,
			opacity: 1,
			fog: false,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
		}),
	);
	glowInner.scale.set(radius * 4.2, radius * 4.2, 1);
	group.add(glowInner);

	const glowOuter = new THREE.Sprite(
		new THREE.SpriteMaterial({
			map: HALO_TEXTURE,
			color: baseColor,
			transparent: true,
			opacity: 0.35,
			fog: false,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
		}),
	);
	glowOuter.scale.set(radius * 10, radius * 10, 1);
	group.add(glowOuter);

	let label = null;
	if (node.connections >= HUB_LABEL_MIN_CONNECTIONS) {
		label = makeLabelSprite(truncate(node.title, 34), colorHex);
		label.position.set(0, -(radius + 7), 0);
		group.add(label);
	}

	const visual = {
		core,
		glowInner,
		glowOuter,
		label,
		baseColor,
		radius,
		phase: Math.random() * Math.PI * 2,
		state: "normal", // last emphasis applied; restyles only touch nodes whose state changed
		hidden: false, // category toggled off; the breathing loop skips these
	};
	nodeVisuals.set(node.id, visual);
	visualList.push(visual);
	return group;
}

/** Apply hover / selection / search emphasis by mutating materials in place. */
function applyNodeEmphasis() {
	for (const node of graphData.nodes) {
		const v = nodeVisuals.get(node.id);
		if (!v) continue;
		const state = emphasisOf(node);
		if (state === v.state) continue;
		v.state = state;
		if (state === "dim") {
			v.core.material.color.copy(DIM_COLOR);
			v.glowInner.material.opacity = 0.08;
			v.glowOuter.material.opacity = 0.03;
			if (v.label) v.label.material.opacity = 0.1;
		} else {
			v.core.material.color.copy(v.baseColor);
			v.glowInner.material.opacity = state === "hi" ? 1 : 0.9;
			v.glowOuter.material.opacity = state === "hi" ? 0.55 : 0.28;
			if (v.label) v.label.material.opacity = state === "hi" ? 1 : 0.85;
		}
	}
}

// ---------------------------------------------------------------------------
// Link styling: synapses tinted by source lobe
// ---------------------------------------------------------------------------

function linkColorFn(link) {
	const state = linkEmphasis(link);
	if (state === "dim") return "rgba(30,34,54,0.12)";
	if (link.kind === "timeline") {
		return state === "hi" ? "rgba(186,196,220,0.8)" : "rgba(148,163,184,0.22)";
	}
	const s = endpointNode(link.source);
	const color = s ? (categoryOf(s)?.color ?? "#7dd3fc") : "#7dd3fc";
	return state === "hi" ? color : hexWithAlpha(color, 0.32);
}

function linkWidthFn(link) {
	const state = linkEmphasis(link);
	if (state === "hi") return 1.2;
	return link.kind === "wikilink" ? 0.65 : 0.3;
}

function linkParticlesFn(link) {
	if (link.kind !== "wikilink") return 0;
	return linkEmphasis(link) === "hi" ? 4 : 2;
}

function linkParticleColorFn(link) {
	const s = endpointNode(link.source);
	return s ? (categoryOf(s)?.color ?? "#7dd3fc") : "#7dd3fc";
}

function hexWithAlpha(hex, alpha) {
	const key = `${hex}|${alpha}`;
	let rgba = rgbaCache.get(key);
	if (rgba === undefined) {
		const c = new THREE.Color(hex);
		rgba = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${alpha})`;
		rgbaCache.set(key, rgba);
	}
	return rgba;
}

function restyle() {
	applyNodeEmphasis();
	Graph.linkColor(linkColorFn);
	Graph.linkWidth(linkWidthFn);
	Graph.linkDirectionalParticles(linkParticlesFn);
}

// ---------------------------------------------------------------------------
// Cluster force: category anchors form the lobes
// ---------------------------------------------------------------------------

function clusterForce(nodes) {
	function force(alpha) {
		for (const node of nodes) {
			const anchor = categoryOf(node)?.anchor;
			if (!anchor) continue;
			// Orphans have no link force holding them in; triple the anchor pull.
			const k = (node.connections === 0 ? 3 : 1) * CLUSTER_STRENGTH * alpha * 0.05;
			node.vx += (anchor.x - node.x) * k;
			node.vy += (anchor.y - node.y) * k;
			node.vz += (anchor.z - node.z) * k;
		}
	}
	return force;
}

// ---------------------------------------------------------------------------
// Ambient starfield
// ---------------------------------------------------------------------------

function addStarfield(scene) {
	const COUNT = 1400;
	const positions = new Float32Array(COUNT * 3);
	const colors = new Float32Array(COUNT * 3);
	const tintA = new THREE.Color("#5b6b9e");
	const tintB = new THREE.Color("#8b95c9");
	for (let i = 0; i < COUNT; i++) {
		// random point in spherical shell r in [700, 1900]
		const r = 700 + Math.random() * 1200;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		positions[i * 3 + 1] = r * Math.cos(phi);
		positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
		const c = Math.random() < 0.5 ? tintA : tintB;
		const jitter = 0.6 + Math.random() * 0.4;
		colors[i * 3] = c.r * jitter;
		colors[i * 3 + 1] = c.g * jitter;
		colors[i * 3 + 2] = c.b * jitter;
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
	const points = new THREE.Points(
		geometry,
		new THREE.PointsMaterial({
			size: 1.3,
			vertexColors: true,
			transparent: true,
			opacity: 0.4,
			sizeAttenuation: true,
			depthWrite: false,
		}),
	);
	scene.add(points);
	return points;
}

// ---------------------------------------------------------------------------
// Panel: note reader
// ---------------------------------------------------------------------------

function escapeHtml(s) {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** Tiny line-based markdown renderer for the note reader. Vault-local content. */
function renderMarkdown(md) {
	const escaped = escapeHtml(md);
	const lines = escaped.split("\n");
	const out = [];
	let inCode = false;
	for (const line of lines) {
		if (line.startsWith("```")) {
			out.push(inCode ? "</code></pre>" : '<pre class="md-code"><code>');
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			out.push(`${line}\n`);
			continue;
		}
		let html = line
			.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => `<span class="wl">${alias ?? target}</span>`)
			.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
			.replace(/`([^`]+)`/g, "<code>$1</code>");
		if (/^####\s/.test(html)) out.push(`<h5>${html.slice(5)}</h5>`);
		else if (/^###\s/.test(html)) out.push(`<h5>${html.slice(4)}</h5>`);
		else if (/^##\s/.test(html)) out.push(`<h4>${html.slice(3)}</h4>`);
		else if (/^#\s/.test(html)) out.push(`<h4>${html.slice(2)}</h4>`);
		else if (/^\s*-\s/.test(html)) out.push(`<div class="md-li">${html.replace(/^\s*-\s/, "")}</div>`);
		else if (html.trim() === "") out.push('<div class="md-gap"></div>');
		else out.push(`<p>${html}</p>`);
	}
	if (inCode) out.push("</code></pre>");
	return out.join("");
}

function openPanel(node) {
	selectedNode = node;
	restyle();
	panel.classList.add("open");
	panel.innerHTML = '<div class="panel-loading">reading note</div>';

	fetch(`/api/note?path=${encodeURIComponent(node.id)}`)
		.then((r) => r.json())
		.then((data) => {
			if (data.error) {
				panel.innerHTML = `<div class="panel-error">${escapeHtml(data.error)}</div>`;
				return;
			}
			const cat = categoryOf(node);
			const tagsHtml = (data.node.tags ?? [])
				.map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
				.join("");
			const backlinksHtml = (data.backlinks ?? [])
				.map((id) => {
					const n = nodeById.get(id);
					if (!n) return "";
					const c = categoryOf(n);
					return `<li data-id="${escapeHtml(id)}"><span class="bl-dot" style="--c:${c?.color}"></span>${escapeHtml(n.title)}</li>`;
				})
				.join("");
			panel.innerHTML = `
				<div class="panel-inner">
					<button class="panel-close" id="panel-close" aria-label="Close">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
					</button>
					<div class="panel-category" style="--c:${cat?.color}">${cat?.label ?? node.category}</div>
					<h2>${escapeHtml(data.node.title)}</h2>
					<div class="panel-meta">
						${data.node.date ? `<span>${escapeHtml(data.node.date)}</span>` : ""}
						${data.node.status ? `<span class="status">${escapeHtml(data.node.status)}</span>` : ""}
						<span>${node.connections} connections</span>
					</div>
					${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ""}
					<div class="panel-content">${renderMarkdown(data.content.slice(0, 12000))}</div>
					${backlinksHtml ? `<div class="panel-section">Connected memories</div><ul class="backlinks">${backlinksHtml}</ul>` : ""}
					<div class="panel-path">${escapeHtml(node.id)}</div>
				</div>
			`;
			document.getElementById("panel-close").onclick = closePanel;
			panel.querySelectorAll(".backlinks li").forEach((li) => {
				li.onclick = () => {
					const target = nodeById.get(li.dataset.id);
					if (target) focusOnNode(target);
				};
			});
		});
}

function closePanel() {
	panel.classList.remove("open");
	selectedNode = null;
	restyle();
}

function focusOnNode(node) {
	lastInteraction = Date.now();
	const distance = 110;
	const len = Math.hypot(node.x || 1, node.y || 1, node.z || 1);
	const ratio = 1 + distance / len;
	Graph.cameraPosition(
		{ x: (node.x || 0) * ratio, y: (node.y || 0) * ratio, z: (node.z || 0) * ratio },
		node,
		1400,
	);
	openPanel(node);
}

// ---------------------------------------------------------------------------
// Legend with per-category counts
// ---------------------------------------------------------------------------

function renderLegend(categories, nodes) {
	const counts = new Map();
	for (const n of nodes) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
	legendEl.innerHTML = categories
		.filter((c) => (counts.get(c.id) ?? 0) > 0)
		.map(
			(c) => `
			<label class="legend-item" style="--c:${c.color}">
				<input type="checkbox" checked data-cat="${c.id}" />
				<span class="dot"></span>
				<span class="legend-label">${c.label}</span>
				<span class="legend-count">${counts.get(c.id)}</span>
			</label>`,
		)
		.join("");
	legendEl.querySelectorAll("input").forEach((input) => {
		input.onchange = () => {
			categoryVisibility.set(input.dataset.cat, input.checked);
			for (const node of graphData.nodes) {
				const v = nodeVisuals.get(node.id);
				if (v) v.hidden = !nodeVisible(node);
			}
			Graph.nodeVisibility(nodeVisible);
			Graph.linkVisibility(linkVisibleFn);
		};
	});
}

// ---------------------------------------------------------------------------
// Search with live results dropdown
// ---------------------------------------------------------------------------

function runSearch(query) {
	const q = query.trim().toLowerCase();
	if (!q) {
		searchMatchIds = null;
		searchResults.classList.remove("open");
		searchResults.innerHTML = "";
		restyle();
		return;
	}
	const matches = graphData.nodes.filter(
		(n) =>
			n.title.toLowerCase().includes(q) ||
			n.tags.some((t) => t.toLowerCase().includes(q)),
	);
	searchMatchIds = new Set(matches.map((n) => n.id));
	restyle();

	searchResults.innerHTML = matches
		.slice(0, 8)
		.map((n) => {
			const c = categoryOf(n);
			return `<li data-id="${escapeHtml(n.id)}"><span class="bl-dot" style="--c:${c?.color}"></span><span class="sr-title">${escapeHtml(n.title)}</span><span class="sr-cat">${c?.label ?? ""}</span></li>`;
		})
		.join("");
	searchResults.classList.toggle("open", matches.length > 0);
	searchResults.querySelectorAll("li").forEach((li) => {
		li.onclick = () => {
			const target = nodeById.get(li.dataset.id);
			if (target) {
				clearSearch();
				focusOnNode(target);
			}
		};
	});
}

function clearSearch() {
	searchInput.value = "";
	searchMatchIds = null;
	searchResults.classList.remove("open");
	searchResults.innerHTML = "";
	restyle();
}

searchInput.addEventListener("input", () => runSearch(searchInput.value));
searchInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		const first = searchResults.querySelector("li");
		if (first) first.click();
	} else if (e.key === "Escape") {
		clearSearch();
		searchInput.blur();
	}
});

	const onKey = (e) => {
		if (!visible) return;
		if (e.key === "/" && document.activeElement !== searchInput) {
			e.preventDefault();
			searchInput.focus();
		} else if (e.key === "Escape" && document.activeElement !== searchInput) {
			if (panel.classList.contains("open")) closePanel();
		}
	};
	document.addEventListener("keydown", onKey);

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

const Graph = new ForceGraph3D(el, {
	controlType: "orbit",
	rendererConfig: { powerPreference: "high-performance" },
})
	.backgroundColor(BACKGROUND)
	.showNavInfo(false)
	.nodeId("id")
	.nodeLabel(
		(n) =>
			`<div class="tooltip"><span class="tt-dot" style="--c:${categoryOf(n)?.color}"></span><b>${escapeHtml(n.title)}</b><span class="tt-cat">${categoryOf(n)?.label ?? ""}</span></div>`,
	)
	.nodeThreeObject(buildNodeObject)
	.nodeThreeObjectExtend(false)
	.nodeVisibility(nodeVisible)
	.linkVisibility(linkVisibleFn)
	.linkColor(linkColorFn)
	.linkWidth(linkWidthFn)
	.linkOpacity(0.5)
	.linkCurvature(0.16)
	.linkDirectionalParticles(linkParticlesFn)
	.linkDirectionalParticleWidth(1.4)
	.linkDirectionalParticleSpeed(0.004)
	.linkDirectionalParticleColor(linkParticleColorFn)
	.enableNodeDrag(false)
	.cooldownTicks(COOLDOWN_TICKS)
	.cooldownTime(Infinity) // wall clock keeps running through pause gaps; the tick budget above is the real cap
	.onNodeHover((node) => {
		if (node === hoveredNode) return;
		hoveredNode = node;
		el.style.cursor = node ? "pointer" : "default";
		restyle();
	})
	.onNodeClick(focusOnNode)
	.onBackgroundClick(() => {
		if (panel.classList.contains("open")) closePanel();
	});

	// The lib defaults to min(2, devicePixelRatio); clamp harder — the glow sprites hide the difference.
	Graph.renderer()?.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));

	const applySize = () => {
		const w = el.clientWidth || container.clientWidth || window.innerWidth;
		const h = el.clientHeight || container.clientHeight || window.innerHeight;
		Graph.width(w).height(h);
	};
	applySize();
	resizeObs = new ResizeObserver(applySize);
	resizeObs.observe(container);

	function startLoop() {
		if (running || !visible || document.hidden) return;
		running = true;
		Graph.resumeAnimation();
		startAnimationLoop();
	}
	function stopLoop() {
		running = false;
		if (rafId) {
			cancelAnimationFrame(rafId);
			rafId = 0;
		}
		Graph.pauseAnimation();
	}

const scene = Graph.scene();
scene.fog = new THREE.FogExp2(new THREE.Color(BACKGROUND), 0.0004);
addStarfield(scene);

	// Stay cold until show(): pauseAnimation() halts the lib's internal rAF, which
	// drives both rendering and force-engine ticks.
	Graph.pauseAnimation();

	const onVisibility = () => {
		if (document.hidden) stopLoop();
		else startLoop(); // no-op unless this tab is the visible one
	};
	document.addEventListener("visibilitychange", onVisibility);

["pointerdown", "wheel"].forEach((evt) => {
	el.addEventListener(evt, () => {
		lastInteraction = Date.now();
	});
});

// ---------------------------------------------------------------------------
// Animation loop: halo breathing + idle orbit
// ---------------------------------------------------------------------------

	function startAnimationLoop() {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let lastFrame = performance.now();
		let lastPulse = 0;
		function tick(now) {
			if (!running) return;
			const dt = (now - lastFrame) / 1000;
			lastFrame = now;
			// Halo breathing, capped at 30fps; dimmed / hidden halos are invisible, skip them.
			if (now - lastPulse >= PULSE_INTERVAL_MS) {
				lastPulse = now;
				const t = now / 1000;
				for (let i = 0; i < visualList.length; i++) {
					const v = visualList[i];
					if (v.hidden || v.state === "dim") continue;
					const pulse = 1 + 0.08 * Math.sin(t * 1.4 + v.phase);
					const inner = v.radius * 4.2 * pulse;
					const outer = v.radius * 10 * pulse;
					v.glowInner.scale.set(inner, inner, 1);
					v.glowOuter.scale.set(outer, outer, 1);
				}
			}
			const idle =
				Date.now() - lastInteraction > IDLE_ROTATE_DELAY_MS &&
				!selectedNode &&
				!searchMatchIds;
			if (idle) {
				const controls = Graph.controls();
				if (controls?.object) {
					const angle = IDLE_ROTATE_SPEED * dt;
					const pos = controls.object.position;
					const x = pos.x * Math.cos(angle) - pos.z * Math.sin(angle);
					const z = pos.x * Math.sin(angle) + pos.z * Math.cos(angle);
					pos.x = x;
					pos.z = z;
					controls.update();
				}
			}
			rafId = requestAnimationFrame(tick);
		}
		rafId = requestAnimationFrame(tick);
	}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

Graph.cameraPosition({ x: 0, y: 0, z: 1600 });

fetch("/api/graph")
	.then((r) => r.json())
	.then((data) => {
		graphData = data;
		categoryById = new Map(data.categories.map((c) => [c.id, c]));
		nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		data.categories.forEach((c) => categoryVisibility.set(c.id, true));

		neighborsOf = new Map(data.nodes.map((n) => [n.id, new Set()]));
		for (const e of data.edges) {
			neighborsOf.get(e.source)?.add(e.target);
			neighborsOf.get(e.target)?.add(e.source);
		}

		Graph.graphData({
			nodes: data.nodes,
			links: data.edges.map((e) => ({ ...e })),
		});
		Graph.d3Force("cluster", clusterForce(data.nodes));
		Graph.d3Force("charge").strength(-55);
		Graph.d3Force("link").distance((l) => (l.kind === "timeline" ? 65 : 42));

		renderLegend(data.categories, data.nodes);
		statsEl.innerHTML = `<span class="stat-num">${data.nodes.length}</span> memories<span class="stat-sep"></span><span class="stat-num">${data.edges.length}</span> synapses`;

		// Cinematic fly-in once the force layout has settled
		let flownIn = false;
		Graph.onEngineStop(() => {
			if (flownIn) return;
			flownIn = true;
			Graph.zoomToFit(2000, 40);
			lastInteraction = Date.now();
		});

		loadingEl.classList.add("done");
		setTimeout(() => loadingEl.remove(), 700);
	});

	function show() {
		visible = true;
		applySize();
		setTimeout(applySize, 80);
		startLoop();
	}
	function hide() {
		visible = false;
		stopLoop();
	}
	return { show, hide };
}
