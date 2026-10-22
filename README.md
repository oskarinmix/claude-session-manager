<div align="center">

<img src="docs/banner.svg" alt="Claude Session Manager" width="100%">

<p>
  <img alt="Version 0.2.0" src="https://img.shields.io/badge/version-0.2.0-d97757?style=flat-square">
  <img alt="Claude Code mod" src="https://img.shields.io/badge/Claude%20Code-mod-1b1f27?style=flat-square">
  <img alt="Requires Node.js" src="https://img.shields.io/badge/requires-Node.js-3c873a?style=flat-square&logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<p>
  <a href="#install">Install</a> ·
  <a href="#use">Use</a> ·
  <a href="#join-sessions">Join sessions</a> ·
  <a href="#how-it-works">How it works</a>
</p>

</div>

A Claude Code mod that adds a **Sessions** pane for browsing your saved sessions (the `.jsonl` transcripts under `~/.claude/projects`). From the pane you can resume any session, read a short recap of it, rename it, compact it like `/compact`, join several into one, or delete it.

<p align="center">
  <img src="docs/pane.svg" alt="The Sessions pane open beside a conversation: a list of sessions with sizes and ages, two marked for joining, and the selected session's recap and actions" width="100%">
</p>

## Features

|  |  |
| --- | --- |
| ▶️ **Resume** | Jump into any session of the current project, same as `/resume`. |
| 📝 **Recap** | A 3–5 line summary written by Haiku, cached until the session changes. |
| ✏️ **Rename** | Give a session a title that also shows up in `/resume`. |
| 🗜️ **Compact** | Shrink a heavy session like `/compact`, without opening it. |
| 🔗 **Join** | Merge several sessions into a new one, or into an existing one. |
| 🧹 **Clean up** | Delete one session, or every empty one left behind by restarts and `/clear`. |

Sizes are color-coded so heavy sessions stand out: **yellow** from 2 MB, **red** from 5 MB.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-manager --marketplace oskarinmix/claude-session-manager
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

<details>
<summary><b>From a shell</b></summary>

```
claude plugin install session-manager --marketplace oskarinmix/claude-session-manager
```

</details>

<details>
<summary><b>In the desktop app</b></summary>

`/plugin` doesn't run there. Click **+** next to the prompt box → **Plugins** → **Add marketplace** with `oskarinmix/claude-session-manager` → **Add plugin**.

</details>

<details>
<summary><b>From a local folder</b></summary>

Clone the repo, then either start a session with `claude --plugin-dir /path/to/claude-session-manager`, or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-session-manager" } }
```

</details>

### Requirements

- Claude Code with mod (function hooks) support. The side pane and mouse clicks need fullscreen mode (`/tui fullscreen`).
- **Node.js** on your `PATH`: the mod's file work runs in `scripts/sm.cjs`.

## Use

Type **`/sessions`** to open the pane. Click a row (or press Enter on it) to select a session.

#### Browse

| Key | Action |
| :---: | --- |
| <kbd>r</kbd> | Refresh the list |
| <kbd>o</kbd> | **Resume**: closes the pane and opens the session, same as `/resume` |
| <kbd>s</kbd> | **Recap**: 3–5 line summary of the session, written by Haiku and cached until the session changes |
| <kbd>Esc</kbd> | Close the pane |

#### Edit

| Key | Action |
| :---: | --- |
| Rename box | Saves a custom title (same as `/rename`), shown in `/resume` |
| <kbd>c</kbd> | **Compact**: Sonnet writes a full summary and appends a compact boundary, so resuming starts from the summary. A `.jsonl.bak` backup is saved first |

#### Join

| Key | Action |
| :---: | --- |
| <kbd>m</kbd> | **Mark to join**: ticks the selected session (✓). Press again to unmark |
| <kbd>n</kbd> | **Join as new session** (2+ marked): Sonnet writes one summary of all marked sessions and a new session is created from it, titled `Joined: …`. The originals stay untouched |
| <kbd>i</kbd> | **Join into** the selected session (select one that isn't marked): the summary of the marked sessions is appended to it as a message, keeping its own history. A `.jsonl.bak` backup is saved first |
| <kbd>x</kbd> | Clear marks |

#### Delete

| Key | Action |
| :---: | --- |
| <kbd>d</kbd> | **Delete**: asks to confirm, then removes the transcript, its backup and its sidecar folder |
| <kbd>e</kbd> | **Delete empty**: shown when the project has sessions with no conversation (only a title, `/clear` or commands, left behind by restarts and `/clear`). Asks to confirm, then deletes them all. The current session is never included |

> [!WARNING]
> Deleting cannot be undone.

> [!NOTE]
> The current session is shown in green. Resume, Compact, Delete and Join into are disabled for it: use `/compact` and `/rename` there.

## Join sessions

<p align="center">
  <img src="docs/join.svg" alt="Marked sessions are summarized by Sonnet into one summary, which either becomes a new session (n) or is appended to the selected session (i)" width="100%">
</p>

Joined sessions carry a **summary** of each source, not its full message history.

> [!IMPORTANT]
> Recap, Compact and Join make model calls through your Claude Code login, so they count toward your usage.

## How it works

```
claude-session-manager/
├── hooks/index.tsx   the pane, the /sessions command and the model calls
└── scripts/sm.cjs    lists sessions, extracts transcripts, writes rename/compact/join rows,
                      creates joined sessions and deletes files
```

`scripts/sm.cjs` refuses any path outside `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).

## License

[MIT](LICENSE)
