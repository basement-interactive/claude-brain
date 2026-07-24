# claude-brain

A local **second brain** for [Claude Code](https://claude.com/claude-code): your markdown
notes become persistent, searchable memory that Claude recalls before working and
records back into at the end of every session.

Everything runs on your machine. Your notes never leave your disk unless you connect
your own cloud account.

## Features

- **Hybrid recall** — BM25 full-text (SQLite FTS5) + local semantic embeddings
  (all-MiniLM-L6-v2 via ONNX, 384-dim, sqlite-vec) fused with reciprocal-rank fusion,
  graph ranking boosts, best-section-per-note pooling. ~100 ms queries, finds notes by
  meaning ("laptop battery drains fast" → your power-tuning note). Results are trimmed
  to the lines that answer the question, not the whole section.
- **Episodic memory** — the brain also remembers *what happened*, not just what you
  wrote down. Past sessions are mined from Claude Code's own transcripts, so recall
  answers "have we hit this before" alongside "what do we know". Nothing episodic is
  written to your vault; it lives in the local index only.
- **Memory that behaves like memory** — retrieving a note strengthens it, unused
  traces decay on a power-law curve, and recall spreads one hop along your links to
  surface the neighbouring note you didn't ask for. Recurring themes across separate
  sessions get flagged as candidates worth writing down.
- **Note graph you can traverse** — `path` between two notes, `explain` a note's
  neighbourhood, `affected` for everything pointing at it, `map` for the whole vault
  as named clusters. Links are typed from context (`caused_by`, `fixed_by`,
  `supersedes`, …) and supplemented by similarity, tag and timeline edges. No LLM
  anywhere: it rebuilds in ~100 ms on every change, so it is never stale.
- **Design memory** — drop screenshots of designs you like into the dashboard. Because
  recall is text, the brain converts each one into a written description of its design
  language (palette hex, spacing scale, typography, radii, shadows, motion, mood) and
  files it as a real note in your vault. Later, "build me a landing page like that
  dashboard I saved" actually resolves: `claude-brain design show "<vibe>"` prints the
  description and the image path.
- **`claude-brain reorganize`** — proposes a topical folder structure for a vault that
  grew organically, and files notes into it. It plans by default and moves nothing; only
  `--apply` touches the vault and `--undo` reverses it. It never renames, merges or
  deletes, and it refuses outright on a vault whose Obsidian link format would break
  links on a move.
- **3D knowledge graph** — every note a neuron, links as synapses, folders as
  lobes, with search, category filters, and an in-graph note reader.
- **Always fresh** — a file watcher reindexes seconds after you edit a note.
  Content-hash incremental: only changed notes are re-chunked and re-embedded.
- **You choose where the brain lives** — point it at an existing Obsidian vault or
  any folder of markdown. Switch anytime in Settings.
- **Cloud sync** — one-way mirror to your own **Dropbox**, **Google Drive**, or
  **MEGA** (via rclone; credentials stay in rclone on your machine). Dated remote
  trash folder protects against accidental deletions.
- **Claude Code integration** — one click wires it in: recall-first instructions,
  hooks that orient at session start, quietly cue relevant memory as you work, and
  consolidate at session end, plus a recording skill so sessions save what they
  learned as new notes.

## Install

```bash
yay -S claude-brain
```

## Use

```bash
claude-brain                 # opens the brain UI in your browser
```

First run: pick your vault location in **Settings** (detected Obsidian vaults are
suggested), then click **Integrate with Claude Code**. Optional cloud sync:

```bash
claude-brain sync setup dropbox   # or: gdrive, mega
```

CLI reference:

```
claude-brain recall "<query>" [k] [-p <folder>] [-e <n>] [--full]
                                   search notes and past sessions
claude-brain note "<text>" [-f <subfolder>]      quick-capture (default Inbox/)
claude-brain remember "<text>" [-k decision|preference|outcome]
                                   store a durable fact in episodic memory

claude-brain path "<from>" "<to>"  how two notes connect, hop by hop
claude-brain explain "<note>"      a note and everything around it
claude-brain affected "<note>"     what points at it, transitively
claude-brain map                   the vault as named clusters

claude-brain design list                         what designs are stored
claude-brain design add <path…> [--caption "…"]  save a design image
claude-brain design show "<id or vibe>"          its description, then the image path

claude-brain reorganize [--scope <folder>] [--dry-prompt] [--yes]
                                   plan a folder structure; moves nothing
claude-brain reorganize --apply [--plan <run-id>] [--yes]
claude-brain reorganize --undo [<run-id>]

claude-brain vault <path>          choose where your brain lives
claude-brain sync setup <provider> connect dropbox | gdrive | mega
claude-brain sync now              sync to the cloud now
claude-brain integrate [--remove]  wire into / out of Claude Code
claude-brain consolidate [days]    mine session logs, abstract, forget
claude-brain status                index + sync + integration state
claude-brain serve                 run the server in the foreground
```

The graph verbs resolve their arguments through recall, so you can describe a note
instead of naming it exactly: `claude-brain path "the audio crash" "deploy notes"`.

To keep the brain always on (recommended — recall stays warm for Claude Code):

```bash
systemctl --user enable --now claude-brain
```

## How it stores things

| What | Where |
|---|---|
| Config (vault path, sync, port) | `~/.config/claude-brain/config.json` |
| Search index | `~/.local/share/claude-brain/index.sqlite` |
| Embedding model (~90 MB, downloaded once) | `~/.cache/claude-brain/models/` |
| Sync log | `~/.local/state/claude-brain/sync.log` |

Your notes stay wherever you put your vault. Uninstalling the package touches none
of the above.

## Using your own Claude

Two features need judgement rather than search — describing a design, and deciding which
folder a note belongs in. Both call **your own already-authenticated `claude` CLI**; there
is no API key to configure and nothing is sent anywhere else.

Both are **off by default**. Nothing spends your Claude quota until you turn them on in
Settings, and there is a daily budget you can set. With them off, uploads are still stored
and listed (marked "disabled"), and everything else in the brain — recall, the graph,
episodic memory — is unaffected, because none of it uses an LLM at all.

## Privacy

- No telemetry. Embeddings, search, clustering and graph building are fully local and
  involve no model at all.
- The only thing that ever leaves your machine is what you explicitly enable above, and
  it goes through your own `claude` CLI to Anthropic — the same place your Claude Code
  sessions already go. Off by default. `claude-brain reorganize --dry-prompt` prints the
  exact text that would be sent, without sending it.
- Episodic memory is read from Claude Code's session logs already on your disk and
  stored only in the local index. It is never written into your vault and never synced.
- Cloud sync is off until you connect an account; it targets only your own storage and
  mirrors your vault, not the index.
- `claude-brain integrate --remove` cleanly removes everything it added to `~/.claude`.

## License

MIT
