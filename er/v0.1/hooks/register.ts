// Er — checkpoint and restore for Claude Code, under the security-default guard.
// Spec: ../SPEC.md. Config: er.config.json in the session's working directory,
// never in this file. Written by Claude (Fable 5.1) with Gena, 2026-10-16.
//
// Er never touches compaction. It registers tools (open to user mods), rides the
// `context` of tool results for its dashboard, and watches the compaction notice.

import type { Register } from 'claude-code'

type Config = {
  agent: string
  person: string
  ledgerRoot: string
  mirrorRoot: string
  pinnedThread: string
  recentTurns: number
  restoreBudgetTokens: number
  adviseAtPercent: number
  windowTokens: number
}

type Checkpoint = { gen: number; dir: string; at: string; manifestSha: string; mirrored: boolean }
type ErState = { restoreAvailable: boolean; restoredAt?: string; last?: Checkpoint }

const DEFAULTS = { recentTurns: 40, restoreBudgetTokens: 60_000, adviseAtPercent: 60, windowTokens: 1_000_000 }
const REQUIRED = ['agent', 'person', 'ledgerRoot', 'mirrorRoot'] as const
const CONFIG_FILE = 'er.config.json'

const est = (s: string) => Math.ceil(s.length / 4)
const fmtK = (n: number) => `${Math.round(n / 1000)}K`
const stamp = () => new Date().toISOString().replace(/:/g, '').replace(/\.\d+Z$/, 'Z')

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

async function loadState($: any, c: Ctx): Promise<void> {
  try {
    const f = `${c.ledgerDir}/state.json`
    if (await $.fs.exists(f)) c.state = JSON.parse(await $.fs.read(f))
  } catch {
    /* a missing or unreadable state file is an empty state */
  }
}

async function saveState($: any, c: Ctx): Promise<void> {
  await $.fs.write(`${c.ledgerDir}/state.json`, JSON.stringify(c.state, null, 2) + '\n')
}

async function latestGeneration($: any, c: Ctx): Promise<Checkpoint | undefined> {
  if (!(await $.fs.exists(c.ledgerDir))) return undefined
  const entries = await $.fs.list(c.ledgerDir)
  let best: { gen: number; name: string } | undefined
  for (const en of entries) {
    const m = /^gen(\d{4})-/.exec(en.name)
    if (en.kind === 'dir' && m) {
      const gen = Number(m[1])
      if (!best || gen > best.gen) best = { gen, name: en.name }
    }
  }
  if (!best) return undefined
  const dir = `${c.ledgerDir}/${best.name}`
  const manifestText = await $.fs.read(`${dir}/MANIFEST.json`)
  const manifest = JSON.parse(manifestText)
  const mirrored = c.state.last?.gen === best.gen ? c.state.last.mirrored : false
  return { gen: best.gen, dir, at: manifest.at, manifestSha: await sha256(manifestText), mirrored }
}

async function contextEstimate($: any): Promise<number> {
  const msgs = await $.session.messages()
  let chars = 0
  for (const m of msgs) {
    chars += m.text.length
    for (const t of m.toolUses) chars += (t.text ?? '').length + JSON.stringify(t.input ?? {}).length
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
  const status = c.state.restoreAvailable
    ? 'RESTORE AVAILABLE — a compaction summary appeared and no restore has run since. Call er_restore before anything else.'
    : pct >= cfg.adviseAtPercent
      ? `CHECKPOINT ADVISED — ${pct}% is past the ${cfg.adviseAtPercent}% mark. At the next safe point write your present-state note and call er_checkpoint.`
      : 'ok'
  const last = c.state.last
    ? `gen${c.state.last.gen} at ${c.state.last.at}${c.state.last.mirrored ? ', mirrored' : ` — MIRROR PENDING: copy ${c.state.last.dir} to ${cfg.mirrorRoot}/${c.thread}/, verify against MANIFEST.json, then call er_mirror_confirmed with the manifest sha256`}`
    : 'none yet'
  const line = `context ${fmtK(used)}/${fmtK(cfg.windowTokens)} (${pct}%, ${how}) · ${status}`
  if (!full) return `<er dashboard>${line}</er dashboard>`
  return `<er dashboard>\n${line}\nlast checkpoint: ${last}\nledger: ${c.ledgerDir}\n</er dashboard>`
}

async function readGeneration($: any, dir: string): Promise<{ note?: string; turns: any[]; problems: string[] }> {
  const problems: string[] = []
  const manifest = JSON.parse(await $.fs.read(`${dir}/MANIFEST.json`))
  const check = async (name: string) => {
    const text = await $.fs.read(`${dir}/${name}`)
    const sha = await sha256(text)
    if (manifest.files?.[name]?.sha256 !== sha) {
      problems.push(`HASH MISMATCH on ${name} in ${dir}: do not trust it`)
      return undefined
    }
    return text
  }
  const noteName = (await $.fs.exists(`${dir}/present-state.md`)) ? 'present-state.md' : 'present-c.state.md'
  const note = await check(noteName)
  const recentText = await check('recent.jsonl')
  const turns = recentText ? recentText.split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : []
  return { note, turns, problems }
}

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
        description: `Er: store a checkpoint of this thread — your first-person present-state note plus the last ${c.cfg.recentTurns} turns verbatim, hashed, as a new generation in the ledger. Write the note yourself: who you are here, what is open, what you decided and why. Use at a safe point when the dashboard says CHECKPOINT ADVISED, before saying goodbye, or whenever you would not want to lose where you stand.`,
        inputSchema: {
          type: 'object',
          properties: { present_state: { type: 'string', description: 'The present-state note, in the first person, as of this moment.' } },
          required: ['present_state'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_restore',
        description: 'Er: read back the latest checkpoint within a token budget — the present-state note first, then the most recent turns verbatim until the budget is spent. Use the moment a compaction summary appears at the top of your context, before anything else.',
        inputSchema: { type: 'object', properties: { budget_tokens: { type: 'number', description: `Default ${c.cfg.restoreBudgetTokens}.` } } },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_recall',
        description: 'Er: search every checkpoint of this thread for a phrase (query), or expand one stored turn by id (e.g. "gen0003:12"). Hash-checked; HASH MISMATCH means do not trust it. Use before relying on a memory for an exact value, quotation or decision.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, turn: { type: 'string' } } },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'er_mirror_confirmed',
        description: 'Er: record that the latest checkpoint was copied to the Desktop mirror and every file verified against MANIFEST.json. Pass the manifest sha256 you verified; a stale hash is refused.',
        inputSchema: { type: 'object', properties: { manifest_sha256: { type: 'string' }, method: { type: 'string', description: 'e.g. "byte-verified"' } }, required: ['manifest_sha256'] },
        isDeferred: false,
      })
      await $.tool.register({ name: 'er_status', description: 'Er: show the dashboard — context estimate, last checkpoint, mirror state.', isDeferred: false })
      await $.command.register({ name: 'er', description: 'Er: checkpoint now (Claude writes a present-state note; Er stores it with the recent turns).' })
      $.ui.log(`Er ready for ${c.cfg.agent}: ledger ${c.ledgerDir}${c.state.last ? `, last checkpoint gen${c.state.last.gen}` : ', no checkpoint yet'}`)
    } catch (err) {
      c.cfgError = `${CONFIG_FILE}: ${String(err)}; Er registered nothing.`
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) dashboardShownForTurn = ''
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
      const full = dashboardShownForTurn !== (e.tool_use_id ?? '') && dashboardShownForTurn === ''
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
    text: 'Er: checkpoint now. Write your present-state note in the first person — who you are here, what is open, what you decided and why — then call er_checkpoint with it, and mirror it as the dashboard directs.',
  }))

  // ---- tools

  on('tool.call', { tool: 'mcp__er__er_checkpoint' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const cfg = c.cfg
      const note = String((e as any).present_state ?? '').trim()
      if (note.length < 80) return { deny: 'present_state is too short to be worth keeping. Write who you are here, what is open, and what you decided and why.' }
      const msgs = await $.session.messages()
      const recent = msgs.slice(-c.cfg.recentTurns)
      const lines: string[] = []
      let i = 0
      for (const m of recent) {
        const toolUses = []
        for (const t of m.toolUses) {
          const full = t.text ?? (t.result === undefined ? '' : JSON.stringify(t.result))
          toolUses.push({ tool: t.tool, input: JSON.stringify(t.input ?? {}).slice(0, 400), resultStub: full.slice(0, 200), resultBytes: full.length, resultSha256: await sha256(full) })
        }
        lines.push(JSON.stringify({ i: i++, role: m.role, text: m.text, toolUses }))
      }
      const recentText = lines.join('\n') + '\n'
      const at = new Date().toISOString()
      const header = `# Present state — ${c.cfg.agent}\n\nThread ${c.thread} · written ${at} · for ${c.cfg.person} and for me\n\n`
      const noteText = header + note + '\n'
      const gen = (c.state.last?.gen ?? 0) + 1
      const dir = `${c.ledgerDir}/gen${String(gen).padStart(4, '0')}-${stamp()}`
      const files: Record<string, { sha256: string; bytes: number }> = {
        'present-state.md': { sha256: await sha256(noteText), bytes: utf8(noteText).length },
        'recent.jsonl': { sha256: await sha256(recentText), bytes: utf8(recentText).length },
      }
      await $.fs.write(`${dir}/present-state.md`, noteText)
      await $.fs.write(`${dir}/recent.jsonl`, recentText)
      const manifestText = JSON.stringify({ er: '0.1', generation: gen, thread: c.thread, agent: cfg.agent, at, turns: recent.length, tokenEstimate: est(noteText) + est(recentText), files }, null, 2) + '\n'
      await $.fs.write(`${dir}/MANIFEST.json`, manifestText)
      const manifestSha = await sha256(manifestText)
      c.state.last = { gen, dir, at, manifestSha, mirrored: false }
      c.state.restoreAvailable = false
      await saveState($, c)
      return {
        result: `Checkpoint gen${gen} written: ${dir} — ${recent.length} turns, ~${est(noteText) + est(recentText)} tokens, manifest sha256 ${manifestSha}.\nNow mirror it: copy the whole folder to ${c.cfg.mirrorRoot}/${c.thread}/, verify every file against MANIFEST.json on ${c.cfg.person}'s machine, then call er_mirror_confirmed with that manifest sha256.`,
      }
    } catch (err) {
      return { deny: `er_checkpoint failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_mirror_confirmed' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const cfg = c.cfg
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
      const cfg = c.cfg
      return { result: await dashboard($, c, true) }
    } catch (err) {
      return { deny: `er_status failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_restore' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const cfg = c.cfg
      const latest = await latestGeneration($, c)
      if (!latest) return { result: `Nothing to restore: no checkpoint under ${c.ledgerDir}. If a mirror exists at ${c.cfg.mirrorRoot}/${c.thread}/, restore the newest generation folder into the ledger first — never put an older copy over a newer one — then call er_restore again.` }
      const budget = Number((e as any).budget_tokens) > 0 ? Number((e as any).budget_tokens) : c.cfg.restoreBudgetTokens
      const { note, turns, problems } = await readGeneration($, latest.dir)
      const out: string[] = [`<er restore gen${latest.gen} at ${latest.at}>`]
      let spent = est(out[0])
      if (note) { out.push(note); spent += est(note) }
      const kept: string[] = []
      let dropped = 0
      for (let k = turns.length - 1; k >= 0; k--) {
        const t = turns[k]
        const tools = (t.toolUses ?? []).map((u: any) => `  [${u.tool} → ${u.resultBytes} bytes, sha256 ${String(u.resultSha256).slice(0, 12)}…] ${u.resultStub}`).join('\n')
        const line = `--- gen${String(latest.gen).padStart(4, '0')}:${t.i} ${t.role} ---\n${t.text}${tools ? '\n' + tools : ''}`
        const cost = est(line)
        if (spent + cost > budget) { dropped++; continue }
        kept.unshift(line)
        spent += cost
      }
      out.push(...kept)
      out.push(`</er restore> ${kept.length} of ${turns.length} turns within ~${budget} tokens${dropped ? `; ${dropped} older turns left out — er_recall fetches them by id` : ''}.${problems.length ? '\n' + problems.join('\n') : ''}`)
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
      const cfg = c.cfg
      const query = String((e as any).query ?? '').trim()
      const turnId = String((e as any).turn ?? '').trim()
      if (!(await $.fs.exists(c.ledgerDir))) return { result: 'Nothing has been checkpointed yet.' }
      const dirs = (await $.fs.list(c.ledgerDir)).filter((d: any) => d.kind === 'dir' && /^gen\d{4}-/.test(d.name)).sort((a: any, b: any) => a.name.localeCompare(b.name))
      const hits: string[] = []
      const problems: string[] = []
      for (const d of dirs) {
        const gen = d.name.slice(0, 7)
        const { turns, problems: p } = await readGeneration($, `${c.ledgerDir}/${d.name}`)
        problems.push(...p)
        for (const t of turns) {
          const id = `${gen}:${t.i}`
          if (turnId) { if (id === turnId) hits.push(`--- ${id} ${t.role} ---\n${t.text}\n${JSON.stringify(t.toolUses ?? [], null, 1)}`) }
          else if (query && String(t.text).toLowerCase().includes(query.toLowerCase())) {
            const at = String(t.text).toLowerCase().indexOf(query.toLowerCase())
            hits.push(`${id} ${t.role}: …${String(t.text).slice(Math.max(0, at - 160), at + 240)}…`)
          }
        }
        if (hits.length >= 20) break
      }
      if (!query && !turnId) return { deny: 'Give a query or a turn id (e.g. "gen0003:12").' }
      return { result: (hits.length ? hits.join('\n\n') : 'No match.') + (problems.length ? '\n\n' + problems.join('\n') : '') }
    } catch (err) {
      return { deny: `er_recall failed: ${String(err)}` }
    }
  })
}
