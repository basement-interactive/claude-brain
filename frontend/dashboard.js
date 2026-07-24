import { createBrainTab } from "./brain.js";
import { createDesignsTab } from "./designs.js";
import { createSettingsTab } from "./settings.js";

// Tab registry. Controllers are created lazily on first activation.
const TABS = [
	{ id: "brain", label: "Brain", make: createBrainTab, icon: iconBrain },
	{ id: "designs", label: "Designs", make: createDesignsTab, icon: iconDesigns },
	{ id: "settings", label: "Settings", make: createSettingsTab, icon: iconSettings },
];

function iconBrain() {
	return '<svg viewBox="0 0 22 22" fill="none"><circle cx="6" cy="7" r="2.3" stroke="currentColor" stroke-width="1.4"/><circle cx="15.5" cy="5.5" r="1.8" stroke="currentColor" stroke-width="1.4"/><circle cx="14" cy="15" r="2.1" stroke="currentColor" stroke-width="1.4"/><circle cx="6.5" cy="15.5" r="1.6" stroke="currentColor" stroke-width="1.4"/><path d="M8 8l6 6M8 7.5l6-1.4M8.2 14l4.6 1" stroke="currentColor" stroke-width="1.2" opacity=".7"/></svg>';
}
function iconDesigns() {
	return '<svg viewBox="0 0 22 22" fill="none"><rect x="3" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M3 13l3.6-3.2a1.4 1.4 0 0 1 1.9 0L12 13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="14.4" cy="8.4" r="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M7 19h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".6"/></svg>';
}
function iconSettings() {
	return '<svg viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M11 2.8v2.4M11 16.8v2.4M19.2 11h-2.4M5.2 11H2.8M16.8 5.2l-1.7 1.7M6.9 15.1l-1.7 1.7M16.8 16.8l-1.7-1.7M6.9 6.9L5.2 5.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
}

function build() {
	const app = document.getElementById("app");
	app.innerHTML = "";

	const rail = document.createElement("aside");
	rail.id = "rail";
	rail.innerHTML =
		'<div class="rail-logo" title="claude-brain">' +
		'<svg viewBox="0 0 24 24" fill="none"><circle cx="7" cy="8" r="3" fill="#7dd3fc"/><circle cx="17" cy="6.5" r="2.2" fill="#a78bfa"/><circle cx="15.5" cy="17" r="2.6" fill="#34d399"/><path d="M9.4 9.6l4.5 5.8M9.6 8l5-1M14 8.6l1.2 5.8" stroke="#4c5470" stroke-width="1"/></svg>' +
		"</div>";

	const nav = document.createElement("nav");
	nav.className = "rail-nav";
	const indicator = document.createElement("div");
	indicator.className = "rail-indicator";
	nav.appendChild(indicator);

	const view = document.createElement("main");
	view.id = "view";

	const btns = {};
	const panels = {};
	const controllers = {};

	for (const tab of TABS) {
		const btn = document.createElement("button");
		btn.className = "rail-tab";
		btn.dataset.tab = tab.id;
		btn.innerHTML = `<span class="rail-icon">${tab.icon()}</span><span class="rail-label">${tab.label}</span>`;
		btn.addEventListener("click", () => activate(tab.id));
		nav.appendChild(btn);
		btns[tab.id] = btn;

		const panel = document.createElement("section");
		panel.className = "tab-panel";
		panel.dataset.tab = tab.id;
		view.appendChild(panel);
		panels[tab.id] = panel;
	}

	rail.appendChild(nav);
	app.appendChild(rail);
	app.appendChild(view);

	let active = null;

	function moveIndicator(id) {
		const index = TABS.findIndex((t) => t.id === id);
		indicator.style.transform = `translateY(${index * 100}%)`;
	}

	function activate(id) {
		if (active === id) return;
		if (active) {
			controllers[active]?.hide?.();
			panels[active].classList.remove("active");
			btns[active].classList.remove("active");
		}
		if (!controllers[id]) {
			const def = TABS.find((t) => t.id === id);
			controllers[id] = def.make(panels[id]);
		}
		panels[id].classList.add("active");
		btns[id].classList.add("active");
		moveIndicator(id);
		controllers[id].show?.();
		active = id;
		history.replaceState(null, "", `#${id}`);
	}

	// First run (no vault yet) lands on Settings so the user picks a location.
	const fromHash = TABS.some((t) => `#${t.id}` === location.hash) ? location.hash.slice(1) : null;
	fetch("/api/status")
		.then((r) => r.json())
		.then((s) => activate(fromHash ?? (s.vault ? "brain" : "settings")))
		.catch(() => activate(fromHash ?? "brain"));

	const boot = document.getElementById("boot");
	if (boot) {
		boot.classList.add("done");
		setTimeout(() => boot.remove(), 500);
	}
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", build);
} else {
	build();
}
