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
      confirmEmpty: boolean
    }
  }
}
