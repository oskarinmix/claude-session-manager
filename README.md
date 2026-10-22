# Claude Session Manager

A Claude Code mod that adds a **Sessions** pane for browsing your saved sessions (the `.jsonl` transcripts under `~/.claude/projects`). From the pane you can read a short recap of any session, rename it, compact it like `/compact`, or delete it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-manager --marketplace <your-github-user>/claude-session-manager
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install session-manager --marketplace <your-github-user>/claude-session-manager
```

In the desktop app (where `/plugin` doesn't run): click **+** next to the prompt box → **Plugins** → **Add marketplace** with `<your-github-user>/claude-session-manager` → **Add plugin**.

### Requirements

- Claude Code with mod (function hooks) support.
- **Node.js** on your `PATH`: the mod's file work runs in `scripts/sm.cjs`.

### Run from a local folder instead

Clone the repo, then either start a session with `claude --plugin-dir /path/to/claude-session-manager`, or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-session-manager" } }
```

## Use

Type `/sessions` to open the pane.

| Key | Action |
| --- | --- |
| `a` | Switch between this project's sessions and all projects |
| `r` | Refresh the list |
| click / Enter on a row | Select a session |
| `s` | **Recap**: 3–5 line summary of the session, written by Haiku and cached until the session changes |
| Rename box | Saves a custom title (same as `/rename`), shown in `/resume` |
| `c` | **Compact**: Sonnet writes a full summary and appends a compact boundary, so resuming starts from the summary. A `.jsonl.bak` backup is saved first |
| `d` | **Delete**: asks to confirm, then removes the transcript, its backup and its sidecar folder. Cannot be undone |
| `Esc` | Close the pane |

The current session is shown in green; Compact and Delete are disabled for it (use `/compact` and `/rename` there).

Recap and Compact make model calls through your Claude Code login, so they count toward your usage.

## How it works

- `hooks/index.tsx`: the pane, the `/sessions` command and the model calls.
- `scripts/sm.cjs`: lists sessions, extracts transcripts, and writes rename/compact rows or deletes files. It refuses any path outside `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).

## License

MIT
