// 3D brain graph on Babylon.js: node cores + additive halos as SolidParticleSystems
// (one draw call each), edges as a single updatable LineSystem, hub labels on
// DynamicTextures, starfield as a PointsCloudSystem. Layout comes from d3-force-3d —
// Babylon renders, d3 simulates.

import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { SolidParticleSystem } from "@babylonjs/core/Particles/solidParticleSystem";
import { PointsCloudSystem } from "@babylonjs/core/Particles/pointsCloudSystem";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Effect } from "@babylonjs/core/Materials/effect";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import "@babylonjs/core/Culling/ray"; // side-effect: enables scene.pick
import { forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_ROTATE_DELAY_MS = 5000;
const IDLE_ROTATE_SPEED = 0.045; // radians / second
const CLUSTER_STRENGTH = 0.9;
const HUB_LABEL_MIN_CONNECTIONS = 7;
const PULSE_INTERVAL_MS = 1000 / 30; // halo breathing runs at most 30fps
const PICK_INTERVAL_MS = 50; // hover picking at most 20 Hz
const SIM_TICKS = 300;
const BACKGROUND = new Color4(1 / 255, 1 / 255, 2 / 255, 1);
const FLY_SPEED = 130; // units / second; Shift multiplies
const DIM = new Color3(0x17 / 255, 0x1b / 255, 0x2e / 255);

// Anatomical brain proportions the layout settles into: an ellipsoid longer
// front-to-back than wide, wider than tall, split into two hemispheres.
const BRAIN = { x: 150, y: 120, z: 200 };
const FISSURE_HALF_WIDTH = 14;
const SHELL_INNER = 0.62; // nodes live in the cortical shell, not the deep interior
const SPARK_COUNT = 320;

Effect.ShadersStore.brainUnlitVertexShader = `
precision highp float;
attribute vec3 position; attribute vec4 color;
uniform mat4 worldViewProjection;
varying vec4 vColor;
void main() { gl_Position = worldViewProjection * vec4(position, 1.0); vColor = color; }`;
Effect.ShadersStore.brainUnlitFragmentShader = `
precision highp float; varying vec4 vColor;
void main() { gl_FragColor = vec4(vColor.rgb, 1.0); }`;

Effect.ShadersStore.brainHaloVertexShader = `
precision highp float;
attribute vec3 position; attribute vec4 color; attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec4 vColor; varying vec2 vUV;
void main() { gl_Position = worldViewProjection * vec4(position, 1.0); vColor = color; vUV = uv; }`;
Effect.ShadersStore.brainHaloFragmentShader = `
precision highp float; varying vec4 vColor; varying vec2 vUV;
void main() {
	float d = distance(vUV, vec2(0.5));
	float a = smoothstep(0.5, 0.0, d);
	// Steep falloff keeps halos as tight rims instead of washing the scene out.
	a = pow(a, 4.0);
	gl_FragColor = vec4(vColor.rgb * a * vColor.a, 1.0);
}`;

function hexToColor3(hex) {
	return Color3.FromHexString(hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex);
}

export function createBrainTab(container) {
	container.classList.add("brain-tab");

	const el = document.createElement("div");
	el.className = "brain-graph";
	container.appendChild(el);
	const canvas = document.createElement("canvas");
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvas.style.display = "block";
	canvas.style.outline = "none";
	el.appendChild(canvas);

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
	let resizeObs = null;

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	const categoryVisibility = new Map();
	let graphData = { nodes: [], edges: [], categories: [] };
	let categoryById = new Map();
	let nodeById = new Map();
	let neighborsOf = new Map();
	let hoveredNode = null;
	let selectedNode = null;
	let searchMatchIds = null;
	let lastInteraction = Date.now();

	const categoryOf = (node) => categoryById.get(node.category);
	const nodeVisible = (node) => categoryVisibility.get(node.category) !== false;
	const focusNode = () => hoveredNode ?? selectedNode;

	function emphasisOf(node) {
		if (searchMatchIds) return searchMatchIds.has(node.id) ? "hi" : "dim";
		const focus = focusNode();
		if (!focus) return "normal";
		if (node.id === focus.id) return "hi";
		return neighborsOf.get(focus.id)?.has(node.id) ? "hi" : "dim";
	}

	function linkEmphasis(edge) {
		if (searchMatchIds) {
			return searchMatchIds.has(edge.source) && searchMatchIds.has(edge.target) ? "hi" : "dim";
		}
		const focus = focusNode();
		if (!focus) return "normal";
		return edge.source === focus.id || edge.target === focus.id ? "hi" : "dim";
	}

	// -------------------------------------------------------------------------
	// Scene
	// -------------------------------------------------------------------------

	// MSAA off — the pipeline's FXAA is cheaper and bloom hides the difference.
	const engine = new Engine(canvas, false, { powerPreference: "high-performance" });
	engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
	const scene = new Scene(engine);
	scene.clearColor = BACKGROUND;
	scene.fogMode = Scene.FOGMODE_EXP2;
	scene.fogDensity = 0.0004;
	scene.fogColor = new Color3(BACKGROUND.r, BACKGROUND.g, BACKGROUND.b);
	scene.skipPointerMovePicking = true; // we pick ourselves, throttled

	const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.15, 1600, Vector3.Zero(), scene);
	// noPreventDefault must stay false — otherwise the browser keeps wheel events and zoom dies.
	camera.attachControl(canvas, false);
	// Right-drag rotates too — the context menu would otherwise swallow button 2.
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());
	camera.minZ = 1;
	camera.maxZ = 8000;
	camera.wheelDeltaPercentage = 0.05; // proportional zoom: snappy far out, precise up close
	camera.pinchDeltaPercentage = 0.01;
	camera.panningSensibility = 0;
	camera.lowerRadiusLimit = 15; // close enough to inspect a single neuron from inside
	camera.upperRadiusLimit = 4000;

	// HDR-style bloom is what makes the neurons read as light sources; FXAA smooths
	// lines; grain + vignette give the void some texture. One pipeline, GPU-side.
	const pipeline = new DefaultRenderingPipeline("brainFx", true, scene, [camera]);
	pipeline.fxaaEnabled = true;
	pipeline.bloomEnabled = true;
	pipeline.bloomThreshold = 0.45;
	pipeline.bloomWeight = 0.6;
	pipeline.bloomKernel = 64;
	pipeline.bloomScale = 0.5;
	pipeline.imageProcessingEnabled = true;
	pipeline.imageProcessing.vignetteEnabled = true;
	pipeline.imageProcessing.vignetteWeight = 1.6;
	pipeline.imageProcessing.contrast = 1.08;
	pipeline.imageProcessing.exposure = 1.0;
	pipeline.grainEnabled = true;
	pipeline.grain.intensity = 3.5; // any higher and the void reads grey instead of black
	pipeline.grain.animated = true;

	// Free-roam: WASD flies camera + orbit pivot together (QE / Space+C for vertical),
	// Shift is afterburner. Mouse keeps orbiting around wherever you've flown to.
	const flyKeys = new Set();
	const isTyping = () => {
		const a = document.activeElement;
		return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
	};
	document.addEventListener("keydown", (e) => {
		if (!visible || isTyping()) return;
		flyKeys.add(e.code);
	});
	document.addEventListener("keyup", (e) => flyKeys.delete(e.code));
	window.addEventListener("blur", () => flyKeys.clear());

	function applyFly(dt) {
		if (flyKeys.size === 0) return false;
		const forward = camera.target.subtract(camera.position);
		forward.normalize();
		const right = Vector3.Cross(camera.upVector, forward).normalize();
		const move = Vector3.Zero();
		if (flyKeys.has("KeyW")) move.addInPlace(forward);
		if (flyKeys.has("KeyS")) move.subtractInPlace(forward);
		if (flyKeys.has("KeyD")) move.addInPlace(right);
		if (flyKeys.has("KeyA")) move.subtractInPlace(right);
		if (flyKeys.has("KeyE") || flyKeys.has("Space")) move.addInPlace(camera.upVector);
		if (flyKeys.has("KeyQ") || flyKeys.has("KeyC")) move.subtractInPlace(camera.upVector);
		if (move.lengthSquared() === 0) return false;
		move.normalize();
		const speed = FLY_SPEED * (flyKeys.has("ShiftLeft") || flyKeys.has("ShiftRight") ? 4 : 1) * dt;
		move.scaleInPlace(speed);
		camera.target.addInPlace(move);
		camera.position.addInPlace(move);
		lastInteraction = Date.now();
		return true;
	}

	const coreMat = new ShaderMaterial("coreMat", scene, "brainUnlit", {
		attributes: ["position", "color"],
		uniforms: ["worldViewProjection"],
	});
	const haloMat = new ShaderMaterial("haloMat", scene, "brainHalo", {
		attributes: ["position", "color", "uv"],
		uniforms: ["worldViewProjection"],
		needAlphaBlending: true,
	});
	haloMat.alphaMode = Constants.ALPHA_ADD;
	haloMat.backFaceCulling = false;
	haloMat.disableDepthWrite = true;

	let coreSps = null;
	let haloSps = null;
	let sparkSps = null;
	let sparkMeta = []; // per spark: { edge: index, phase: 0..1, speed }
	let linesMesh = null;
	const labels = new Map(); // node id -> plane mesh
	let radii = [];

	// -------------------------------------------------------------------------
	// Starfield
	// -------------------------------------------------------------------------

	const stars = new PointsCloudSystem("stars", 1.6, scene);
	const tintA = hexToColor3("#5b6b9e");
	const tintB = hexToColor3("#8b95c9");
	stars.addPoints(1400, (p) => {
		const r = 700 + Math.random() * 1200;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		p.position = new Vector3(
			r * Math.sin(phi) * Math.cos(theta),
			r * Math.cos(phi),
			r * Math.sin(phi) * Math.sin(theta),
		);
		const c = Math.random() < 0.5 ? tintA : tintB;
		const jitter = 0.6 * (0.6 + Math.random() * 0.4);
		p.color = new Color4(c.r * jitter, c.g * jitter, c.b * jitter, 0.5);
	});
	stars.buildMeshAsync().then((mesh) => {
		mesh.isPickable = false;
		if (mesh.material) mesh.material.fogEnabled = false;
	});

	// -------------------------------------------------------------------------
	// Labels
	// -------------------------------------------------------------------------

	const truncate = (t, m) => (t.length > m ? `${t.slice(0, m - 1)}…` : t);

	function makeLabel(node, colorHex) {
		const text = truncate(node.title, 34);
		const fontPx = 44;
		const pad = 18;
		const measure = new DynamicTexture("measure", { width: 2, height: 2 }, scene, false);
		const mctx = measure.getContext();
		mctx.font = `500 ${fontPx}px "Space Grotesk", sans-serif`;
		const w = Math.ceil(mctx.measureText(text).width) + pad * 2;
		measure.dispose();
		const h = fontPx + pad * 2;
		const dt = new DynamicTexture(`label:${node.id}`, { width: w, height: h }, scene, true);
		dt.hasAlpha = true;
		const ctx = dt.getContext();
		ctx.font = `500 ${fontPx}px "Space Grotesk", sans-serif`;
		ctx.textBaseline = "middle";
		ctx.textAlign = "center";
		ctx.shadowColor = colorHex;
		ctx.shadowBlur = 18;
		ctx.fillStyle = "rgba(232,236,248,0.92)";
		ctx.fillText(text, w / 2, h / 2);
		dt.update();
		const mat = new StandardMaterial(`labelMat:${node.id}`, scene);
		mat.emissiveTexture = dt;
		mat.opacityTexture = dt;
		mat.disableLighting = true;
		mat.fogEnabled = false;
		const scale = 0.11;
		const plane = CreatePlane(`labelPlane:${node.id}`, { width: w * scale, height: h * scale }, scene);
		plane.material = mat;
		plane.billboardMode = TransformNode.BILLBOARDMODE_ALL;
		plane.isPickable = false;
		return plane;
	}

	// -------------------------------------------------------------------------
	// Graph construction + simulation
	// -------------------------------------------------------------------------

	let simulation = null;
	let simTicksLeft = 0;
	let flownIn = false;

	function buildScene() {
		const nodes = graphData.nodes;
		radii = nodes.map((n) => 2.6 + Math.sqrt(n.connections + 1) * 1.3);

		// Cores: one SPS, one draw call, pickable.
		const coreProto = CreateSphere("coreProto", { diameter: 2, segments: 12 }, scene);
		coreSps = new SolidParticleSystem("cores", scene, { isPickable: true });
		coreSps.addShape(coreProto, nodes.length);
		coreProto.dispose();
		const coreMesh = coreSps.buildMesh();
		coreMesh.material = coreMat;
		coreMesh.alwaysSelectAsActiveMesh = true;
		// Picking ray-tests the mesh bounding box first; keep it in sync as the
		// layout moves particles far from their build-time positions.
		coreSps.computeBoundingBox = true;

		// Halos: additive billboard planes, second SPS.
		const haloProto = CreatePlane("haloProto", { size: 2 }, scene);
		haloSps = new SolidParticleSystem("halos", scene, { isPickable: false });
		haloSps.addShape(haloProto, nodes.length);
		haloProto.dispose();
		haloSps.billboard = true;
		const haloMesh = haloSps.buildMesh();
		haloMesh.material = haloMat;
		haloMesh.isPickable = false;
		haloMesh.alwaysSelectAsActiveMesh = true;

		// Edges: one line system with per-vertex colors.
		const lines = graphData.edges.map(() => [Vector3.Zero(), Vector3.Zero()]);
		const colors = graphData.edges.map(() => [new Color4(1, 1, 1, 0.3), new Color4(1, 1, 1, 0.3)]);
		linesMesh = CreateLineSystem("edges", { lines, colors, useVertexColor: true, updatable: true }, scene);
		linesMesh.isPickable = false;

		// Hub labels.
		for (const n of nodes) {
			if (n.connections >= HUB_LABEL_MIN_CONNECTIONS) {
				labels.set(n.id, makeLabel(n, categoryOf(n)?.color ?? "#94a3b8"));
			}
		}

		applyEmphasis();

		// Force layout (d3 simulates, Babylon renders). Three anatomy forces shape a
		// real brain: category anchors pinned onto the cortex of a brain-proportioned
		// ellipsoid (hemispheres alternating), a shell force that keeps nodes in the
		// cortical band instead of the deep interior, and a longitudinal-fissure force
		// that carves the hemisphere split.
		const simLinks = graphData.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
		simulation = forceSimulation(nodes, 3)
			.force("link", forceLink(simLinks).id((d) => d.id).distance((l) => (l.kind === "timeline" ? 85 : 55)))
			.force("charge", forceManyBody().strength(-95))
			.stop();

		const cats = graphData.categories;
		const anchors = new Map(
			cats.map((c, i) => {
				// Golden-spiral point on the unit sphere, biased to the upper cortex,
				// stretched onto brain proportions, mirrored into alternating hemispheres.
				const golden = Math.PI * (3 - Math.sqrt(5));
				const y = 0.15 + (i / Math.max(cats.length - 1, 1)) * 0.8; // upper bias
				const r = Math.sqrt(Math.max(0, 1 - y * y));
				const theta = golden * i;
				const side = i % 2 === 0 ? 1 : -1;
				return [
					c.id,
					{
						x: side * Math.max(Math.abs(Math.cos(theta) * r) * BRAIN.x, FISSURE_HALF_WIDTH * 2.5),
						y: y * BRAIN.y,
						z: Math.sin(theta) * r * BRAIN.z,
					},
				];
			}),
		);

		simulation.force("anatomy", (alpha) => {
			for (const node of nodes) {
				const anchor = anchors.get(node.category);
				if (anchor) {
					const k = (node.connections === 0 ? 3 : 1) * CLUSTER_STRENGTH * alpha * 0.05;
					node.vx += (anchor.x - node.x) * k;
					node.vy += (anchor.y - node.y) * k;
					node.vz += (anchor.z - node.z) * k;
				}
				// Cortical shell: radial push toward the [SHELL_INNER, 1] band of the ellipsoid.
				const ex = node.x / BRAIN.x;
				const ey = node.y / BRAIN.y;
				const ez = node.z / BRAIN.z;
				const e = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6;
				const shellK = 0.6 * alpha;
				if (e > 1) {
					node.vx -= node.x * (1 - 1 / e) * shellK;
					node.vy -= node.y * (1 - 1 / e) * shellK;
					node.vz -= node.z * (1 - 1 / e) * shellK;
				} else if (e < SHELL_INNER) {
					const out = (SHELL_INNER / e - 1) * shellK;
					node.vx += node.x * out;
					node.vy += node.y * out;
					node.vz += node.z * out;
				}
				// Longitudinal fissure: keep the hemisphere gap clear.
				if (Math.abs(node.x) < FISSURE_HALF_WIDTH) {
					node.vx += (node.x >= 0 ? 1 : -1) * (FISSURE_HALF_WIDTH - Math.abs(node.x)) * alpha * 0.9;
				}
			}
		});
		simTicksLeft = SIM_TICKS;
		buildSparks();
	}

	// Synapse signals: sparks travel the edges — the brain visibly "thinks".
	// One SPS, one draw call, reuses the halo's radial shader.
	function buildSparks() {
		const edgeCount = graphData.edges.length;
		if (!edgeCount) return;
		const count = Math.min(SPARK_COUNT, edgeCount * 2);
		const proto = CreatePlane("sparkProto", { size: 2 }, scene);
		sparkSps = new SolidParticleSystem("sparks", scene, { isPickable: false });
		sparkSps.addShape(proto, count);
		proto.dispose();
		sparkSps.billboard = true;
		const mesh = sparkSps.buildMesh();
		mesh.material = haloMat;
		mesh.isPickable = false;
		mesh.alwaysSelectAsActiveMesh = true;
		sparkMeta = Array.from({ length: count }, () => ({
			edge: Math.floor(Math.random() * edgeCount),
			phase: Math.random(),
			speed: 0.1 + Math.random() * 0.2,
		}));
	}

	function updateSparks(dt) {
		if (!sparkSps) return;
		for (let i = 0; i < sparkMeta.length; i++) {
			const m = sparkMeta[i];
			m.phase += m.speed * dt;
			if (m.phase >= 1) {
				// Respawn on a fresh edge so activity wanders the whole brain.
				m.phase = 0;
				m.edge = Math.floor(Math.random() * graphData.edges.length);
			}
			const e = graphData.edges[m.edge];
			const s = nodeById.get(e.source);
			const t = nodeById.get(e.target);
			const p = sparkSps.particles[i];
			const visible = s && t && nodeVisible(s) && nodeVisible(t);
			if (!visible) {
				p.scaling.setAll(0.0001);
				continue;
			}
			const state = linkEmphasis(e);
			p.position.set(
				s.x + (t.x - s.x) * m.phase,
				s.y + (t.y - s.y) * m.phase,
				s.z + (t.z - s.z) * m.phase,
			);
			// Fade in and out along the run; dimmed edges barely spark.
			const arc = Math.sin(m.phase * Math.PI);
			const base = hexToColor3(categoryOf(s)?.color ?? "#7dd3fc");
			const alpha = state === "dim" ? 0.04 : state === "hi" ? 0.9 : 0.45;
			p.scaling.setAll(1.6 + arc * 1.2);
			p.color = new Color4(base.r, base.g, base.b, alpha * arc);
		}
		sparkSps.setParticles();
	}

	function syncPositions() {
		const nodes = graphData.nodes;
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			coreSps.particles[i].position.set(n.x, n.y, n.z);
			haloSps.particles[i].position.set(n.x, n.y, n.z);
			const label = labels.get(n.id);
			if (label) label.position.set(n.x, n.y - (radii[i] + 7), n.z);
		}
		coreSps.setParticles();
		haloSps.setParticles();
		const lines = graphData.edges.map((e) => {
			const s = nodeById.get(e.source);
			const t = nodeById.get(e.target);
			return [new Vector3(s.x, s.y, s.z), new Vector3(t.x, t.y, t.z)];
		});
		linesMesh = CreateLineSystem("edges", { lines, instance: linesMesh });
	}

	// -------------------------------------------------------------------------
	// Emphasis / restyle
	// -------------------------------------------------------------------------

	function applyEmphasis() {
		const nodes = graphData.nodes;
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			const core = coreSps.particles[i];
			const halo = haloSps.particles[i];
			const hidden = !nodeVisible(n);
			const state = emphasisOf(n);
			const base = hexToColor3(categoryOf(n)?.color ?? "#94a3b8");
			const r = radii[i];
			core.scaling.setAll(hidden ? 0.0001 : r);
			halo.scaling.setAll(hidden ? 0.0001 : r * 5);
			if (state === "dim") {
				core.color = new Color4(DIM.r, DIM.g, DIM.b, 1);
				halo.color = new Color4(base.r, base.g, base.b, 0.03);
			} else {
				core.color = new Color4(base.r, base.g, base.b, 1);
				halo.color = new Color4(base.r, base.g, base.b, state === "hi" ? 0.55 : 0.28);
			}
			n.__state = hidden ? "hidden" : state;
		}
		coreSps.setParticles();
		haloSps.setParticles();
		for (const [id, label] of labels) {
			const state = nodeById.get(id).__state;
			label.setEnabled(state !== "hidden");
			label.visibility = state === "dim" ? 0.1 : state === "hi" ? 1 : 0.85;
		}
		restyleLinks();
	}

	function restyleLinks() {
		if (!linesMesh) return;
		const data = new Float32Array(graphData.edges.length * 8);
		graphData.edges.forEach((e, i) => {
			const s = nodeById.get(e.source);
			const t = nodeById.get(e.target);
			const state = !nodeVisible(s) || !nodeVisible(t) ? "hidden" : linkEmphasis(e);
			let cr = 0;
			let cg = 0;
			let cb = 0;
			let ca = 0;
			if (state !== "hidden") {
				if (state === "dim") {
					cr = 30 / 255; cg = 34 / 255; cb = 54 / 255; ca = 0.12;
				} else if (e.kind === "timeline") {
					const hi = state === "hi";
					cr = hi ? 186 / 255 : 148 / 255; cg = hi ? 196 / 255 : 163 / 255; cb = hi ? 220 / 255 : 184 / 255; ca = hi ? 0.8 : 0.22;
				} else {
					const base = hexToColor3(categoryOf(s)?.color ?? "#7dd3fc");
					cr = base.r; cg = base.g; cb = base.b; ca = state === "hi" ? 1 : 0.32;
				}
			}
			// Gradient stroke: source tint at one end, target tint at the other.
			let tr = cr;
			let tg = cg;
			let tb = cb;
			if (state !== "hidden" && state !== "dim" && e.kind !== "timeline") {
				const tBase = hexToColor3(categoryOf(t)?.color ?? "#7dd3fc");
				tr = tBase.r; tg = tBase.g; tb = tBase.b;
			}
			data[i * 8] = cr;
			data[i * 8 + 1] = cg;
			data[i * 8 + 2] = cb;
			data[i * 8 + 3] = ca;
			data[i * 8 + 4] = tr;
			data[i * 8 + 5] = tg;
			data[i * 8 + 6] = tb;
			data[i * 8 + 7] = ca;
		});
		linesMesh.setVerticesData(VertexBuffer.ColorKind, data, true);
	}

	const restyle = () => {
		if (coreSps) applyEmphasis();
	};

	// -------------------------------------------------------------------------
	// Picking
	// -------------------------------------------------------------------------

	function pickNode() {
		const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === coreSps?.mesh);
		if (!pick?.hit) return null;
		const p = coreSps.pickedParticle(pick);
		if (!p) return null;
		const node = graphData.nodes[p.idx];
		return node && nodeVisible(node) ? node : null;
	}

	let lastPick = 0;
	canvas.addEventListener("pointermove", () => {
		if (!coreSps) return;
		const now = performance.now();
		if (now - lastPick < PICK_INTERVAL_MS) return;
		lastPick = now;
		const node = pickNode();
		if (node !== hoveredNode) {
			hoveredNode = node;
			canvas.style.cursor = node ? "pointer" : "default";
			restyle();
		}
	});
	canvas.addEventListener("pointerdown", () => {
		lastInteraction = Date.now();
	});
	canvas.addEventListener("wheel", () => {
		lastInteraction = Date.now();
	});
	canvas.addEventListener("click", () => {
		if (!coreSps) return;
		const node = pickNode();
		if (node) focusOnNode(node);
		else if (panel.classList.contains("open")) closePanel();
	});

	// -------------------------------------------------------------------------
	// Panel: note reader
	// -------------------------------------------------------------------------

	function escapeHtml(s) {
		return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

	let cameraGlide = null;

	function glideCamera(toTarget, toRadius, ms) {
		cameraGlide = {
			fromTarget: camera.target.clone(),
			toTarget,
			fromRadius: camera.radius,
			toRadius,
			start: performance.now(),
			ms,
		};
	}

	function focusOnNode(node) {
		lastInteraction = Date.now();
		glideCamera(new Vector3(node.x, node.y, node.z), 110, 1400);
		openPanel(node);
	}

	// -------------------------------------------------------------------------
	// Legend + search
	// -------------------------------------------------------------------------

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
				restyle();
			};
		});
	}

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
			(n) => n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)),
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

	// -------------------------------------------------------------------------
	// Render loop: simulation ticks, halo breathing, idle orbit, camera glide
	// -------------------------------------------------------------------------

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let lastPulse = 0;

	scene.onBeforeRenderObservable.add(() => {
		const now = performance.now();
		const dt = engine.getDeltaTime() / 1000;

		if (simulation && simTicksLeft > 0) {
			// A few ticks per frame settles the layout in a couple of seconds without jank.
			const ticks = Math.min(simTicksLeft, 3);
			for (let i = 0; i < ticks; i++) simulation.tick();
			simTicksLeft -= ticks;
			syncPositions();
			if (simTicksLeft <= 0 && !flownIn) {
				flownIn = true;
				let maxR = 0;
				for (const n of graphData.nodes) maxR = Math.max(maxR, Math.hypot(n.x, n.y, n.z));
				// Settle into a three-quarter profile — the brain silhouette reads best there.
				camera.alpha = -Math.PI / 2 + 0.6;
				camera.beta = Math.PI / 2.4;
				glideCamera(Vector3.Zero(), Math.max(maxR * 2.1, 300), 2000);
				lastInteraction = Date.now();
			}
		}

		if (applyFly(dt)) cameraGlide = null; // manual flight overrides any camera glide

		if (cameraGlide) {
			const t = Math.min((now - cameraGlide.start) / cameraGlide.ms, 1);
			const e = 1 - (1 - t) ** 3; // ease-out cubic
			camera.setTarget(Vector3.Lerp(cameraGlide.fromTarget, cameraGlide.toTarget, e));
			camera.radius = cameraGlide.fromRadius + (cameraGlide.toRadius - cameraGlide.fromRadius) * e;
			if (t >= 1) cameraGlide = null;
		}

		if (haloSps) {
			if (!reducedMotion && now - lastPulse >= PULSE_INTERVAL_MS) {
				lastPulse = now;
				const t = now / 1000;
				for (let i = 0; i < haloSps.particles.length; i++) {
					const n = graphData.nodes[i];
					if (n.__state === "hidden" || n.__state === "dim") continue;
					const pulse = 1 + 0.08 * Math.sin(t * 1.4 + (i % 32) / 5);
					haloSps.particles[i].scaling.setAll(radii[i] * 5 * pulse);
				}
			}
			// Billboards face the camera on setParticles; keep them honest while orbiting.
			haloSps.setParticles();
		}
		if (!reducedMotion) updateSparks(dt);

		const idle =
			!reducedMotion &&
			Date.now() - lastInteraction > IDLE_ROTATE_DELAY_MS &&
			!selectedNode &&
			!searchMatchIds &&
			!cameraGlide;
		if (idle) camera.alpha += IDLE_ROTATE_SPEED * dt;
	});

	function startLoop() {
		if (running || !visible || document.hidden) return;
		running = true;
		engine.runRenderLoop(() => scene.render());
	}
	function stopLoop() {
		running = false;
		engine.stopRenderLoop();
	}

	const onVisibility = () => {
		if (document.hidden) stopLoop();
		else startLoop();
	};
	document.addEventListener("visibilitychange", onVisibility);

	const applySize = () => engine.resize();
	resizeObs = new ResizeObserver(applySize);
	resizeObs.observe(container);

	// -------------------------------------------------------------------------
	// Load
	// -------------------------------------------------------------------------

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

			buildScene();
			renderLegend(data.categories, data.nodes);
			statsEl.innerHTML = `<span class="stat-num">${data.nodes.length}</span> memories<span class="stat-sep"></span><span class="stat-num">${data.edges.length}</span> synapses`;

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
