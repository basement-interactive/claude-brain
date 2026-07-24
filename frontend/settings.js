// Settings tab: vault selection, cloud sync, Claude Code integration, index health.

function el(tag, className, html) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (html !== undefined) node.innerHTML = html;
	return node;
}

function escapeHtml(s) {
	return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function api(path, body) {
	const res = await fetch(path, body === undefined
		? undefined
		: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return res.json();
}

const PROVIDERS = [
	{ id: "dropbox", label: "Dropbox" },
	{ id: "gdrive", label: "Google Drive" },
	{ id: "mega", label: "MEGA" },
];

export function createSettingsTab(container) {
	container.classList.add("settings-tab");
	const wrap = el("div", "settings-wrap");
	container.appendChild(wrap);

	let status = null;

	async function refresh() {
		status = await api("/api/status");
		render();
	}

	function section(title, subtitle) {
		const s = el("section", "settings-card glass");
		s.appendChild(el("h3", null, title));
		if (subtitle) s.appendChild(el("p", "settings-sub", subtitle));
		return s;
	}

	function render() {
		wrap.innerHTML = "";
		renderVault();
		renderSync();
		renderIntegration();
		renderIndex();
	}

	// --- Vault ---------------------------------------------------------------

	function renderVault() {
		const s = section(
			"Brain location",
			"Your brain is a folder of markdown notes on your disk. Point it at an existing Obsidian vault or any directory — new brains grow from an empty folder too.",
		);

		if (status.vault) {
			s.appendChild(
				el("div", `vault-current ${status.vaultReady ? "ok" : "warn"}`,
					`<span class="dot"></span><code>${escapeHtml(status.vault)}</code>` +
					(status.vaultReady ? "" : '<span class="vault-missing">not accessible right now</span>')),
			);
		} else {
			s.appendChild(el("div", "vault-current warn", '<span class="dot"></span>No vault selected yet — pick one below.'));
		}

		const picker = el("div", "vault-picker");
		const input = el("input", "settings-input");
		input.type = "text";
		input.placeholder = "/path/to/your/vault";
		input.value = status.vault ?? "";
		const apply = el("button", "settings-btn primary", "Use this folder");
		apply.onclick = async () => {
			apply.disabled = true;
			const out = await api("/api/config", { vault: input.value.trim() });
			if (out.error) {
				apply.disabled = false;
				alert(out.error);
				return;
			}
			await refresh();
		};
		picker.append(input, apply);
		s.appendChild(picker);

		const detectedWrap = el("div", "vault-detected");
		s.appendChild(detectedWrap);
		api("/api/vaults").then(({ vaults }) => {
			if (!vaults?.length) return;
			detectedWrap.appendChild(el("div", "settings-sub", "Detected Obsidian vaults:"));
			for (const v of vaults) {
				const b = el("button", "settings-btn ghost vault-suggestion", escapeHtml(v));
				b.onclick = () => {
					input.value = v;
				};
				detectedWrap.appendChild(b);
			}
		});

		wrap.appendChild(s);
	}

	// --- Sync ----------------------------------------------------------------

	function renderSync() {
		const s = section(
			"Cloud sync",
			"One-way mirror of your vault to your own cloud account (your machine stays the source of truth; remote deletions land in a dated trash folder). Runs on an interval and shortly after you edit notes.",
		);
		const sync = status.sync;

		const providers = el("div", "sync-providers");
		for (const p of PROVIDERS) {
			const b = el("button", `settings-btn ${sync.provider === p.id ? "primary" : "ghost"}`, p.label);
			b.onclick = async () => {
				await api("/api/sync/config", { provider: p.id });
				await refresh();
			};
			providers.appendChild(b);
		}
		s.appendChild(providers);

		if (sync.provider && !sync.remoteConfigured) {
			s.appendChild(
				el("div", "sync-hint warn",
					`Account not connected yet. Run <code>claude-brain sync setup ${sync.provider}</code> in a terminal — ` +
					"it opens the provider's own sign-in (credentials go to rclone on your machine, nowhere else)."),
			);
		}

		const controls = el("div", "sync-controls");
		const toggle = el("button", `settings-btn ${sync.enabled ? "primary" : "ghost"}`,
			sync.enabled ? "Auto-sync on" : "Auto-sync off");
		toggle.onclick = async () => {
			await api("/api/sync/config", { enabled: !sync.enabled });
			await refresh();
		};
		const now = el("button", "settings-btn ghost", sync.running ? "Syncing…" : "Sync now");
		now.disabled = sync.running || !sync.remoteConfigured;
		now.onclick = async () => {
			await api("/api/sync/now", {});
			setTimeout(refresh, 1500);
		};
		controls.append(toggle, now);
		s.appendChild(controls);

		if (sync.lastSync) {
			s.appendChild(el("div", "settings-sub",
				`Last sync: ${escapeHtml(sync.lastSync)} — ${sync.lastResult === "ok" ? "ok" : "failed"}`));
		}
		if (sync.log?.length) {
			s.appendChild(el("pre", "sync-log", sync.log.map(escapeHtml).join("\n")));
		}
		wrap.appendChild(s);
	}

	// --- Claude Code integration --------------------------------------------

	function renderIntegration() {
		const s = section(
			"Claude Code integration",
			"Wires the brain into Claude Code: every session recalls relevant notes before working and records what it learned back into your vault at session end.",
		);
		const i = status.integration;
		const all = i.claudeMd && i.hook && i.skill;
		s.appendChild(el("div", "integration-status",
			["claudeMd", "hook", "skill"].map((k) =>
				`<span class="pill ${i[k] ? "ok" : ""}">${{ claudeMd: "instructions", hook: "session hook", skill: "recording skill" }[k]}</span>`,
			).join("")));

		const btn = el("button", `settings-btn ${all ? "ghost" : "primary"}`,
			all ? "Remove integration" : "Integrate with Claude Code");
		btn.onclick = async () => {
			await api(all ? "/api/integrate/remove" : "/api/integrate", {});
			await refresh();
		};
		s.appendChild(btn);
		wrap.appendChild(s);
	}

	// --- Index health --------------------------------------------------------

	function renderIndex() {
		const s = section("Index", null);
		const idx = status.index;
		s.appendChild(el("div", "index-stats",
			`<span class="stat-num">${idx.docs}</span> notes` +
			`<span class="stat-sep"></span><span class="stat-num">${idx.chunks}</span> sections` +
			`<span class="stat-sep"></span>${idx.vectors ? `${idx.embedded} embedded` : "keyword-only (embeddings unavailable)"}` +
			(idx.pendingEmbed ? ` · ${idx.pendingEmbed} pending` : "")));
		const re = el("button", "settings-btn ghost", "Reindex now");
		re.onclick = async () => {
			re.disabled = true;
			await api("/api/reindex", {});
			await refresh();
		};
		s.appendChild(re);
		wrap.appendChild(s);
	}

	refresh();
	return {
		show() {
			refresh();
		},
		hide() {},
	};
}
