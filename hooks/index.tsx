import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scope, SessionInfo, SessionSummary } from '../types'

const PANE = 'session-manager'
const TITLE = 'Sessions'

const sessions = atom({ plugin: 'session-manager', key: 'sessions' } as const, [])
const scope = atom({ plugin: 'session-manager', key: 'scope' } as const, 'project')
const selected = atom({ plugin: 'session-manager', key: 'selected' } as const, null)
const confirmDelete = atom({ plugin: 'session-manager', key: 'confirmDelete' } as const, null)
const busy = atom({ plugin: 'session-manager', key: 'busy' } as const, null)
const message = atom({ plugin: 'session-manager', key: 'message' } as const, null)
const summaries = atom({ plugin: 'session-manager', key: 'summaries' } as const, {})

const COMPACT_SYSTEM =
  'You summarize a coding conversation between a user and Claude Code so the work can continue ' +
  'in a fresh context. Be precise and complete; keep file paths, commands, code identifiers, ' +
  'errors and decisions exactly as written.'

const COMPACT_PROMPT = (transcript: string) =>
  'Write a detailed summary of the conversation below with these sections:\n' +
  '1. Primary Request and Intent\n2. Key Technical Concepts\n3. Files and Code Sections\n' +
  '4. Errors and Fixes\n5. Problem Solving\n6. All User Messages (brief, in order)\n' +
  '7. Pending Tasks\n8. Current Work\n9. Optional Next Step\n\n' +
  'Reply with the summary only.\n\n<conversation>\n' +
  transcript +
  '\n</conversation>'

const BRIEF_SYSTEM =
  'You write short recaps of Claude Code sessions so a person can recognise one at a glance. ' +
  'Write in the language the user mostly wrote in.'

const BRIEF_PROMPT = (transcript: string) =>
  'Recap the conversation below in 3 to 5 short bullet lines starting with "- ": what the user ' +
  'wanted, what got done, and where it was left. Plain text, no headings, under 70 words.\n\n' +
  '<conversation>\n' +
  transcript +
  '\n</conversation>'

const BRIEF_LIMIT = 200000

const helper = async ($: EngineInterface, args: string[], stdin?: string) => {
  const script = `${$.plugin.root}/scripts/sm.cjs`
  const ran = await $.process.run(['node', script, ...args], { stdin, timeoutMs: 120000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `helper exited ${ran.exitCode}`)
  return ran.stdout
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const refresh = async ($: EngineInterface) => {
  const currentId = await $.session.id()
  const where: Scope = await read($, scope)
  const list = JSON.parse(await helper($, ['list', currentId, where])) as SessionInfo[]
  await update($, sessions, () => list)
}

const run = async ($: EngineInterface, label: string, work: () => Promise<string>) => {
  await update($, busy, () => label)
  await update($, message, () => null)
  try {
    const done = await work()
    await update($, message, () => done)
  } catch (error) {
    await update($, message, () => `Failed: ${describeError(error)}`)
  }
  await update($, busy, () => null)
}

const loadSummary = async ($: EngineInterface, session: SessionInfo) => {
  const kept = (await $.store.get(`summary:${session.id}`)) as SessionSummary | undefined
  if (kept === undefined || kept.mtimeMs !== session.mtimeMs) return
  await update($, summaries, all => ({ ...all, [session.id]: kept }))
}

const formatSize = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

const sizeColor = (bytes: number) =>
  bytes >= 5242880 ? 'red' : bytes >= 2097152 ? 'yellow' : undefined

const formatAge = (ms: number) => {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

const nameOf = (session: SessionInfo) =>
  session.title || session.preview || session.id.slice(0, 8)

const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Browse saved sessions: recap, rename, compact or delete them',
    })

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    await run($, 'Loading sessions…', async () => {
      await refresh($)
      return ''
    })

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, sessions)
    const where = await read($, scope)
    const pickedId = await read($, selected)
    const deleting = await read($, confirmDelete)
    const working = await read($, busy)
    const note = await read($, message)
    const recaps = await read($, summaries)
    const currentId = await $.session.id()
    const now = await $.clock.now()
    const width = Math.max(24, (e.props.bodyColumns ?? 80) - 6)
    const picked = list.find(session => session.id === pickedId)
    const recap = picked === undefined ? undefined : recaps[picked.id]
    const recapLines = recap === undefined ? 0 : recap.text.split('\n').length
    const room = Math.max(3, (e.viewport?.rows ?? 24) - (picked ? 18 + recapLines : 9))

    const pick = (session: SessionInfo) => async () => {
      await update($, selected, current => (current === session.id ? null : session.id))
      await update($, confirmDelete, () => null)
      await loadSummary($, session)
    }

    const reload = () =>
      run($, 'Loading sessions…', async () => {
        await refresh($)
        return ''
      })

    const switchScope = async () => {
      await update($, scope, current => (current === 'project' ? 'all' : 'project'))
      await reload()
    }

    const summarize = (session: SessionInfo) => () =>
      run($, `Writing a recap of ${nameOf(session)}…`, async () => {
        const transcript = await helper($, ['transcript', session.file])
        if (!transcript.trim()) return 'Nothing to recap yet.'
        const reply = await $.model.complete({
          model: 'haiku',
          system: BRIEF_SYSTEM,
          prompt: BRIEF_PROMPT(transcript.slice(-BRIEF_LIMIT)),
          maxTokens: 400,
          timeoutMs: 120000,
        })
        if (!reply.isAnswered) throw new Error(`no recap (${reply.reason})`)
        const kept: SessionSummary = { text: reply.text.trim(), mtimeMs: session.mtimeMs }
        await $.store.set(`summary:${session.id}`, kept)
        await update($, summaries, all => ({ ...all, [session.id]: kept }))
        return ''
      })

    const renameTo = (session: SessionInfo) => (value: string) =>
      run($, 'Renaming…', async () => {
        await helper($, ['rename', session.file, value])
        await refresh($)
        return `Renamed to "${value.trim()}".`
      })

    const compactNow = (session: SessionInfo) => () =>
      run($, `Compacting ${nameOf(session)}…`, async () => {
        const transcript = await helper($, ['transcript', session.file])
        if (!transcript.trim()) return 'Nothing to compact.'
        const reply = await $.model.complete({
          model: 'sonnet',
          system: COMPACT_SYSTEM,
          prompt: COMPACT_PROMPT(transcript),
          maxTokens: 8000,
          timeoutMs: 300000,
        })
        if (!reply.isAnswered) throw new Error(`no summary (${reply.reason})`)
        await helper($, ['compact', session.file], reply.text)
        await refresh($)
        return 'Compacted. Resuming it now starts from the summary (backup saved as .jsonl.bak).'
      })

    const askDelete = (session: SessionInfo) => () =>
      update($, confirmDelete, () => session.id)

    const deleteNow = (session: SessionInfo) => () =>
      run($, 'Deleting…', async () => {
        await helper($, ['delete', session.file])
        await $.store.delete(`summary:${session.id}`)
        await update($, selected, () => null)
        await update($, confirmDelete, () => null)
        await refresh($)
        return `Deleted ${nameOf(session)}.`
      })

    const cancelDelete = () => update($, confirmDelete, () => null)

    const totalBytes = list.reduce((sum, session) => sum + session.size, 0)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text bold color="cyan">
              ◆ {where === 'project' ? 'This project' : 'All projects'}
            </Text>
            <Text dimColor>
              {list.length} sessions · {formatSize(totalBytes)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="scope" hotkey="a" onPress={switchScope}>
              {where === 'project' ? 'All projects' : 'This project'}
            </Button>
            <Button key="refresh" hotkey="r" onPress={reload}>
              Refresh
            </Button>
          </Box>
        </Box>
        {working !== null && <Text color="yellow">⟳ {working}</Text>}
        {working === null && note !== null && note !== '' && (
          <Text color={note.startsWith('Failed') ? 'red' : 'green'}>
            {note.startsWith('Failed') ? '✗ ' : '✓ '}
            {note}
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          {list.length === 0 && working === null && <Text dimColor>No sessions found.</Text>}
          {list.slice(0, room).map(session => {
            const isCurrent = session.id === currentId
            const isPicked = session.id === pickedId
            const age = formatAge(now - session.mtimeMs)
            const size = formatSize(session.size)
            const tail = isCurrent ? ' · current' : ''
            const label = fit(nameOf(session), Math.max(10, width - size.length - age.length - tail.length - 8))

            return (
              <Button key={`row-${session.id}`} plain onPress={pick(session)}>
                <Text color={isPicked ? 'magenta' : isCurrent ? 'green' : 'cyan'}>
                  {isPicked ? '▸ ' : isCurrent ? '● ' : '  '}
                </Text>
                <Text bold={isPicked} color={isPicked ? 'magenta' : undefined}>
                  {label}
                </Text>{' '}
                <Text color={sizeColor(session.size)} dimColor={sizeColor(session.size) === undefined}>
                  {size}
                </Text>
                <Text dimColor> · {age}</Text>
                {isCurrent && <Text color="green"> · current</Text>}
              </Button>
            )
          })}
          {list.length > room && <Text dimColor>  …and {list.length - room} more</Text>}
        </Box>
        {picked !== undefined && (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="round"
            borderColor="magenta"
            paddingX={1}
          >
            <Text bold color="magenta">
              {fit(nameOf(picked), width - 4)}
            </Text>
            <Text dimColor>
              {fit(`${picked.id} · ${picked.project}`, width - 4)}
            </Text>
            <Text>
              <Text color={sizeColor(picked.size)}>{formatSize(picked.size)}</Text>
              <Text dimColor> · last active {formatAge(now - picked.mtimeMs)}</Text>
            </Text>
            {picked.preview !== '' && (
              <Text italic dimColor>
                {fit(`“${picked.preview}”`, width - 4)}
              </Text>
            )}
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="yellow">
                Recap
              </Text>
              {recap !== undefined ? (
                <Text>{recap.text}</Text>
              ) : (
                <Text dimColor>No recap yet. Press Recap to write one (uses Haiku).</Text>
              )}
            </Box>
            {Input !== undefined && (
              <Box marginTop={1}>
                <Input
                  key={`rename-${picked.id}`}
                  label="Rename"
                  placeholder={picked.title || 'New title'}
                  submitLabel="Save"
                  onSubmit={renameTo(picked)}
                />
              </Box>
            )}
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Button key="recap" hotkey="s" variant="primary" onPress={summarize(picked)}>
                {recap !== undefined ? 'Redo recap' : 'Recap'}
              </Button>
              {picked.id === currentId ? (
                <Text dimColor>Current session: use /compact or /rename here.</Text>
              ) : deleting === picked.id ? (
                <>
                  <Text color="red" bold>
                    Delete permanently?
                  </Text>
                  <Button key="delete-yes" onPress={deleteNow(picked)}>
                    Yes, delete
                  </Button>
                  <Button key="delete-no" onPress={cancelDelete}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button key="compact" hotkey="c" onPress={compactNow(picked)}>
                    Compact
                  </Button>
                  <Button key="delete" hotkey="d" onPress={askDelete(picked)}>
                    Delete
                  </Button>
                </>
              )}
            </Box>
          </Box>
        )}
        <Text dimColor>
          a scope · r refresh · s recap · c compact · d delete · esc close
        </Text>
      </Box>
    )
  })
}
