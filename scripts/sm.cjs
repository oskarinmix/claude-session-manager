// Session file helper for the session-manager mod. Runs under Node.
//   list <currentSessionId> <project|all>   JSON array of sessions
//   transcript <file>                       conversation text since the last compact
//   compact <file>                          appends a compact boundary + summary (stdin)
//   rename <file> <title>                   appends a custom-title row
//   delete <file>                           removes the file and its sidecar folder
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
  let aiTitle = ''
  let preview = ''
  for (const line of text.split('\n')) {
    if (line.includes('"custom-title"')) {
      try {
        title = JSON.parse(line).customTitle || title
        isCustomTitle = true
      } catch {}
    } else if (line.includes('"ai-title"')) {
      try {
        aiTitle = JSON.parse(line).aiTitle || aiTitle
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
  }
}

const findFile = id => {
  for (const project of fs.readdirSync(projectsDir)) {
    const file = path.join(projectsDir, project, `${id}.jsonl`)
    if (fs.existsSync(file)) return { project, file }
  }
  return null
}

const list = (currentId, scope) => {
  const current = currentId ? findFile(currentId) : null
  const projects =
    scope === 'all' || !current ? fs.readdirSync(projectsDir) : [current.project]
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
        ...summarize(file),
      })
    }
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

const rename = (file, title) => {
  const name = clean(title)
  if (!name) throw new Error('empty title')
  const id = path.basename(file, '.jsonl')
  appendRows(file, [{ type: 'custom-title', customTitle: name, sessionId: id }])
  return { ok: true, title: name }
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

const main = () => {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'list') return JSON.stringify(list(args[0], args[1]))
  if (command === 'transcript') return transcript(assertSessionFile(args[0]))
  if (command === 'compact') {
    return JSON.stringify(compact(assertSessionFile(args[0]), fs.readFileSync(0, 'utf8')))
  }
  if (command === 'rename') return JSON.stringify(rename(assertSessionFile(args[0]), args[1] || ''))
  if (command === 'delete') return JSON.stringify(remove(assertSessionFile(args[0])))
  throw new Error(`unknown command: ${command}`)
}

try {
  process.stdout.write(main())
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error))
  process.exit(1)
}
