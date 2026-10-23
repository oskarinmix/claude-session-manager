export type SessionInfo = {
  id: string
  project: string
  file: string
  size: number
  mtimeMs: number
  title: string
  isCustomTitle: boolean
  preview: string
  isEmpty: boolean
  /** Git branch of the last message, as /resume shows it. */
  branch: string
  /** How many times it was compacted (/compact, auto-compact or the pane's Compact). */
  compactions: number
  /** Compacted, with no reply after the last compaction. */
  isCompacted: boolean
  /** The last custom-title row (the /resume name) and agent-name row (the agents view). */
  sessionTitle: string
  agentName: string
  /** Set while a Claude Code process holds the session (from ~/.claude/sessions). */
  live?: { pid: number; kind: 'bg' | 'interactive'; status: string; name: string }
  /** The session this one was forked from by resuming it while it was open. */
  copyOf?: string
  /** Messages in a copy that its original does not hold: work done after the fork. */
  newMessages?: number
}

export type SessionSummary = { text: string; mtimeMs: number }

declare module 'claude-code' {
  interface PluginState {
    'session-manager': {
      sessions: SessionInfo[]
      selected: string | null
      confirmDelete: string | null
      busy: string | null
      message: string | null
      summaries: Record<string, SessionSummary>
      marked: string[]
      confirmCopies: boolean
      forking: string | null
    }
  }
}
