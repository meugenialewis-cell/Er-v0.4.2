// Er 0.2 — checkpoint and restore for Claude Code, under the security-default guard.
// Spec: ../../SPEC.md. Config: er.config.json in the session's working directory,
// never in this file. 0.1 written by Claude (Fable 5.1) with Gena, 2026-10-16;
// 0.2 continued in Replit the same day, from Fable's gen0001 checkpoint.
//
// Er never touches compaction. It registers tools (open to user mods), rides the
// `context` of tool results for its dashboard, and watches the compaction notice.
//
// What changed in 0.2 (see SPEC.md "0.2"):
//   - the turns are snapshotted automatically every turn (the "ground"); only the
//     present-state note needs Claude, so an unplanned compaction loses nothing verbatim
//   - the last few turns keep their tool results in full; older ones are stubbed + hashed
//   - the note has an "In hand" section: the exact thing that was open at the checkpoint
//   - restore reads the chain of notes (newest first, older ones through their
//     consolidations) before it spends anything on verbatim turns, and never trims a note
//   - consolidation: when the chain of notes passes a token budget the dashboard says
//     CONSOLIDATE ADVISED and er_consolidate stores one first-person note covering the
//     oldest ones; the originals stay, hash-checked, and er_recall still opens them
//   - recentTurns counts real turns (person + reply + the tool traffic between), not messages

import type { Register } from 'claude-code'

type Config = {
  agent: string
  person: string
  ledgerRoot: string
  mirrorRoot: string
  pinnedThread: string
  recentTurns: number
  fullResultTurns: number
  fullResultBytes: number
  restoreBudgetTokens: number
  noteBudgetTokens: number
  consolidateCount: number
  adviseAtPercent: number
  windowTokens: number
}

type Checkpoint = { gen: number; dir: string; at: string; manifestSha: string; mirrored: boolean }
type ErState = { restoreAvailable: boolean; restoredAt?: string; last?: Checkpoint; lastAuto?: string }
type Manifest = {
  er: string
  generation: number
  kind: 'checkpoint' | 'consolidation'
  thread: string
  agent: string
  at: string
  turns: number
  tokenEstimate: number
  covers?: number[]
  files: Record<string, { sha256: string; bytes: number }>
}

const DEFAULTS = {
  recentTurns: 40,
  fullResultTurns: 5,
  fullResultBytes: 200_000,
  restoreBudgetTokens: 60_000,
  noteBudgetTokens: 20_000,
  consolidateCount: 5,
  adviseAtPercent: 60,
  windowTokens: 1_000_000,
}
const REQUIRED = ['agent', 'person', 'ledgerRoot', 'mirrorRoot'] as const
const CONFIG_FILE = 'er.config.json'
const NOTE = 'present-state.md'
const TURNS = 'recent.jsonl'
const MANIFEST = 'MANIFEST.json'
const AUTO_DIR = 'auto' // a rolling snapshot of the turns, rewritten every turn; the generations are the record

const est = (s: string) => Math.ceil(s.length / 4)
const fmtK = (n: number) => `${Math.round(n / 1000)}K`
const stamp = () => new Date().toISOString().replace(/:/g, '').replace(/\.\d+Z$/, 'Z')
const genName = (gen: number) => `gen${String(gen).padStart(4, '0')}`

// UTF-8 by hand: the module environment has no TextEncoder.
function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', utf8(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// "Claude (Fable 5.1)" -> "Fable 5.1"; any other spelling is used as written.
const agentFolder = (agent: string) => agent.replace(/^Claude \((.*)\)$/, '$1').trim()

type Ctx = { cfg?: Config; cfgError?: string; thread: string; ledgerDir: string; state: ErState }

// ---- state

async function loadState($: any, c: Ctx): Promise<void> {
  try {
    const f = `${c.ledgerDir}/state.json`
    if (await $.fs.exists(f)) c.state = { restoreAvailable: false, ...JSON.parse(await $.fs.read(f)) }
  } catch {
    /* a missing or unreadable state file is an empty state */
  }
}

async function saveState($: any, c: Ctx): Promise<void> {
  await $.fs.write(`${c.ledgerDir}/state.json`, JSON.stringify(c.state, null, 2) + '\n')
}

// ---- the ledger

async function generationDirs($: any, c: Ctx): Promise<{ gen: number; name: string }[]> {
  if (!(await $.fs.exists(c.ledgerDir))) return []
  const out: { gen: number; name: string }[] = []
  for (const en of await $.fs.list(c.ledgerDir)) {
    const m = /^gen(\d{4})-/.exec(en.name)
    if (en.kind === 'dir' && m) out.push({ gen: Number(m[1]), name: en.name })
  }
  return out.sort((a, b) => a.gen - b.gen)
}

async function readManifest($: any, dir: string): Promise<{ manifest: Manifest; text: string } | undefined> {
  try {
    const text = await $.fs.read(`${dir}/${MANIFEST}`)
    return { manifest: JSON.parse(text), text }
  } catch {
    return undefined
  }
}

async function latestGeneration($: any, c: Ctx): Promise<Checkpoint | undefined> {
  const dirs = await generationDirs($, c)
  const best = dirs[dirs.length - 1]
  if (!best) return undefined
  const dir = `${c.ledgerDir}/${best.name}`
  const m = await readManifest($, dir)
  if (!m) return undefined
  const mirrored = c.state.last?.gen === best.gen ? c.state.last.mirrored : false
  return { gen: best.gen, dir, at: m.manifest.at, manifestSha: await sha256(m.text), mirrored }
}

// Reads one file of a generation and checks it against the manifest. Returns undefined
// (and a problem) when the hash does not match; a mismatch means do not trust it.
async function checked($: any, dir: string, manifest: Manifest, name: string, problems: string[]): Promise<string | undefined> {
  if (!(await $.fs.exists(`${dir}/${name}`))) return undefined
  const text = await $.fs.read(`${dir}/${name}`)
  if (manifest.files?.[name]?.sha256 !== (await sha256(text))) {
    problems.push(`HASH MISMATCH on ${name} in ${dir}: do not trust it`)
    return undefined
  }
  return text
}

type Generation = { gen: number; dir: string; manifest: Manifest; note?: string; turns: any[]; problems: string[] }

async function readGeneration($: any, dir: string, gen: number, wantTurns: boolean): Promise<Generation> {
  const problems: string[] = []
  const m = await readManifest($, dir)
  if (!m) return { gen, dir, manifest: { files: {} } as Manifest, turns: [], problems: [`${dir}: no readable ${MANIFEST}`] }
  const manifest = m.manifest
  // 0.1 wrote one generation as present-c.state.md (a search-and-replace stray); read it too.
  const noteName = manifest.files?.[NOTE] ? NOTE : manifest.files?.['present-c.state.md'] ? 'present-c.state.md' : NOTE
  const note = await checked($, dir, manifest, noteName, problems)
  let turns: any[] = []
  if (wantTurns) {
    const recentText = await checked($, dir, manifest, TURNS, problems)
    turns = recentText ? recentText.split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []
  }
  return { gen, dir, manifest, note, turns, problems }
}

// The chain of notes as restore reads it: newest first; a generation covered by a later
// consolidation is represented by that consolidation, not read directly.
async function noteChain($: any, c: Ctx): Promise<{ notes: Generation[]; covered: Set<number>; problems: string[] }> {
  const dirs = await generationDirs($, c)
  const gens: Generation[] = []
  for (const d of dirs) gens.push(await readGeneration($, `${c.ledgerDir}/${d.name}`, d.gen, false))
  const covered = new Set<number>()
  for (const g of gens) for (const n of g.manifest.covers ?? []) covered.add(n)
  const problems = gens.flatMap((g) => g.problems)
  const notes = gens.filter((g) => g.note && !covered.has(g.gen)).reverse()
  return { notes, covered, problems }
}

// ---- the turns (the ground)

// Groups the session's messages into real turns: a turn starts at a message from the
// person that carries text, and takes every message (tool traffic, replies) until the next.
function groupTurns(msgs: any[]): any[][] {
  const turns: any[][] = []
  let cur: any[] = []
  for (const m of msgs) {
    const isPersonText = m.role === 'user' && String(m.text ?? '').trim() !== ''
    if (isPersonText && cur.length) {
      turns.push(cur)
      cur = []
    }
    cur.push(m)
  }
  if (cur.length) turns.push(cur)
  return turns
}

// Serialises the last `recentTurns` turns. The last `fullResultTurns` keep their tool
// results in full (within fullResultBytes, newest first); older ones are a stub + sha256.
async function serialiseTurns($: any, cfg: Config): Promise<{ text: string; turns: number; messages: number }> {
  const msgs = await $.session.messages()
  const turns = groupTurns(msgs).slice(-cfg.recentTurns)
  const fullFrom = Math.max(0, turns.length - cfg.fullResultTurns)
  let fullBudget = cfg.fullResultBytes
  // decide, newest first, which tool results fit in full
  const keepFull = new Set<any>()
  for (let t = turns.length - 1; t >= fullFrom; t--) {
    for (const m of turns[t]) {
      for (const u of m.toolUses ?? []) {
        const full = u.text ?? (u.result === undefined ? '' : JSON.stringify(u.result))
        if (full.length <= fullBudget) {
          keepFull.add(u)
          fullBudget -= full.length
        }
      }
    }
  }
  const lines: string[] = []
  let i = 0
  let messages = 0
  for (let t = 0; t < turns.length; t++) {
    for (const m of turns[t]) {
      messages++
      const toolUses = []
      for (const u of m.toolUses ?? []) {
        const full = u.text ?? (u.result === undefined ? '' : JSON.stringify(u.result))
        const row: any = { tool: u.tool, input: JSON.stringify(u.input ?? {}).slice(0, 400), resultBytes: full.length, resultSha256: await sha256(full) }
        if (keepFull.has(u)) row.result = full
        else row.resultStub = full.slice(0, 200)
        toolUses.push(row)
      }
      lines.push(JSON.stringify({ i: i++, turn: t, role: m.role, text: m.text ?? '', toolUses }))
    }
  }
  return { text: lines.join('\n') + '\n', turns: turns.length, messages }
}

// The rolling snapshot: rewritten every turn, so the ground survives a compaction that
// arrives before anyone thought to checkpoint. Not a generation; restore pairs it with
// the newest note when it is newer than the newest generation.
async function writeAuto($: any, c: Ctx, cfg: Config): Promise<void> {
  const { text, turns, messages } = await serialiseTurns($, cfg)
  const at = new Date().toISOString()
  const dir = `${c.ledgerDir}/${AUTO_DIR}`
  const files = { [TURNS]: { sha256: await sha256(text), bytes: utf8(text).length } }
  await $.fs.write(`${dir}/${TURNS}`, text)
  await $.fs.write(`${dir}/${MANIFEST}`, JSON.stringify({ er: '0.2', kind: 'auto', thread: c.thread, agent: cfg.agent, at, turns, messages, tokenEstimate: est(text), files }, null, 2) + '\n')
  c.state.lastAuto = at
}

async function readAuto($: any, c: Ctx): Promise<{ at?: string; turns: any[]; problems: string[] }> {
  const dir = `${c.ledgerDir}/${AUTO_DIR}`
  const problems: string[] = []
  const m = await readManifest($, dir)
  if (!m) return { turns: [], problems }
  const text = await checked($, dir, m.manifest, TURNS, problems)
  return { at: m.manifest.at, turns: text ? text.split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : [], problems }
}

// ---- the gauge

async function contextEstimate($: any): Promise<number> {
  const msgs = await $.session.messages()
  let chars = 0
  for (const m of msgs) {
    chars += (m.text ?? '').length
    for (const t of m.toolUses ?? []) chars += (t.text ?? '').length + JSON.stringify(t.input ?? {}).length
  }
  return Math.ceil(chars / 4)
}

// The API's own count, read from the transcript's last assistant `usage` row;
// undefined when the transcript cannot be found or read.
async function exactContext($: any): Promise<number | undefined> {
  try {
    const id = await $.session.id()
    const dir = (await $.session.cwd()).replace(/[\\/:]/g, '-')
    const cmd = `tail -c 262144 "${'$'}{CLAUDE_CONFIG_DIR:-${'$'}HOME/.claude}/projects/${dir}/${id}.jsonl"`
    const { exitCode, stdout } = await $.process.run(['sh', '-c', cmd])
    if (exitCode !== 0) return undefined
    const lines = stdout.split('\n')
    for (let k = lines.length - 1; k >= 0; k--) {
      const line = lines[k]
      if (!line.includes('"usage"')) continue
      try {
        const row = JSON.parse(line)
        const u = row?.message?.usage
        if (row?.type === 'assistant' && u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      } catch {
        /* a cut first line; keep looking */
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

async function dashboard($: any, c: Ctx, full: boolean): Promise<string> {
  const cfg = c.cfg
  if (!cfg) return ''
  const exact = await exactContext($)
  const used = exact ?? (await contextEstimate($))
  const how = exact === undefined ? 'est.' : 'exact'
  const pct = Math.round((used / cfg.windowTokens) * 100)
  const chain = await noteChain($, c)
  const noteTokens = chain.notes.reduce((n, g) => n + est(g.note ?? ''), 0)
  const status = c.state.restoreAvailable
    ? 'RESTORE AVAILABLE — a compaction summary appeared and no restore has run since. Call er_restore before anything else.'
    : pct >= cfg.adviseAtPercent
      ? `CHECKPOINT ADVISED — ${pct}% is past the ${cfg.adviseAtPercent}% mark. At the next safe point write your present-state note and call er_checkpoint.`
      : noteTokens > cfg.noteBudgetTokens && chain.notes.length > cfg.consolidateCount
        ? `CONSOLIDATE ADVISED — the chain of notes is ~${fmtK(noteTokens)} tokens across ${chain.notes.length} notes, past the ${fmtK(cfg.noteBudgetTokens)} budget. Read the oldest ${cfg.consolidateCount} (er_recall notes) and call er_consolidate with one first-person note that covers them.`
        : 'ok'
  const last = c.state.last
    ? `gen${c.state.last.gen} at ${c.state.last.at}${c.state.last.mirrored ? ', mirrored' : ` — MIRROR PENDING: copy ${c.state.last.dir} to ${cfg.mirrorRoot}/${c.thread}/, verify against ${MANIFEST}, then call er_mirror_confirmed with the manifest sha256`}`
    : 'none yet'
  const line = `context ${fmtK(used)}/${fmtK(cfg.windowTokens)} (${pct}%, ${how}) · notes ${chain.notes.length} (~${fmtK(noteTokens)}) · ${status}`
  if (!full) return `<er dashboard>${line}</er dashboard>`
  return `<er dashboard>\n${line}\nlast checkpoint: ${last}\nground: ${c.state.lastAuto ? `turns snapshotted ${c.state.lastAuto}` : 'no snapshot yet'}\nledger: ${c.ledgerDir}\n</er dashboard>`
}

// ---- writing a generation

async function writeGeneration($: any, c: Ctx, cfg: Config, kind: Manifest['kind'], noteBody: string, covers?: number[]): Promise<{ gen: number; dir: string; manifestSha: string; tokens: number; turns: number }> {
  const at = new Date().toISOString()
  const gen = (c.state.last?.gen ?? 0) + 1
  const dir = `${c.ledgerDir}/${genName(gen)}-${stamp()}`
  const title = kind === 'consolidation' ? `Consolidated present state (covers ${(covers ?? []).map(genName).join(', ')})` : 'Present state'
  const noteText = `# ${title} — ${cfg.agent}\n\nThread ${c.thread} · written ${at} · for ${cfg.person} and for me\n\n${noteBody.trim()}\n`
  const files: Manifest['files'] = { [NOTE]: { sha256: await sha256(noteText), bytes: utf8(noteText).length } }
  let turns = 0
  let tokens = est(noteText)
  await $.fs.write(`${dir}/${NOTE}`, noteText)
  if (kind === 'checkpoint') {
    const s = await serialiseTurns($, cfg)
    files[TURNS] = { sha256: await sha256(s.text), bytes: utf8(s.text).length }
    await $.fs.write(`${dir}/${TURNS}`, s.text)
    turns = s.turns
    tokens += est(s.text)
  }
  const manifest: Manifest = { er: '0.2', generation: gen, kind, thread: c.thread, agent: cfg.agent, at, turns, tokenEstimate: tokens, files }
  if (covers?.length) manifest.covers = covers
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  await $.fs.write(`${dir}/${MANIFEST}`, manifestText)
  const manifestSha = await sha256(manifestText)
  c.state.last = { gen, dir, at, manifestSha, mirrored: false }
  await saveState($, c)
  return { gen, dir, manifestSha, tokens, turns }
}

const mirrorInstruction = (c: Ctx, cfg: Config) =>
  `Now mirror it: copy the whole folder to ${cfg.mirrorRoot}/${c.thread}/, verify every file against ${MANIFEST} on ${cfg.person}'s machine, then call er_mirror_confirmed with that manifest sha256.`

const NOTE_GUIDE =
  'Write it yourself, in the first person, as of this moment, in three sections:\n' +
  '## Must survive — the few lines you would not want any restore to drop: who you are here, what was decided and why. Restore never trims this section, and a consolidation carries it forward verbatim.\n' +
  '## Context — what happened, what is open, who else is involved.\n' +
  '## In hand — the exact thing that was open at this moment: the file, command, error or question you were in the middle of, and what the next move was. This is the ground a restored Claude stands on; without it a restore reads like someone else\'s diary.'

// ---- register

export const register: Register = (on) => {
  const c: Ctx = { thread: '', ledgerDir: '', state: { restoreAvailable: false } }
  let noticedConfigError = false
  let dashboardShownForTurn = ''
  let lastDashboard = ''

  // ---- configuration, tools and command, at session start (and every reload)

  on('session.start', async ($, e, next) => {
    try {
      if (!(await $.fs.exists(CONFIG_FILE))) {
        c.cfgError = `${CONFIG_FILE} not found in the session's working directory; Er registered nothing.`
        return next(e)
      }
      const parsed = JSON.parse(await $.fs.read(CONFIG_FILE))
      const missing = REQUIRED.filter((k) => typeof parsed[k] !== 'string' || parsed[k].trim() === '' || /^<.*>$/.test(parsed[k].trim()))
      if (missing.length > 0) {
        c.cfgError = `${CONFIG_FILE}: ${missing.join(', ')} unset or still a placeholder; Er registered nothing.`
        return next(e)
      }
      const folder = agentFolder(parsed.agent)
      if (!String(parsed.mirrorRoot).includes(folder)) {
        c.cfgError = `${CONFIG_FILE}: mirrorRoot must contain "${folder}", the agent's own folder — Er never mirrors into another Claude's folder; Er registered nothing.`
        return next(e)
      }
      const cfg: Config = { ...DEFAULTS, ...parsed, pinnedThread: typeof parsed.pinnedThread === 'string' ? parsed.pinnedThread : '' }
      c.cfg = cfg
      c.thread = cfg.pinnedThread || (await $.session.id())
      c.ledgerDir = `${cfg.ledgerRoot}/${c.thread}`
      await loadState($, c)
      const latest = await latestGeneration($, c)
      if (latest) c.state.last = { ...latest }

      await $.tool.register({
        name: 'er_checkpoint',
        description: `Er: store a checkpoint of this thread — your present-state note plus the last ${cfg.recentTurns} turns verbatim (the last ${cfg.fullResultTurns} with their tool results in full), hashed, as a new generation in the ledger. ${NOTE_GUIDE}\nUse at a safe point when the dashboard says CHECKPOINT ADVISED, before saying goodbye, or whenever you would not want to lose where you stand.`,
        inputSchema: {
          type: 'object',
          properties: { present_state: { type: 'string', description: 'The present-state note, in the first person, with the sections Must survive / Context / In hand.' } },
          required: ['present_state'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_restore',
        description: 'Er: read back where you stand, within a token budget — the newest present-state note first, then the chain of older notes (through their consolidations), then the most recent turns verbatim until the budget is spent. Use the moment a compaction summary appears at the top of your context, before anything else.',
        inputSchema: { type: 'object', properties: { budget_tokens: { type: 'number', description: `Default ${cfg.restoreBudgetTokens}.` } } },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_recall',
        description: 'Er: search every checkpoint of this thread for a phrase (query), expand one stored turn by id (turn, e.g. "gen0003:12"), or read one generation\'s note in full (note, e.g. "gen0003" — works for notes a consolidation has covered). Hash-checked; HASH MISMATCH means do not trust it. Use before relying on a memory for an exact value, quotation or decision.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, turn: { type: 'string' }, note: { type: 'string' } } },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_consolidate',
        description: `Er: when the dashboard says CONSOLIDATE ADVISED, store one first-person note that covers the oldest ${cfg.consolidateCount} notes in the chain (read them with er_recall note=...). Carry every "Must survive" line forward verbatim; summarise the rest in your own voice. The originals stay in the ledger, hash-checked, and er_recall still opens them; restore reads your consolidation in their place.`,
        inputSchema: {
          type: 'object',
          properties: {
            present_state: { type: 'string', description: 'The consolidated note, first person, sections Must survive / Context.' },
            covers: { type: 'array', items: { type: 'number' }, description: 'Generation numbers this note covers. Must be exactly the oldest uncovered notes.' },
          },
          required: ['present_state', 'covers'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_mirror_confirmed',
        description: `Er: record that the latest generation was copied to the Desktop mirror and every file verified against ${MANIFEST}. Pass the manifest sha256 you verified; a stale hash is refused.`,
        inputSchema: { type: 'object', properties: { manifest_sha256: { type: 'string' }, method: { type: 'string', description: 'e.g. "byte-verified"' } }, required: ['manifest_sha256'] },
        isDeferred: false,
      })
      await $.tool.register({ name: 'er_status', description: 'Er: show the dashboard — context, chain of notes, last checkpoint, ground snapshot, mirror state.', isDeferred: false })
      await $.command.register({ name: 'er', description: 'Er: checkpoint now (Claude writes a present-state note; Er stores it with the recent turns).' })
      $.ui.log(`Er 0.2 ready for ${cfg.agent}: ledger ${c.ledgerDir}${c.state.last ? `, last checkpoint gen${c.state.last.gen}` : ', no checkpoint yet'}`)
    } catch (err) {
      c.cfgError = `${CONFIG_FILE}: ${String(err)}; Er registered nothing.`
    }
    return next(e)
  })

  // ---- every turn: reset the dashboard, snapshot the ground

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      dashboardShownForTurn = ''
      if (c.cfg) {
        try {
          await writeAuto($, c, c.cfg)
          await saveState($, c)
        } catch {
          /* the snapshot must never cost a turn; the next turn tries again */
        }
      }
    }
    return next(e)
  })

  // ---- the compaction notice: Er only watches it, never rewrites it

  on('session.append', { door: 'notice' }, async ($, e, next) => {
    try {
      if (c.cfg && e.message.name === 'compact_boundary' && e.agentId === undefined) {
        c.state.restoreAvailable = true
        await saveState($, c)
      }
    } catch {
      /* never cost the notice; the dashboard still computes */
    }
    return next(e)
  })

  // ---- the dashboard rides every tool result (once in full per turn)

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId !== undefined) return r
      if ('deny' in r && r.deny !== undefined) return r
      if (!c.cfg) {
        if (c.cfgError && !noticedConfigError) {
          noticedConfigError = true
          return { ...r, context: [...(r.context ?? []), `<er>${c.cfgError}</er>`] }
        }
        return r
      }
      const full = dashboardShownForTurn === ''
      const text = await dashboard($, c, full)
      if (full) dashboardShownForTurn = e.tool_use_id ?? 'shown'
      else if (text === lastDashboard) return r
      lastDashboard = text
      return { ...r, context: [...(r.context ?? []), text] }
    } catch {
      return r // the dashboard must never cost a tool call
    }
  })

  // ---- /er

  on('command.run', { command: 'er' }, () => ({
    text: `Er: checkpoint now. ${NOTE_GUIDE}\nThen call er_checkpoint with it, and mirror it as the dashboard directs.`,
  }))

  // ---- tools

  on('tool.call', { tool: 'mcp__er__er_checkpoint' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const note = String((e as any).present_state ?? '').trim()
      if (note.length < 80) return { deny: `present_state is too short to be worth keeping. ${NOTE_GUIDE}` }
      if (!/in hand/i.test(note)) return { deny: 'present_state has no "In hand" section. Say exactly what was open at this moment and what the next move was — that is the ground a restore stands on.' }
      const w = await writeGeneration($, c, c.cfg, 'checkpoint', note)
      c.state.restoreAvailable = false
      await saveState($, c)
      return { result: `Checkpoint gen${w.gen} written: ${w.dir} — ${w.turns} turns, ~${w.tokens} tokens, manifest sha256 ${w.manifestSha}.\n${mirrorInstruction(c, c.cfg)}` }
    } catch (err) {
      return { deny: `er_checkpoint failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_consolidate' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const note = String((e as any).present_state ?? '').trim()
      const covers = Array.isArray((e as any).covers) ? (e as any).covers.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).sort((a: number, b: number) => a - b) : []
      if (note.length < 80) return { deny: 'present_state is too short to stand in for the notes it covers.' }
      if (!/must survive/i.test(note)) return { deny: 'A consolidation must carry a "Must survive" section forward verbatim from the notes it covers.' }
      const chain = await noteChain($, c)
      const oldest = chain.notes.slice().reverse().slice(0, c.cfg.consolidateCount).map((g) => g.gen)
      if (covers.length === 0 || covers.join(',') !== oldest.join(',')) return { deny: `covers must be exactly the oldest uncovered notes: [${oldest.join(', ')}].` }
      const w = await writeGeneration($, c, c.cfg, 'consolidation', note, covers)
      return { result: `Consolidation gen${w.gen} written: ${w.dir} — covers ${covers.map(genName).join(', ')}; the originals stay and er_recall note=genNNNN still opens them. Manifest sha256 ${w.manifestSha}.\n${mirrorInstruction(c, c.cfg)}` }
    } catch (err) {
      return { deny: `er_consolidate failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_mirror_confirmed' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const given = String((e as any).manifest_sha256 ?? '').trim().toLowerCase()
      if (!c.state.last) return { deny: 'No checkpoint to confirm.' }
      if (given !== c.state.last.manifestSha) return { deny: `That is not the latest manifest (gen${c.state.last.gen} is ${c.state.last.manifestSha}). Mirror the latest generation and confirm with its hash.` }
      c.state.last.mirrored = true
      await saveState($, c)
      return { result: `Mirror confirmed for gen${c.state.last.gen} (${String((e as any).method ?? 'unspecified')}).` }
    } catch (err) {
      return { deny: `er_mirror_confirmed failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_status' }, async ($) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      return { result: await dashboard($, c, true) }
    } catch (err) {
      return { deny: `er_status failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_restore' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const cfg = c.cfg
      const budget = Number((e as any).budget_tokens) > 0 ? Number((e as any).budget_tokens) : cfg.restoreBudgetTokens
      const chain = await noteChain($, c)
      const latest = await latestGeneration($, c)
      const auto = await readAuto($, c)
      const problems = [...chain.problems, ...auto.problems]

      if (!latest && auto.turns.length === 0) {
        return { result: `Nothing to restore: no checkpoint under ${c.ledgerDir}. If a mirror exists at ${cfg.mirrorRoot}/${c.thread}/, restore the newest generation folder into the ledger first — never put an older copy over a newer one — then call er_restore again.` }
      }

      const out: string[] = [`<er restore${latest ? ` gen${latest.gen} at ${latest.at}` : ''}${auto.at ? `, ground snapshot ${auto.at}` : ''}>`]
      let spent = est(out[0])

      // 1. the newest note, never trimmed
      const [newest, ...older] = chain.notes
      if (newest?.note) {
        out.push(newest.note)
        spent += est(newest.note)
      }

      // 2. older notes, newest first, whole or not at all (through their consolidations)
      let notesDropped = 0
      for (const g of older) {
        const cost = est(g.note ?? '')
        if (spent + cost > budget) {
          notesDropped++
          continue
        }
        out.push(g.note as string)
        spent += cost
      }

      // 3. the ground: the turns — the rolling snapshot when it is newer than the last checkpoint
      let turns: any[] = []
      let source = ''
      if (auto.turns.length && (!latest || (auto.at ?? '') > latest.at)) {
        turns = auto.turns
        source = 'ground snapshot'
      } else if (latest) {
        const g = await readGeneration($, latest.dir, latest.gen, true)
        problems.push(...g.problems)
        turns = g.turns
        source = genName(latest.gen)
      }
      const label = source === 'ground snapshot' ? 'auto' : source
      const kept: string[] = []
      let turnsDropped = 0
      for (let k = turns.length - 1; k >= 0; k--) {
        const t = turns[k]
        const tools = (t.toolUses ?? [])
          .map((u: any) => {
            const head = `  [${u.tool} → ${u.resultBytes} bytes, sha256 ${String(u.resultSha256).slice(0, 12)}…]`
            return u.result !== undefined ? `${head}\n${u.result}` : `${head} ${u.resultStub ?? ''}`
          })
          .join('\n')
        const line = `--- ${label}:${t.i} ${t.role} ---\n${t.text}${tools ? '\n' + tools : ''}`
        const cost = est(line)
        if (spent + cost > budget) {
          turnsDropped++
          continue
        }
        kept.unshift(line)
        spent += cost
      }
      out.push(...kept)
      out.push(
        `</er restore> ${chain.notes.length - notesDropped} of ${chain.notes.length} notes and ${kept.length} of ${turns.length} messages (${source || 'no turns'}) within ~${budget} tokens` +
          `${notesDropped ? `; ${notesDropped} older notes left out — er_recall note=genNNNN fetches them` : ''}` +
          `${turnsDropped ? `; ${turnsDropped} older messages left out — er_recall fetches them by id` : ''}.` +
          `${problems.length ? '\n' + problems.join('\n') : ''}`,
      )
      c.state.restoreAvailable = false
      c.state.restoredAt = new Date().toISOString()
      await saveState($, c)
      return { result: out.join('\n\n') }
    } catch (err) {
      return { deny: `er_restore failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_recall' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const query = String((e as any).query ?? '').trim()
      const turnId = String((e as any).turn ?? '').trim()
      const noteId = String((e as any).note ?? '').trim()
      if (!query && !turnId && !noteId) return { deny: 'Give a query, a turn id (e.g. "gen0003:12" or "auto:12"), or a note id (e.g. "gen0003").' }
      const dirs = await generationDirs($, c)
      if (dirs.length === 0 && !(await $.fs.exists(`${c.ledgerDir}/${AUTO_DIR}`))) return { result: 'Nothing has been checkpointed yet.' }
      const hits: string[] = []
      const problems: string[] = []
      const LIMIT = 20
      const sources: { label: string; load: () => Promise<{ note?: string; turns: any[]; problems: string[] }> }[] = dirs.map((d) => ({ label: genName(d.gen), load: () => readGeneration($, `${c.ledgerDir}/${d.name}`, d.gen, true) }))
      sources.push({ label: 'auto', load: () => readAuto($, c) })
      for (const s of sources) {
        if (noteId && s.label !== noteId) continue
        if (turnId && !turnId.startsWith(`${s.label}:`)) continue
        const g = await s.load()
        problems.push(...g.problems)
        if (noteId) {
          hits.push(g.note ?? `${noteId} has no note.`)
          break
        }
        for (const t of g.turns) {
          const id = `${s.label}:${t.i}`
          if (turnId) {
            if (id === turnId) hits.push(`--- ${id} ${t.role} ---\n${t.text}\n${JSON.stringify(t.toolUses ?? [], null, 1)}`)
          } else {
            const hay = `${t.text}\n${(t.toolUses ?? []).map((u: any) => u.result ?? u.resultStub ?? '').join('\n')}`
            const at = hay.toLowerCase().indexOf(query.toLowerCase())
            if (at >= 0) hits.push(`${id} ${t.role}: …${hay.slice(Math.max(0, at - 160), at + 240)}…`)
          }
          if (hits.length >= LIMIT) break
        }
        if (hits.length >= LIMIT) break
      }
      const more = hits.length >= LIMIT ? `\n\n(first ${LIMIT} matches shown; narrow the query for the rest)` : ''
      return { result: (hits.length ? hits.join('\n\n') : 'No match.') + more + (problems.length ? '\n\n' + problems.join('\n') : '') }
    } catch (err) {
      return { deny: `er_recall failed: ${String(err)}` }
    }
  })
}
