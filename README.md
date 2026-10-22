# Claude Session Manager

A Claude Code mod that adds a **Sessions** pane for browsing your saved sessions (the `.jsonl` transcripts under `~/.claude/projects`). From the pane you can resume any session, read a short recap of it, rename it, compact it like `/compact`, join several into one, or delete it.

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
| `r` | Refresh the list |
| click / Enter on a row | Select a session |
| `o` | **Resume**: closes the pane and opens the session, same as `/resume` |
| `s` | **Recap**: 3–5 line summary of the session, written by Haiku and cached until the session changes |
| Rename box | Saves a custom title (same as `/rename`), shown in `/resume` |
| `c` | **Compact**: Sonnet writes a full summary and appends a compact boundary, so resuming starts from the summary. A `.jsonl.bak` backup is saved first |
| `m` | **Mark to join**: ticks the selected session (✓). Press again to unmark |
| `n` | **Join as new session** (2+ marked): Sonnet writes one summary of all marked sessions and a new session is created from it, titled `Joined: …`. The originals stay untouched |
| `i` | **Join into** the selected session (select one that isn't marked): the summary of the marked sessions is appended to it as a message, keeping its own history. A `.jsonl.bak` backup is saved first |
| `x` | Clear marks |
| `e` | **Delete empty**: shown when the project has sessions with no conversation (only a title, `/clear` or commands, left behind by restarts and `/clear`). Asks to confirm, then deletes them all. The current session is never included. Cannot be undone |
| `d` | **Delete**: asks to confirm, then removes the transcript, its backup and its sidecar folder. Cannot be undone |
| `Esc` | Close the pane |

The current session is shown in green; Resume, Compact, Delete and Join into are disabled for it (use `/compact` and `/rename` there).

Joined sessions carry a **summary** of each source, not its full message history.

Recap, Compact and Join make model calls through your Claude Code login, so they count toward your usage.

## How it works

- `hooks/index.tsx`: the pane, the `/sessions` command and the model calls.
- `scripts/sm.cjs`: lists sessions, extracts transcripts, and writes rename/compact/join rows, creates joined sessions or deletes files. It refuses any path outside `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).

## License

MIT
