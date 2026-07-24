# claude-brain

A local **second brain** for [Claude Code](https://claude.com/claude-code): your markdown
notes become persistent, searchable memory that Claude recalls before working and
records back into at the end of every session.

Everything runs on your machine. Your notes never leave your disk unless you connect
your own cloud account.

## Features

- **Hybrid recall** — BM25 full-text (SQLite FTS5) + local semantic embeddings
  (all-MiniLM-L6-v2 via ONNX, 384-dim, sqlite-vec) fused with reciprocal-rank fusion,
  wikilink-graph ranking boosts, best-section-per-note pooling. ~100 ms queries,
  finds notes by meaning ("laptop battery drains fast" → your power-tuning note).
- **3D knowledge graph** — every note a neuron, wikilinks as synapses, folders as
  lobes, with search, category filters, and an in-graph note reader.
- **Always fresh** — a file watcher reindexes seconds after you edit a note.
  Content-hash incremental: only changed notes are re-chunked and re-embedded.
- **You choose where the brain lives** — point it at an existing Obsidian vault or
  any folder of markdown. Switch anytime in Settings.
- **Cloud sync** — one-way mirror to your own **Dropbox**, **Google Drive**, or
  **MEGA** (via rclone; credentials stay in rclone on your machine). Dated remote
  trash folder protects against accidental deletions.
- **Claude Code integration** — one click wires it in: recall-first instructions,
  a SessionStart hook injecting brain status, and a recording skill so sessions
  save what they learned (work log, solved bugs, quick captures) as new notes.

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
claude-brain recall "<query>" [k] [-p <folder>]  hybrid search (folder-scoped with -p)
claude-brain note "<text>" [-f <subfolder>]      quick-capture (default Inbox/)
claude-brain vault <path>          choose where your brain lives
claude-brain sync setup <provider> connect dropbox | gdrive | mega
claude-brain sync now              sync to the cloud now
claude-brain integrate [--remove]  wire into / out of Claude Code
claude-brain status                index + sync + integration state
claude-brain serve                 run the server in the foreground
```

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

## Privacy

- No telemetry, no external calls. Embeddings and search are fully local.
- Cloud sync is off until you connect an account; it targets only your own storage.
- `claude-brain integrate --remove` cleanly removes everything it added to `~/.claude`.

## License

MIT
