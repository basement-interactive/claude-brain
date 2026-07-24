// Claude Code integration: wires the brain into ~/.claude so every session recalls
// before working and records back into the vault at session end. All edits are
// reversible — the CLAUDE.md block is fenced by markers, the hook is tagged, and the
// skill lives in its own directory.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_MD = join(CLAUDE_DIR, "CLAUDE.md");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const SKILL_DIR = join(CLAUDE_DIR, "skills", "claude-brain");

const BLOCK_BEGIN = "<!-- claude-brain:begin -->";
const BLOCK_END = "<!-- claude-brain:end -->";
const HOOK_COMMAND = "claude-brain context 2>/dev/null || true";

function claudeMdBlock(): string {
	return `${BLOCK_BEGIN}
# claude-brain (always on)
A personal second brain (markdown vault) is connected via the \`claude-brain\` CLI — persistent memory across every session.
- **Remember, don't ingest.** Do NOT read the vault wholesale. Look things up with \`claude-brain recall "<query>"\` — hybrid search (BM25 + local embeddings + wikilink-graph boost) that returns only the relevant note sections. Works semantically: describe the symptom, exact keywords not required.
- **Before debugging or starting work**, run \`claude-brain recall "<topic or symptom>"\` first. Use returned paths to read only the specific note if more context is needed.
- **Record before ending a meaningful session** (unprompted): follow the recording protocol in \`~/.claude/skills/claude-brain/SKILL.md\` — work log to the vault's journal, solved bugs/gotchas as atomic notes. \`claude-brain note "<text>"\` captures quick thoughts into the vault inbox.
- The index refreshes automatically seconds after any vault change — never run manual reindex steps.
- Never edit or delete existing vault notes without asking. Adding new notes is always fine.
${BLOCK_END}`;
}

function skillMd(): string {
	return `---
name: claude-brain
description: >
  Always-on second brain backed by a local markdown vault. Recall relevant notes
  before working (claude-brain recall), capture new knowledge at session end.
  Trigger on any coding, debugging, planning, or research task.
---

# Recall (start of work)

Run \`claude-brain recall "<query>"\` before debugging or building — it searches the
user's vault (BM25 + embeddings) and returns only relevant sections. Prefer it over
re-deriving knowledge the vault already holds.

# Recording protocol (end of session, unprompted)

Before ending a session with meaningful work, record into the vault (location:
\`claude-brain status\` shows the vault path; all files are markdown):

1. **Work log** — append-or-create \`Journal/YYYY-MM-DD.md\` with a short dated
   section: what was done, decisions made, open ends.
2. **Solved bug / gotcha** — atomic note in \`Notes/<domain>/\` named after the
   symptom: Symptom / Root cause / Fix. Link related notes with \`[[wikilinks]]\`.
3. **Quick capture** — \`claude-brain note "<text>" [-f <subfolder>]\` drops a
   thought into \`<subfolder>/\` (default \`Inbox/\`) without opening an editor.

Rules:
- **Organize into topical subfolders, never a flat dump** — file notes under a
  domain folder (\`Notes/rust/\`, \`Notes/deploy/\`, …); create new domain folders
  freely when none fits (3+ related notes deserve their own folder). Folder-scoped
  lookup: \`claude-brain recall "<q>" -p "Notes/rust"\`.
- Never edit or delete existing notes without asking. New notes are always fine.
- Keep entries atomic and searchable — titles describe the symptom or topic.
- The index updates itself; no reindex commands needed.
`;
}

export interface IntegrationStatus {
	claudeMd: boolean;
	hook: boolean;
	skill: boolean;
}

export function integrationStatus(): IntegrationStatus {
	let md = false;
	try {
		md = readFileSync(CLAUDE_MD, "utf-8").includes(BLOCK_BEGIN);
	} catch {
		/* no CLAUDE.md yet */
	}
	let hook = false;
	try {
		hook = JSON.stringify(JSON.parse(readFileSync(SETTINGS, "utf-8"))).includes(HOOK_COMMAND);
	} catch {
		/* no settings yet */
	}
	return { claudeMd: md, hook, skill: existsSync(join(SKILL_DIR, "SKILL.md")) };
}

type HookEntry = { type: string; command: string; timeout?: number };
type HookMatcher = { matcher?: string; hooks: HookEntry[] };

export async function integrate(): Promise<IntegrationStatus> {
	mkdirSync(CLAUDE_DIR, { recursive: true });

	// CLAUDE.md: replace an existing fenced block, else append.
	let md = "";
	try {
		md = readFileSync(CLAUDE_MD, "utf-8");
	} catch {
		/* fresh file */
	}
	const blockRe = new RegExp(`${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}\\n?`);
	const next = blockRe.test(md)
		? md.replace(blockRe, `${claudeMdBlock()}\n`)
		: `${md.trimEnd()}\n\n${claudeMdBlock()}\n`.trimStart();
	await Bun.write(CLAUDE_MD, next);

	// settings.json: merge a SessionStart hook, preserving everything else.
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(SETTINGS, "utf-8"));
	} catch {
		/* fresh file */
	}
	const hooks = (settings.hooks ?? {}) as Record<string, HookMatcher[]>;
	const sessionStart: HookMatcher[] = hooks.SessionStart ?? [];
	const already = sessionStart.some((m) => m.hooks?.some((h) => h.command === HOOK_COMMAND));
	if (!already) {
		sessionStart.push({ hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }] });
		hooks.SessionStart = sessionStart;
		settings.hooks = hooks;
		await Bun.write(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
	}

	// Skill: recording protocol.
	mkdirSync(SKILL_DIR, { recursive: true });
	await Bun.write(join(SKILL_DIR, "SKILL.md"), skillMd());

	return integrationStatus();
}

export async function unintegrate(): Promise<IntegrationStatus> {
	try {
		const md = readFileSync(CLAUDE_MD, "utf-8");
		const cleaned = md.replace(new RegExp(`\\n?${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}\\n?`), "\n").trimEnd();
		await Bun.write(CLAUDE_MD, cleaned ? `${cleaned}\n` : "");
	} catch {
		/* nothing to clean */
	}
	try {
		const settings = JSON.parse(readFileSync(SETTINGS, "utf-8")) as Record<string, unknown>;
		const hooks = (settings.hooks ?? {}) as Record<string, HookMatcher[]>;
		if (hooks.SessionStart) {
			hooks.SessionStart = hooks.SessionStart
				.map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => h.command !== HOOK_COMMAND) }))
				.filter((m) => m.hooks.length > 0);
			if (hooks.SessionStart.length === 0) delete hooks.SessionStart;
			settings.hooks = hooks;
			await Bun.write(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
		}
	} catch {
		/* nothing to clean */
	}
	rmSync(SKILL_DIR, { recursive: true, force: true });
	return integrationStatus();
}

/** Small digest injected by the SessionStart hook. */
export async function contextDigest(): Promise<string> {
	const cfg = loadConfig();
	const lines: string[] = [];
	try {
		const res = await fetch(`http://localhost:${cfg.port}/api/status`, {
			signal: AbortSignal.timeout(3000),
		});
		if (res.ok) {
			const s = (await res.json()) as { index: { docs: number } };
			lines.push(`claude-brain: ${s.index.docs} notes indexed — recall with \`claude-brain recall "<q>"\``);
		}
	} catch {
		lines.push("claude-brain: server not running — start with `claude-brain` (recall falls back to direct index)");
	}
	if (!cfg.vault) lines.push("claude-brain: no vault selected yet — run `claude-brain` to pick one");
	return lines.join("\n");
}
