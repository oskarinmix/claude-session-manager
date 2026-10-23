// Session file helper for the session-manager mod. Runs under Node.
//   list <currentSessionId> <projectRoot>   JSON array of this project's sessions
//   transcript <file>                       conversation text since the last compact
//   compact <file>                          appends a compact boundary + summary (stdin)
//   rename <file> <title>                   appends custom-title and agent-name rows
//   sync-name <id>                          makes custom-title match a newer agent-name
//   join-new <title> <anchor> <sources...>  new session beside anchor, starting from summary (stdin)
//   join-into <file>                        appends merged context (stdin) to an existing session
//   delete <file>                           removes the file and its sidecar folder
//   handoff-file <name>                     saves a handoff (stdin) under the OS temp dir
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const projectsDir = path.join(configDir, 'projects')
const TRANSCRIPT_LIMIT = 600000

const clean = text => String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()

const parseLines = text =>
  text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)

const promptText = content => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}

const summarize = file => {
  const text = fs.readFileSync(file, 'utf8')
  let title = ''
  let isCustomTitle = false
  let sessionTitle = ''
  let agentName = ''
  const aiTitles = new Set()
  let aiTitle = ''
  let preview = ''
  let hasReply = false
  let compactions = 0
  let repliesSinceCompact = 0
  let branch = ''
  let firstUuid = ''
  const uuids = new Set()
  for (const line of text.split('\n')) {
    if (line.startsWith('{') && (line.includes('"type":"user"') || line.includes('"type":"assistant"'))) {
      // The row's own uuid follows its message, so the last match is the row's.
      const matches = [...line.matchAll(/"uuid":"([^"]+)"/g)]
      const uuid = matches.length > 0 ? matches[matches.length - 1][1] : ''
      if (uuid) {
        if (!firstUuid) firstUuid = uuid
        uuids.add(uuid)
      }
    }
    if (line.includes('"subtype":"compact_boundary"')) {
      compactions++
      repliesSinceCompact = 0
    } else if (line.startsWith('{') && line.includes('"type":"assistant"')) {
      repliesSinceCompact++
    }
    const branchAt = line.indexOf('"gitBranch":"')
    if (branchAt !== -1) branch = line.slice(branchAt + 13, line.indexOf('"', branchAt + 13))
    if (
      !hasReply &&
      line.startsWith('{') &&
      (line.includes('"type":"assistant"') || line.includes('"isCompactSummary":true'))
    ) {
      hasReply = true
    }
    if (line.includes('"custom-title"')) {
      try {
        title = JSON.parse(line).customTitle || title
        sessionTitle = title
        isCustomTitle = true
      } catch {}
    } else if (line.includes('"ai-title"')) {
      try {
        aiTitle = JSON.parse(line).aiTitle || aiTitle
        aiTitles.add(aiTitle)
      } catch {}
    } else if (line.includes('"agent-name"')) {
      // The agents view names a session by its agent-name; /rename sets only that.
      // One that repeats an AI title was made by Claude Code, not by a rename.
      try {
        const named = JSON.parse(line).agentName
        if (named && !aiTitles.has(named)) {
          title = named
          isCustomTitle = true
        }
        agentName = named || agentName
      } catch {}
    } else if (!preview && line.startsWith('{') && line.includes('"type":"user"')) {
      try {
        const row = JSON.parse(line)
        if (row.isMeta || row.isCompactSummary) continue
        const said = promptText(row.message && row.message.content)
        if (said && !said.startsWith('<')) preview = said
      } catch {}
    }
  }
  return {
    title: clean(isCustomTitle ? title : aiTitle).slice(0, 120),
    isCustomTitle,
    preview: clean(preview).slice(0, 160),
    isEmpty: !hasReply && !preview,
    sessionTitle: clean(sessionTitle),
    agentName: clean(agentName),
    branch,
    compactions,
    // Compacted counts only while nothing was said after the last compaction.
    isCompacted: compactions > 0 && repliesSinceCompact === 0,
    firstUuid,
    uuids,
  }
}

// Claude Code writes ~/.claude/sessions/<pid>.json for each running session.
// Resuming a session that another process holds forks it to a new id.
const liveSessions = () => {
  const live = new Map()
  const dir = path.join(configDir, 'sessions')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return live
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (!entry.sessionId || !entry.pid) continue
      process.kill(entry.pid, 0)
      live.set(entry.sessionId, {
        pid: entry.pid,
        kind: entry.kind === 'bg' ? 'bg' : 'interactive',
        status: String(entry.status || ''),
        name: String(entry.name || ''),
        // The agents list keeps an idle "spare" process ready for the next task.
        spare: entry.spare === true,
      })
    } catch {}
  }
  return live
}

const findFile = id => {
  for (const project of fs.readdirSync(projectsDir)) {
    const file = path.join(projectsDir, project, `${id}.jsonl`)
    if (fs.existsSync(file)) return { project, file }
  }
  return null
}

const projectFolder = root => String(root || '').replace(/[^a-zA-Z0-9]/g, '-')

const list = (currentId, root) => {
  const current = currentId ? findFile(currentId) : null
  const projects = current ? [current.project] : root ? [projectFolder(root)] : []
  const sessions = []
  for (const project of projects) {
    const dir = path.join(projectsDir, project)
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      sessions.push({
        id: name.slice(0, -'.jsonl'.length),
        project,
        file,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        birthMs: stat.birthtimeMs || stat.ctimeMs,
        ...summarize(file),
      })
    }
  }
  const live = liveSessions()
  for (let index = sessions.length - 1; index >= 0; index--) {
    const running = live.get(sessions[index].id)
    if (running && running.spare) sessions.splice(index, 1)
  }
  for (const session of sessions) {
    const running = live.get(session.id)
    if (running) session.live = { pid: running.pid, kind: running.kind, status: running.status, name: running.name }
    if (!session.firstUuid) continue
    const original = sessions
      .filter(other => other !== session && other.birthMs < session.birthMs && other.uuids.has(session.firstUuid))
      .sort((a, b) => a.birthMs - b.birthMs)[0]
    if (original) {
      session.copyOf = original.id
      session.newMessages = [...session.uuids].filter(uuid => !original.uuids.has(uuid)).length
    }
  }
  for (const session of sessions) {
    delete session.uuids
    delete session.firstUuid
    delete session.birthMs
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sessions
}

const assertSessionFile = file => {
  const resolved = path.resolve(file)
  if (!resolved.startsWith(projectsDir + path.sep) || !resolved.endsWith('.jsonl')) {
    throw new Error(`not a session file: ${file}`)
  }
  return resolved
}

const toolResultText = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => block.text || `[${block.type}]`).join(' ')
      : ''

const transcript = file => {
  const rows = parseLines(fs.readFileSync(file, 'utf8'))
  let start = 0
  rows.forEach((row, index) => {
    if (row.type === 'system' && row.subtype === 'compact_boundary') start = index
  })
  const parts = []
  for (const row of rows.slice(start)) {
    if ((row.type !== 'user' && row.type !== 'assistant') || !row.message) continue
    const content = row.message.content
    if (row.isCompactSummary) {
      parts.push(`Earlier summary:\n${promptText(content)}`)
      continue
    }
    if (typeof content === 'string') {
      parts.push(`${row.type === 'user' ? 'User' : 'Assistant'}: ${content}`)
      continue
    }
    for (const block of content || []) {
      if (block.type === 'text') {
        parts.push(`${row.type === 'user' ? 'User' : 'Assistant'}: ${block.text}`)
      } else if (block.type === 'tool_use') {
        parts.push(`[Tool call ${block.name}: ${JSON.stringify(block.input).slice(0, 600)}]`)
      } else if (block.type === 'tool_result') {
        parts.push(`[Tool result: ${toolResultText(block.content).slice(0, 800)}]`)
      }
    }
  }
  const text = parts.join('\n\n')
  return text.length > TRANSCRIPT_LIMIT ? text.slice(-TRANSCRIPT_LIMIT) : text
}

const META_FIELDS = ['userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch', 'slug']

const appendRows = (file, rows) => {
  const text = fs.readFileSync(file, 'utf8')
  const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  fs.appendFileSync(file, lead + rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

const compact = (file, summary) => {
  if (!summary.trim()) throw new Error('empty summary')
  const text = fs.readFileSync(file, 'utf8')
  const rows = parseLines(text)
  const chained = rows.filter(row => row.uuid && !row.isSidechain)
  const last = chained[chained.length - 1]
  if (!last) throw new Error('no messages to compact')
  const meta = {}
  for (const field of META_FIELDS) if (last[field] !== undefined) meta[field] = last[field]
  const now = new Date().toISOString()
  const boundaryId = crypto.randomUUID()
  const summaryId = crypto.randomUUID()
  fs.copyFileSync(file, `${file}.bak`)
  appendRows(file, [
    {
      parentUuid: null,
      logicalParentUuid: last.uuid,
      isSidechain: false,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      timestamp: now,
      uuid: boundaryId,
      level: 'info',
      compactMetadata: { trigger: 'manual', preTokens: Math.round(transcript(file).length / 4) },
      ...meta,
    },
    {
      parentUuid: boundaryId,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content:
          'This session is being continued from a previous conversation that ran out of context. ' +
          'The summary below covers the earlier portion of the conversation.\n\nSummary:\n' +
          summary.trim(),
      },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid: summaryId,
      timestamp: now,
      ...meta,
    },
    { type: 'last-prompt', leafUuid: summaryId, sessionId: meta.sessionId },
  ])
  return { ok: true, backup: `${file}.bak` }
}

const lastMessage = file => {
  const chained = parseLines(fs.readFileSync(file, 'utf8')).filter(
    row => row.uuid && !row.isSidechain,
  )
  const last = chained[chained.length - 1]
  if (!last) throw new Error(`no messages in ${path.basename(file)}`)
  const meta = {}
  for (const field of META_FIELDS) if (last[field] !== undefined) meta[field] = last[field]
  return { last, meta }
}

const joinNew = (title, files, summary) => {
  if (!summary.trim()) throw new Error('empty summary')
  const anchor = files[0]
  let meta = null
  for (const file of files) {
    try {
      meta = lastMessage(file).meta
      break
    } catch {}
  }
  if (!meta) throw new Error('no messages in the sessions to join')
  const id = crypto.randomUUID()
  const file = path.join(path.dirname(anchor), `${id}.jsonl`)
  const now = new Date().toISOString()
  const boundaryId = crypto.randomUUID()
  const summaryId = crypto.randomUUID()
  const shared = { ...meta, sessionId: id }
  const name = clean(title) || 'Joined sessions'
  fs.writeFileSync(file, '')
  appendRows(file, [
    { type: 'custom-title', customTitle: name, sessionId: id },
    {
      parentUuid: null,
      isSidechain: false,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      timestamp: now,
      uuid: boundaryId,
      level: 'info',
      compactMetadata: { trigger: 'manual', preTokens: 0 },
      ...shared,
    },
    {
      parentUuid: boundaryId,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content:
          'This session continues work from several earlier conversations that were joined. ' +
          'The summary below covers all of them.\n\nSummary:\n' +
          summary.trim(),
      },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid: summaryId,
      timestamp: now,
      ...shared,
    },
    { type: 'last-prompt', leafUuid: summaryId, sessionId: id },
  ])
  return { ok: true, id, file, title: name }
}

const joinInto = (file, summary) => {
  if (!summary.trim()) throw new Error('empty summary')
  const { last, meta } = lastMessage(file)
  const now = new Date().toISOString()
  const userId = crypto.randomUUID()
  const replyId = crypto.randomUUID()
  fs.copyFileSync(file, `${file}.bak`)
  appendRows(file, [
    {
      parentUuid: last.uuid,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content:
          'Context joined from other sessions, to use from here on:\n\n' + summary.trim(),
      },
      uuid: userId,
      timestamp: now,
      ...meta,
    },
    {
      parentUuid: userId,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: `msg_${replyId.replace(/-/g, '')}`,
        type: 'message',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Noted: I have the joined context and will use it.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid: replyId,
      timestamp: now,
      ...meta,
    },
    { type: 'last-prompt', leafUuid: replyId, sessionId: meta.sessionId },
  ])
  return { ok: true, backup: `${file}.bak` }
}

const rename = (file, title) => {
  const name = clean(title)
  if (!name) throw new Error('empty title')
  const id = path.basename(file, '.jsonl')
  appendRows(file, [
    { type: 'custom-title', customTitle: name, sessionId: id },
    { type: 'agent-name', agentName: name, sessionId: id },
  ])
  return { ok: true, title: name }
}

// Brings /resume's name (custom-title) and the agents view's (agent-name) to
// the newest one. Only the custom-title is written: a running session keeps
// its agent name in memory, so the caller runs /rename for that side.
const syncName = id => {
  const found = findFile(id)
  if (!found) return { title: '', agentName: '' }
  const { title, isCustomTitle, sessionTitle, agentName } = summarize(found.file)
  if (isCustomTitle && title && title !== sessionTitle) {
    appendRows(found.file, [{ type: 'custom-title', customTitle: title, sessionId: id }])
  }
  return { title: isCustomTitle ? title : '', agentName }
}

const remove = file => {
  const sidecar = file.slice(0, -'.jsonl'.length)
  fs.rmSync(file, { force: true })
  fs.rmSync(`${file}.bak`, { force: true })
  if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) {
    fs.rmSync(sidecar, { recursive: true, force: true })
  }
  return { ok: true }
}

// Outside every project: the handoff is read once by the new agent.
const handoffFile = (name, text) => {
  const dir = path.join(os.tmpdir(), 'claude-handoffs')
  fs.mkdirSync(dir, { recursive: true })
  const slug = clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'handoff'
  const file = path.join(dir, `${slug}-${Date.now()}.md`)
  fs.writeFileSync(file, text)
  return { path: file }
}

const main = () => {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'list') return JSON.stringify(list(args[0], args[1]))
  if (command === 'transcript') return transcript(assertSessionFile(args[0]))
  if (command === 'compact') {
    return JSON.stringify(compact(assertSessionFile(args[0]), fs.readFileSync(0, 'utf8')))
  }
  if (command === 'sync-name') return JSON.stringify(syncName(args[0] || ''))
  if (command === 'rename') return JSON.stringify(rename(assertSessionFile(args[0]), args[1] || ''))
  if (command === 'join-new') {
    const [title, ...files] = args
    if (files.length === 0) throw new Error('no sessions to join')
    return JSON.stringify(
      joinNew(title || '', files.map(assertSessionFile), fs.readFileSync(0, 'utf8')),
    )
  }
  if (command === 'join-into') {
    return JSON.stringify(joinInto(assertSessionFile(args[0]), fs.readFileSync(0, 'utf8')))
  }
  if (command === 'handoff-file') {
    return JSON.stringify(handoffFile(args[0] || '', fs.readFileSync(0, 'utf8')))
  }
  if (command === 'delete') return JSON.stringify(remove(assertSessionFile(args[0])))
  throw new Error(`unknown command: ${command}`)
}

try {
  process.stdout.write(main())
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error))
  process.exit(1)
}
