import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionInfo, SessionSummary } from '../types'

const PANE = 'session-manager'
const TITLE = 'Sessions'

const sessions = atom({ plugin: 'session-manager', key: 'sessions' } as const, [])
const selected = atom({ plugin: 'session-manager', key: 'selected' } as const, null)
const confirmDelete = atom({ plugin: 'session-manager', key: 'confirmDelete' } as const, null)
const busy = atom({ plugin: 'session-manager', key: 'busy' } as const, null)
const message = atom({ plugin: 'session-manager', key: 'message' } as const, null)
const summaries = atom({ plugin: 'session-manager', key: 'summaries' } as const, {})
const marked = atom({ plugin: 'session-manager', key: 'marked' } as const, [])
const confirmCopies = atom({ plugin: 'session-manager', key: 'confirmCopies' } as const, false)

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

const JOIN_PROMPT = (parts: string[]) =>
  'Below are several separate Claude Code conversations that are being joined so the work can ' +
  'continue as one. Write one detailed summary covering all of them, with these sections:\n' +
  '1. Primary Requests and Intent (per conversation)\n2. Key Technical Concepts\n' +
  '3. Files and Code Sections\n4. Errors and Fixes\n5. Decisions and Problem Solving\n' +
  '6. Pending Tasks\n7. Where Each Conversation Was Left\n8. Optional Next Step\n\n' +
  'Name each conversation by its title where it matters. Reply with the summary only.\n\n' +
  parts.join('\n\n')

const JOIN_LIMIT = 600000

const helper = async ($: EngineInterface, args: string[], stdin?: string) => {
  const script = `${$.plugin.root}/scripts/sm.cjs`
  const ran = await $.process.run(['node', script, ...args], { stdin, timeoutMs: 120000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `helper exited ${ran.exitCode}`)
  return ran.stdout
}

// One name for the session in /resume and in the agents view. A resume keeps
// the agent name the window had, so this renames the agent to the session's.
const syncName = async ($: EngineInterface) => {
  const id = await $.session.id()
  const names = JSON.parse(await helper($, ['sync-name', id])) as { title: string; agentName: string }
  if (names.title !== '' && names.title !== names.agentName) {
    await $.command.run({ command: 'rename', args: names.title })
  }
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const refresh = async ($: EngineInterface) => {
  const currentId = await $.session.id()
  const root = await $.session.root()
  const list = JSON.parse(await helper($, ['list', currentId, root])) as SessionInfo[]
  await update($, sessions, () => list)
}

// Empty sessions (only a title or commands, left by restarts and /clear) are
// deleted whenever the pane loads; the current one and any open one are kept.
const deleteEmpty = async ($: EngineInterface) => {
  const currentId = await $.session.id()
  const list = await read($, sessions)
  const empties = list.filter(session => session.isEmpty && session.id !== currentId && session.live === undefined)
  for (const session of empties) {
    await helper($, ['delete', session.file])
    await $.store.delete(`summary:${session.id}`)
  }
  if (empties.length > 0) await refresh($)
  return empties.length
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
      description: 'Browse saved sessions: resume, recap, rename, compact, join or delete them',
    })

    const started = await next(e)
    await syncName($).catch(() => undefined)
    // Open beside the chat from the start; unfocused, so typing stays in the prompt.
    if (e.isInteractive) {
      const opened = await $.ui
        .open({ id: PANE, title: TITLE, closeOnEscape: true })
        .catch(() => undefined)
      if (opened?.isPlaced) {
        await refresh($)
          .then(() => deleteEmpty($))
          .catch(() => undefined)
      }
    }
    return started
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const opened = await $.ui.open({
      id: PANE,
      title: TITLE,
      focus: true,
      closeOnEscape: true,
    })
    if (!opened.isPlaced) return { text: `Sessions pane not shown: ${opened.reason}` }
    await run($, 'Loading sessions…', async () => {
      await refresh($)
      const removed = await deleteEmpty($)
      return removed > 0 ? `Deleted ${removed} empty sessions.` : ''
    })

    // The pane is the output; no transcript line.
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, sessions)
    const pickedId = await read($, selected)
    const deleting = await read($, confirmDelete)
    const working = await read($, busy)
    const note = await read($, message)
    const recaps = await read($, summaries)
    const currentId = await $.session.id()
    const now = await $.clock.now()
    const width = Math.max(24, (e.props.bodyColumns ?? 80) - 6)
    const isFullscreen = e.viewport?.isFullscreen === true
    const picked = list.find(session => session.id === pickedId)
    const recap = picked === undefined ? undefined : recaps[picked.id]
    const original = list.find(session => session.id === picked?.copyOf)
    const recapLines = recap === undefined ? 0 : recap.text.split('\n').length
    const markedIds = await read($, marked)
    const marks = list.filter(session => markedIds.includes(session.id))
    const joinLines = marks.length > 0 ? 3 : 0
    const room = Math.max(
      3,
      e.props.scroll.bodyRows - (picked ? 18 + recapLines : 9) - joinLines,
    )
    // Empty sessions stay out of the list, as in /resume; loading the pane deletes them.
    const shown = list.filter(session => !session.isEmpty || session.id === currentId || session.id === pickedId)
    const rows = Math.max(1, Math.floor(room / 2))
    // Another process holds it: resuming forks a copy and edits race its writes.
    const pickedIsOpen = picked !== undefined && picked.id !== currentId && picked.live !== undefined
    const intoTarget =
      picked !== undefined && picked.id !== currentId && !pickedIsOpen && !markedIds.includes(picked.id)
        ? picked
        : undefined

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
        // A running session holds its agent name in memory; /rename updates it.
        if (session.id === (await $.session.id())) {
          await $.command.run({ command: 'rename', args: value.trim() })
        }
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

    const resumeNow = (session: SessionInfo) => async () => {
      try {
        await $.ui.close({ id: PANE })
        await $.command.run({ command: 'resume', args: session.id })
        // A resume fires no session.start and keeps the window's agent name,
        // so once the switch lands, name the agent after the session.
        for (let tries = 0; tries < 20; tries++) {
          if ((await $.session.id()) === session.id) {
            if (session.title !== '') await $.command.run({ command: 'rename', args: session.title })
            break
          }
          await $.clock.sleep(250)
        }
      } catch (error) {
        await update($, message, () => `Failed: ${describeError(error)}`)
      }
    }

    // A background agent under the same id: it shows in the agents view and
    // leaves this window's session alone.
    const openAsAgent = (session: SessionInfo) => () =>
      run($, `Opening ${nameOf(session)} as an agent…`, async () => {
        const ran = await $.process.run(
          ['claude', '--bg', '--resume', session.id, '--name', nameOf(session)],
          { cwd: await $.session.root(), timeoutMs: 60000 },
        )
        if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `claude exited ${ran.exitCode}`)
        await refresh($)
        return `Opened "${nameOf(session)}" as a background agent: find it in the agents view.`
      })

    // Resuming here drops this window's conversation, so it is offered only
    // while that is empty (a new session not yet written counts too).
    // Inside the agents view this pane runs in a background agent; the terminal
    // under it is an interactive process holding the session it started with.
    const inAgentView = list.find(session => session.id === currentId)?.live?.kind === 'bg'
    const isHost = (session: SessionInfo) => inAgentView && session.live?.kind === 'interactive'

    const hereIsEmpty = list.find(session => session.id === currentId)?.isEmpty ?? true

    const toggleMark = (session: SessionInfo) => () =>
      update($, marked, current =>
        current.includes(session.id)
          ? current.filter(id => id !== session.id)
          : [...current, session.id],
      )

    const clearMarks = () => update($, marked, () => [])

    const joinedSummary = async (sources: SessionInfo[]) => {
      const share = Math.floor(JOIN_LIMIT / sources.length)
      const parts: string[] = []
      for (const source of sources) {
        const transcript = await helper($, ['transcript', source.file])
        if (!transcript.trim()) continue
        parts.push(
          `<conversation title="${nameOf(source).replace(/"/g, "'")}">\n` +
            transcript.slice(-share) +
            '\n</conversation>',
        )
      }
      if (parts.length === 0) throw new Error('the marked sessions have no messages')
      const reply = await $.model.complete({
        model: 'sonnet',
        system: COMPACT_SYSTEM,
        prompt: JOIN_PROMPT(parts),
        maxTokens: 8000,
        timeoutMs: 300000,
      })
      if (!reply.isAnswered) throw new Error(`no summary (${reply.reason})`)
      return reply.text
    }

    const joinAsNew = (sources: SessionInfo[]) => () =>
      run($, `Joining ${sources.length} sessions into a new one…`, async () => {
        const summary = await joinedSummary(sources)
        const anchor = list.find(session => session.id === currentId) ?? sources[0]!
        const title = fit(`Joined: ${sources.map(nameOf).join(' + ')}`, 100)
        const files = [anchor, ...sources].map(session => session.file)
        const made = JSON.parse(await helper($, ['join-new', title, ...files], summary)) as {
          id: string
        }
        await update($, marked, () => [])
        await update($, selected, () => made.id)
        await refresh($)
        return `Created "${title}". Press Resume to open it.`
      })

    const joinInto = (target: SessionInfo, sources: SessionInfo[]) => () =>
      run($, `Joining ${sources.length} sessions into ${nameOf(target)}…`, async () => {
        const summary = await joinedSummary(sources)
        await helper($, ['join-into', target.file], summary)
        await $.store.delete(`summary:${target.id}`)
        await update($, marked, () => [])
        await refresh($)
        return `Joined into ${nameOf(target)} (backup saved as .jsonl.bak).`
      })

    const deleteAll = async (doomed: SessionInfo[]) => {
      for (const session of doomed) {
        await helper($, ['delete', session.file])
        await $.store.delete(`summary:${session.id}`)
      }
      const gone = doomed.map(session => session.id)
      await update($, marked, current => current.filter(id => !gone.includes(id)))
      await update($, selected, current => (current !== null && gone.includes(current) ? null : current))
      await refresh($)
    }

    // Copies made by resuming a session while it was open elsewhere.
    const copies = list.filter(
      session => session.copyOf !== undefined && session.id !== currentId && session.live === undefined,
    )
    const withWork = copies.filter(session => (session.newMessages ?? 0) > 0).length
    const clearingCopies = await read($, confirmCopies)

    const askDeleteCopies = () => update($, confirmCopies, () => true)

    const cancelDeleteCopies = () => update($, confirmCopies, () => false)

    const deleteCopiesNow = () =>
      run($, `Deleting ${copies.length} copies…`, async () => {
        await update($, confirmCopies, () => false)
        await deleteAll(copies)
        return `Deleted ${copies.length} copies.`
      })

    const totalBytes = list.reduce((sum, session) => sum + session.size, 0)

    // The footer names only the keys that do something right now.
    const canAct = picked !== undefined && picked.id !== currentId && !pickedIsOpen
    const keys = [
      'r refresh',
      ...(picked === undefined
        ? []
        : [
            ...(canAct ? ['o open as agent'] : []),
            ...(canAct && hereIsEmpty ? ['h resume here'] : []),
            's recap',
            'm mark',
            ...(canAct ? ['c compact', 'd delete'] : []),
          ]),
      ...(marks.length >= 2 ? ['n join new'] : []),
      ...(marks.length > 0 && intoTarget !== undefined ? ['i join into'] : []),
      ...(marks.length > 0 ? ['x clear marks'] : []),
      ...(copies.length > 0 ? ['p delete copies'] : []),
      'esc close',
    ]

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text bold color="cyan">
              ◆ This project
            </Text>
            <Text dimColor>
              {list.length} sessions · {formatSize(totalBytes)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="refresh" hotkey="r" onPress={reload}>
              Refresh
            </Button>
          </Box>
        </Box>
        {copies.length > 0 && working === null && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {clearingCopies ? (
                <>
                  <Text color="red" bold>
                    Delete {copies.length} copies permanently?
                  </Text>
                  <Button key="copies-yes" onPress={deleteCopiesNow}>
                    Yes, delete
                  </Button>
                  <Button key="copies-no" onPress={cancelDeleteCopies}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Text dimColor>{copies.length} copies (from resuming open sessions)</Text>
                  <Button key="copies" hotkey="p" onPress={askDeleteCopies}>
                    Delete copies
                  </Button>
                </>
              )}
            </Box>
            {clearingCopies && withWork > 0 && (
              <Text color="yellow">
                {withWork} of them have messages their original lacks: that work goes too.
              </Text>
            )}
          </Box>
        )}
        {working !== null && <Text color="yellow">⟳ {working}</Text>}
        {working === null && note !== null && note !== '' && (
          <Text color={note.startsWith('Failed') ? 'red' : 'green'}>
            {note.startsWith('Failed') ? '✗ ' : '✓ '}
            {note}
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          {shown.length === 0 && working === null && <Text dimColor>No sessions found.</Text>}
          {shown.slice(0, rows).map(session => {
            const isCurrent = session.id === currentId
            const isPicked = session.id === pickedId
            const isMarked = markedIds.includes(session.id)
            const label = fit(nameOf(session), Math.max(10, width - 4))

            // Two lines like /resume: the name, then age · branch · size.
            return (
              <Box key={`row-${session.id}`} flexDirection="column">
                <Button key={`row-${session.id}`} plain onPress={pick(session)}>
                  <Text color={isPicked ? 'magenta' : isCurrent ? 'green' : 'cyan'}>
                    {isPicked ? '▸ ' : isCurrent ? '● ' : '  '}
                  </Text>
                  <Text color="yellow">{isMarked ? '✓ ' : ''}</Text>
                  <Text bold={isPicked} color={isPicked ? 'magenta' : undefined}>
                    {label}
                  </Text>
                </Button>
                <Button key={`meta-${session.id}`} plain onPress={pick(session)}>
                  <Text dimColor>
                    {'  '}
                    {formatAge(now - session.mtimeMs)}
                    {session.branch === '' ? '' : ` · ${session.branch}`} ·{' '}
                  </Text>
                  <Text color={sizeColor(session.size)} dimColor={sizeColor(session.size) === undefined}>
                    {formatSize(session.size)}
                  </Text>
                  {isCurrent && <Text color="green"> · current</Text>}
                  {!isCurrent && session.live !== undefined && (
                    <Text color="yellow">{isHost(session) ? ' · this window' : ' · open'}</Text>
                  )}
                  {session.copyOf !== undefined && <Text dimColor> · copy</Text>}
                  {session.isCompacted && <Text color="blue"> · ⇣ compacted</Text>}
                </Button>
              </Box>
            )
          })}
          {shown.length > rows && <Text dimColor>  …and {shown.length - rows} more</Text>}
        </Box>
        {marks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">
              ✓ {marks.length} marked: {fit(marks.map(nameOf).join(', '), width - 14)}
            </Text>
            <Box flexDirection="row" gap={1}>
              {marks.length >= 2 && (
                <Button key="join-new" hotkey="n" variant="primary" onPress={joinAsNew(marks)}>
                  Join as new session
                </Button>
              )}
              {intoTarget !== undefined && (
                <Button key="join-into" hotkey="i" onPress={joinInto(intoTarget, marks)}>
                  {fit(`Join into ${nameOf(intoTarget)}`, 40)}
                </Button>
              )}
              <Button key="join-clear" hotkey="x" onPress={clearMarks}>
                Clear marks
              </Button>
            </Box>
          </Box>
        )}
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
              {picked.isCompacted ? (
                <Text color="blue"> · ⇣ compacted: nothing added since</Text>
              ) : (
                picked.compactions > 0 && <Text dimColor> · compacted before, more added since</Text>
              )}
            </Text>
            {picked.preview !== '' && (
              <Text italic dimColor>
                {fit(`“${picked.preview}”`, width - 4)}
              </Text>
            )}
            {pickedIsOpen && picked.live !== undefined && (
              <Text color="yellow">
                {picked.live.kind === 'bg'
                  ? `Running as a background agent (${picked.live.status || 'idle'}). Open it from the agents list.`
                  : isHost(picked)
                    ? `The session this terminal started with (process ${picked.live.pid}). It stays held under the agents view and frees when you close the terminal.`
                    : `Open in a Claude Code window${picked.live.name === '' ? '' : ` named "${picked.live.name}"`} (process ${picked.live.pid}).`}{' '}
                Resuming it here would fork a copy, so Resume, Compact and Delete are off. To delete it, exit that window (/exit), then press r and d.
              </Text>
            )}
            {picked.copyOf !== undefined && (
              <Text dimColor>
                {fit(
                  `Copy of ${original === undefined ? picked.copyOf.slice(0, 8) : nameOf(original)}, made by resuming it while it was open.`,
                  (width - 4) * 2,
                )}
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
              {picked.id !== currentId && !pickedIsOpen && (
                <Button key="open-agent" hotkey="o" variant="primary" onPress={openAsAgent(picked)}>
                  Open as agent
                </Button>
              )}
              {picked.id !== currentId && !pickedIsOpen && hereIsEmpty && (
                <Button key="resume" hotkey="h" onPress={resumeNow(picked)}>
                  Resume here
                </Button>
              )}
              <Button key="recap" hotkey="s" onPress={summarize(picked)}>
                {recap !== undefined ? 'Redo recap' : 'Recap'}
              </Button>
              <Button key="mark" hotkey="m" onPress={toggleMark(picked)}>
                {markedIds.includes(picked.id) ? 'Unmark' : 'Mark to join'}
              </Button>
              {picked.id === currentId ? (
                <Text dimColor>Current session: use /compact or /rename here.</Text>
              ) : pickedIsOpen ? null : deleting === picked.id ? (
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
        {!isFullscreen && (
          <Text color="yellow" bold>
            Not in fullscreen mode: the side pane and mouse clicks need it. Run /tui fullscreen.
          </Text>
        )}
        {isFullscreen && !e.props.isFocused && (
          <Text color="yellow">Click here (or ctrl+x then tab) to use this pane's keys.</Text>
        )}
        <Text dimColor>
          {keys.join(' · ')}
        </Text>
      </Box>
    )
  })
}
