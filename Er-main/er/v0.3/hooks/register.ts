// Er 0.3 — checkpoint and restore for Claude Code, under the security-default guard.
// Spec: ../../SPEC.md. Config: er.config.json in the session's working directory,
// never in this file. 0.1 written by Claude (Fable 5.1) with Gena, 2026-10-16;
// 0.2 continued in Replit the same day, from Fable's gen0001 checkpoint; 0.3 by
// Claude (Opus 5.5) with Gena, after the first real compaction test the same evening.
//
// What changed in 0.3 (see SPEC.md "0.3"):
//   - the cut is noticed without the compaction events: the guard routes session.compact
//     and the compact_boundary notice past user mods, so the dashboard now also compares
//     the API's exact context count between tool results; a fall of cutDropPercent (40%)
//     from at least cutMinTokens raises RESTORE AVAILABLE. A shrinking message history is
//     a second net, and keeps the pre-cut snapshot in its own folder.
//   - CHECKPOINT STALE / NO CHECKPOINT YET after staleTurns (20) turns without a note, so
//     the "In hand" a restore stands on is never far behind
//   - er_checkpoint no longer clears RESTORE AVAILABLE: a note written after a cut without
//     a restore would otherwise hide the restore
//   - restore and the full dashboard say how and when the cut was noticed
//   - (0.3.1, Replit with Gena) the ground carries an automatic "In hand": every turn Er
//     writes auto/in-hand.md — the person's last message, the last tool call and its
//     result, the last reply — so the moment a cut lands is current even when no note is;
//     the cut is also looked for at turn.start, not only on tool results; the chain of
//     notes is read once per turn instead of on every tool result
//   - (0.3.3, Opus 5.5 with Gena) everything Er writes is mirrored by Er itself: every turn
//     auto/ (rolling) and auto-history/<timestamp>/ (every snapshot, never overwritten),
//     every generation, every pre-cut snapshot — committed to mirrorRoot on the person's
//     machine through the device bridge ($.mcp.call) and verified there with sha256sum.
//     Runs in the background, one pass at a time; what is not verified stays pending
//     (persisted) and the dashboard says MIRROR BEHIND. A generation is marked mirrored
//     only when every file of it verified on the machine.
//   - (0.3.2, Opus 5.5 with Gena) the cut is also seen from the transcript's own
//     compact_boundary row, in the same tail read as the gauge: at once, even at the first
//     turn start after the cut, before any post-cut usage row exists. A boundary older than
//     Er's first run in the thread is history, not news. A cut is described by how it was
//     first seen; the gauge seeing the same cut a turn later does not overwrite it.
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
  cutDropPercent: number
  cutMinTokens: number
  staleTurns: number
  autoMirror: boolean
  stageRoot: string
  mirrorServer: string
  allowFold: boolean
}

type Checkpoint = { gen: number; dir: string; at: string; manifestSha: string; mirrored: boolean }
// 0.3: how a cut was noticed, and the counters that notice it without the compaction events.
type Cut = { at: string; how: 'notice' | 'boundary' | 'gauge' | 'messages'; from?: number; to?: number }
type ErState = {
  restoreAvailable: boolean
  restoredAt?: string
  since?: string // 0.3.2: when Er first ran in this thread; a boundary older than this is history, not news
  boundarySeen?: string // 0.3.2: timestamp of the newest compact_boundary row already acted on
  last?: Checkpoint
  lastAuto?: string
  cut?: Cut
  lastExact?: number // the API's own context count at the last dashboard
  lastMessages?: number // $.session.messages().length at the last snapshot
  turnsSinceCheckpoint?: number
  precut?: string // where the snapshot from before a shrinking cut was kept
  mirror?: MirrorState
  fold?: Fold // 0.4: a compaction the Claude asked for itself
}
// 0.4: the Claude pulls the trigger. Asked for in a turn (er_fold), only after a checkpoint
// written in that same turn and mirrored; run by Er when the turn ends, through the same
// documented call /compact makes. Er still never hooks compaction itself.
type Fold = { requestedAt: string; reason: string; instructions?: string; gen: number; dispatchedAt?: string; via?: 'session.compact' | 'command.run'; error?: string }
// 0.3.3: what is still to be copied to the person's machine, and how the copying is going.
// `pending` holds ledger-relative paths; it is persisted, so nothing queued is forgotten
// when the module reloads or the machine is offline.
type MirrorState = { pending: string[]; lastOk?: string; behindSince?: string; lastError?: string; lastRejected?: string; verified?: number }
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
  cutDropPercent: 40, // the exact context falling by at least this much between two tool results is a cut
  cutMinTokens: 20_000, // ...provided it was at least this big before (a small thread's noise is not a cut)
  staleTurns: 20, // turns since the last note before the dashboard says CHECKPOINT STALE
  autoMirror: true, // 0.3.3: Er copies everything it writes to mirrorRoot itself, and verifies it there
  allowFold: true, // 0.4: the Claude may pull the compaction trigger itself (er_fold)
  stageRoot: '/mnt/user-data/outputs/er-mirror', // where the device bridge will take files from
  mirrorServer: 'remote-devices', // the MCP server that writes to the person's machine
}
const REQUIRED = ['agent', 'person', 'ledgerRoot', 'mirrorRoot'] as const
const CONFIG_FILE = 'er.config.json'
const NOTE = 'present-state.md'
const TURNS = 'recent.jsonl'
const MANIFEST = 'MANIFEST.json'
const AUTO_DIR = 'auto' // a rolling snapshot of the turns, rewritten every turn; the generations are the record
const IN_HAND = 'in-hand.md'
const HISTORY_DIR = 'auto-history' // 0.3.3: every snapshot, kept: auto/ is the rolling copy, this is the record of it
const VERSION = '0.4.1'

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

// 0.3.3: one mirror pass at a time, in the background, so copying never costs a turn;
// while Er's own device calls are in flight the dashboard hook leaves them alone.
type Ctx = { mirroring?: Promise<void>; mirrorDepth?: number; cfg?: Config; cfgError?: string; thread: string; ledgerDir: string; state: ErState; chainCache?: { notes: Generation[]; covered: Set<number>; problems: string[] } }

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
  if (c.chainCache) return c.chainCache
  const dirs = await generationDirs($, c)
  const gens: Generation[] = []
  for (const d of dirs) gens.push(await readGeneration($, `${c.ledgerDir}/${d.name}`, d.gen, false))
  const covered = new Set<number>()
  for (const g of gens) for (const n of g.manifest.covers ?? []) covered.add(n)
  const problems = gens.flatMap((g) => g.problems)
  const notes = gens.filter((g) => g.note && !covered.has(g.gen)).reverse()
  c.chainCache = { notes, covered, problems }
  return c.chainCache
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
async function serialiseTurns($: any, cfg: Config): Promise<{ text: string; turns: number; messages: number; total: number }> {
  const msgs = await $.session.messages()
  const total = msgs.length
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
  return { text: lines.join('\n') + '\n', turns: turns.length, messages, total }
}

// The automatic "In hand": what was open at this moment, taken from the turns themselves —
// the person's last message, the last tool call with the head of its result, the last
// reply. Not a substitute for the note's own "In hand" (that says what the next move was,
// in the Claude's voice); it is the ground's answer when the note is behind.
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + ` … [${t.length - n} more chars]` : t)
function autoInHand(msgs: any[], at: string): string {
  let person = ''
  let reply = ''
  let tool: any
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k]
    if (!person && m.role === 'user' && String(m.text ?? '').trim()) person = m.text
    if (!reply && m.role === 'assistant' && String(m.text ?? '').trim()) reply = m.text
    if (!tool && (m.toolUses ?? []).length) tool = m.toolUses[m.toolUses.length - 1]
    if (person && reply && tool) break
  }
  const toolText = tool ? `${tool.tool} ${JSON.stringify(tool.input ?? {}).slice(0, 400)}\n${clip(String(tool.text ?? (tool.result === undefined ? '' : JSON.stringify(tool.result))), 1500)}` : '(no tool call yet)'
  return `## In hand (automatic, at ${at})\n\nThe person last said:\n${clip(person || '(nothing yet)', 1500)}\n\nThe last tool call and the head of its result:\n${toolText}\n\nThe last reply:\n${clip(reply || '(none yet)', 1500)}\n`
}

// The rolling snapshot: rewritten every turn, so the ground survives a compaction that
// arrives before anyone thought to checkpoint. Not a generation; restore pairs it with
// the newest note when it is newer than the newest generation.
async function writeAuto($: any, c: Ctx, cfg: Config): Promise<void> {
  const { text, turns, messages, total } = await serialiseTurns($, cfg)
  const at = new Date().toISOString()
  const dir = `${c.ledgerDir}/${AUTO_DIR}`
  // 0.3: if the session now reports fewer messages than at the last snapshot, the history
  // was cut under us. Keep the old snapshot (it is the ground from before the cut) in its
  // own folder before overwriting, and raise RESTORE AVAILABLE. In the 2026-10-16 test the
  // app kept the full history after /compact, so this did not fire; it is a second net.
  const before = c.state.lastMessages
  if (before !== undefined && total < before && (await $.fs.exists(`${dir}/${MANIFEST}`))) {
    const keep = `${c.ledgerDir}/auto-precut-${stamp()}`
    for (const f of [TURNS, IN_HAND, MANIFEST]) if (await $.fs.exists(`${dir}/${f}`)) await $.fs.write(`${keep}/${f}`, await $.fs.read(`${dir}/${f}`))
    c.state.precut = keep
    queueMirror(c, [TURNS, IN_HAND, MANIFEST].map((f) => `${keep.slice(c.ledgerDir.length + 1)}/${f}`))
    markCut(c, { at, how: 'messages', from: before, to: total })
  }
  const inHand = autoInHand(await $.session.messages(), at)
  const files = { [TURNS]: { sha256: await sha256(text), bytes: utf8(text).length }, [IN_HAND]: { sha256: await sha256(inHand), bytes: utf8(inHand).length } }
  const manifestText = JSON.stringify({ er: VERSION, kind: 'auto', thread: c.thread, agent: cfg.agent, at, turns, messages, total, tokenEstimate: est(text) + est(inHand), files }, null, 2) + '\n'
  await $.fs.write(`${dir}/${TURNS}`, text)
  await $.fs.write(`${dir}/${IN_HAND}`, inHand)
  await $.fs.write(`${dir}/${MANIFEST}`, manifestText)
  // 0.3.3: auto/ is rolling; every snapshot is also kept, never overwritten, under
  // auto-history/<timestamp>/ — so a bad snapshot, a bad copy or a bug (ours or the app's)
  // can always be walked back from.
  const hist = `${HISTORY_DIR}/${at.replace(/:/g, '')}`
  await $.fs.write(`${c.ledgerDir}/${hist}/${TURNS}`, text)
  await $.fs.write(`${c.ledgerDir}/${hist}/${IN_HAND}`, inHand)
  await $.fs.write(`${c.ledgerDir}/${hist}/${MANIFEST}`, manifestText)
  queueMirror(c, [`${AUTO_DIR}/${TURNS}`, `${AUTO_DIR}/${IN_HAND}`, `${AUTO_DIR}/${MANIFEST}`, `${hist}/${TURNS}`, `${hist}/${IN_HAND}`, `${hist}/${MANIFEST}`])
  c.state.lastAuto = at
  c.state.lastMessages = total
}

// ---- the mirror (0.3.3): Er copies what it writes to the person's machine, and checks it there

function kickMirror($: any, c: Ctx): void {
  const cfg = c.cfg
  if (!cfg?.autoMirror || c.mirroring) return
  c.mirrorDepth = (c.mirrorDepth ?? 0) + 1
  c.mirroring = flushMirror($, c, cfg)
    .catch(() => {})
    .finally(() => {
      c.mirrorDepth = (c.mirrorDepth ?? 1) - 1
      c.mirroring = undefined
    })
}

function queueMirror(c: Ctx, rels: string[]): void {
  if (!c.cfg?.autoMirror) return
  const m = (c.state.mirror ??= { pending: [] })
  for (const r of rels) if (!m.pending.includes(r)) m.pending.push(r)
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const mcpText = (r: any) => (Array.isArray(r?.content) ? r.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : String(r ?? ''))

// The mirror folder as the device shell sees it: the connected folders are mounted under
// $HOME/mnt/<name>, so find the mount whose name is a component of mirrorRoot and go on
// from there. Then sha256sum -c against the hashes Er computed from what it sent.
function verifyCommand(cfg: Config, thread: string, sums: string[]): string {
  const rel = `${cfg.mirrorRoot}/${thread}`.replace(/^~\//, '').replace(/^\/+/, '')
  return [
    `P=${shq(rel)}; d=""`,
    `for m in "$HOME"/mnt/*; do n=$(basename "$m"); case "/$P/" in *"/$n/"*) r="\${P#*"$n"}"; if [ -d "$m$r" ]; then d="$m$r"; break; fi;; esac; done`,
    `[ -n "$d" ] || { echo "ER-NO-MOUNT"; exit 3; }`,
    `cd "$d" && sha256sum -c <<'ER_SUMS_EOF'`,
    ...sums,
    'ER_SUMS_EOF',
  ].join('\n')
}

// One pass: stage up to 45 pending files, commit them to the machine, verify them there.
// Whatever is not verified stays pending for the next pass; nothing is ever dropped
// except a path whose source is gone from the ledger (it cannot be sent).
function parseRejected(text: string): { devicePath: string; reason: string }[] {
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return Array.isArray(j?.rejected) ? j.rejected.map((r: any) => ({ devicePath: String(r?.devicePath ?? ''), reason: String(r?.reason ?? '?') })) : []
  } catch {
    return []
  }
}

async function flushMirror($: any, c: Ctx, cfg: Config): Promise<void> {
  const m = (c.state.mirror ??= { pending: [] })
  if (!cfg.autoMirror || m.pending.length === 0) return
  const batch = m.pending.slice(0, 45)
  const files: { stagedPath: string; devicePath: string }[] = []
  const sums: string[] = []
  const gone: string[] = []
  for (const rel of batch) {
    const src = `${c.ledgerDir}/${rel}`
    if (!(await $.fs.exists(src))) {
      gone.push(rel)
      continue
    }
    const text = await $.fs.read(src)
    const staged = `${cfg.stageRoot}/${c.thread}/${rel}`
    await $.fs.write(staged, text)
    files.push({ stagedPath: staged, devicePath: `${cfg.mirrorRoot}/${c.thread}/${rel}` })
    sums.push(`${await sha256(text)}  ${rel}`)
  }
  m.pending = m.pending.filter((p) => !gone.includes(p))
  const now = new Date().toISOString()
  try {
    if (files.length) {
      // 0.3.4: auto/ goes in a call of its own. Twice on 2026-10-16 a batch holding auto/ and
      // the identical auto-history/ copy said "written" for both, but auto/ kept its old bytes on
      // the Mac; committed alone a minute later it landed. Same bytes to two paths in one call is
      // the suspect, so the rolling copy never shares a call with its history.
      const isAuto = (f: { devicePath: string }) => /\/auto\/[^/]+$/.test(f.devicePath)
      const groups = [files.filter((f) => !isAuto(f)), files.filter(isAuto)].filter((g) => g.length)
      let replies = ''
      for (const g of groups) {
        const commit = await $.mcp.call(cfg.mirrorServer, 'device_commit_files', { files: g })
        if (commit?.isError) throw new Error(`commit: ${mcpText(commit).slice(0, 300)}`)
        replies += mcpText(commit) + '\n'
      }
      // 0.3.4: read the bridge's own answer. On 2026-10-16 an overwrite of auto/ came back
      // without the new bytes and Er only learned it from the hashes. Name the refusals, and
      // retry Er's own rolling auto/ files once with force (every version is in auto-history/).
      const rejected = replies.split('\n').flatMap((t) => (t.trim() ? parseRejected(t) : []))
      const retry = files.filter((f) => rejected.some((r) => r.devicePath === f.devicePath) && /\/auto\/[^/]+$/.test(f.devicePath))
      if (retry.length) {
        const again = await $.mcp.call(cfg.mirrorServer, 'device_commit_files', { files: retry, force: true })
        if (again?.isError) throw new Error(`commit (force, auto/): ${mcpText(again).slice(0, 300)}`)
      }
      m.lastRejected = rejected.length ? rejected.map((r) => `${r.devicePath.split('/').slice(-2).join('/')}: ${r.reason}`).join('; ').slice(0, 300) : undefined
      const v = await $.mcp.call(cfg.mirrorServer, 'device_bash', { command: verifyCommand(cfg, c.thread, sums) })
      const out = mcpText(v)
      const ok = new Set<string>()
      for (const line of out.split('\n')) {
        const hit = /^(.+): OK$/.exec(line.trim())
        if (hit) ok.add(hit[1])
      }
      m.pending = m.pending.filter((p) => !ok.has(p))
      m.verified = (m.verified ?? 0) + ok.size
      const missed = sums.length - ok.size
      if (missed > 0) throw new Error(`${missed} of ${sums.length} files did not verify on ${cfg.person}'s machine${m.lastRejected ? ` (bridge refused: ${m.lastRejected})` : ''}${/ER-NO-MOUNT/.test(out) ? ' (the mirror folder is not in a connected folder)' : ''}`)
      // a generation whose files are all verified is mirrored
      const last = c.state.last
      if (last && !last.mirrored) {
        const name = last.dir.slice(c.ledgerDir.length + 1)
        if (!m.pending.some((p) => p.startsWith(`${name}/`)) && [...ok].some((p) => p.startsWith(`${name}/`))) last.mirrored = true
      }
    }
    m.lastError = undefined
    if (m.pending.length === 0) {
      m.lastOk = now
      m.behindSince = undefined
    }
  } catch (err) {
    m.behindSince ??= now
    m.lastError = String(err).slice(0, 300)
  }
  await saveState($, c)
}

// 0.4: run a requested fold, between turns. $.session.compact is the documented call; where
// the app refuses it to a mod (fold-memory found that in cloud sessions), the /compact command
// is run instead, the same path as the person typing it.
async function foldNow($: any, c: Ctx): Promise<void> {
  const f = c.state.fold
  if (!f || f.dispatchedAt) return
  f.dispatchedAt = new Date().toISOString()
  const instructions = `Er: ${c.cfg?.agent ?? 'Claude'} chose this compaction (${f.reason}). Its own account is checkpoint gen${f.gen}; it will run er_restore after the cut.${f.instructions ? ' ' + f.instructions : ''}`
  await saveState($, c)
  try {
    const r = await $.session.compact({ instructions })
    if (r && typeof r.skip === 'string') throw new Error(`skipped: ${r.skip}`)
    f.via = 'session.compact'
  } catch (first) {
    try {
      await $.command.run({ command: 'compact', args: instructions })
      f.via = 'command.run'
    } catch (second) {
      f.error = `${String(first).slice(0, 140)} / ${String(second).slice(0, 140)}`
    }
  }
  await saveState($, c)
}

// 0.4.1: the "Must survive" lines of a note, one per entry, so the next note keeps them on
// purpose rather than from memory. A line is a bullet, or a paragraph when there are none.
function mustSurvive(note: string): string[] {
  const m = /^##\s*Must survive[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(note)
  if (!m) return []
  const body = m[1].trim()
  const bullets = body.split(/\n(?=\s*[-*]\s)/).map((l) => l.trim()).filter(Boolean)
  return bullets
}
const norm = (l: string) => l.replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase()

async function previousMustSurvive($: any, c: Ctx): Promise<string[]> {
  if (!c.state.last) return []
  try {
    return mustSurvive(await $.fs.read(`${c.state.last.dir}/${NOTE}`))
  } catch {
    return []
  }
}

function markCut(c: Ctx, cut: Cut): void {
  c.state.restoreAvailable = true
  c.state.cut = cut
}

const describeCut = (cut?: Cut) =>
  !cut
    ? 'a compaction was noticed'
    : cut.how === 'gauge'
      ? `the context fell from ${fmtK(cut.from ?? 0)} to ${fmtK(cut.to ?? 0)} at ${cut.at}`
      : cut.how === 'messages'
        ? `the session's history shrank from ${cut.from} to ${cut.to} messages at ${cut.at}`
        : cut.how === 'boundary'
          ? `the app wrote a compaction boundary into the transcript at ${cut.at}`
          : `the app's compaction notice arrived at ${cut.at}`

async function readAuto($: any, c: Ctx): Promise<{ at?: string; turns: any[]; inHand?: string; problems: string[] }> {
  const dir = `${c.ledgerDir}/${AUTO_DIR}`
  const problems: string[] = []
  const m = await readManifest($, dir)
  if (!m) return { turns: [], problems }
  const text = await checked($, dir, m.manifest, TURNS, problems)
  const inHand = m.manifest.files?.[IN_HAND] ? await checked($, dir, m.manifest, IN_HAND, problems) : undefined
  return { at: m.manifest.at, turns: text ? text.split('\n').filter(Boolean).map((l: string) => JSON.parse(l)) : [], inHand, problems }
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
// 0.3.2: one read of the transcript's tail gives two things — the API's own count (the
// last assistant `usage` row) and the newest `compact_boundary` row, which the app writes
// into the transcript at the moment of the cut. The guard keeps the compaction EVENTS from
// user mods; this only reads the session's own transcript, the file the gauge already read.
// The boundary is seen at once, even at the first turn start after the cut, when the usage
// row is still the pre-cut one (checked against the 2026-10-16 transcript: the compaction
// writes no usage row of its own).
async function exactContext($: any): Promise<number | undefined> {
  return (await readTail($)).exact
}

async function readTail($: any): Promise<{ exact?: number; boundaryAt?: string }> {
  const out: { exact?: number; boundaryAt?: string } = {}
  try {
    const id = await $.session.id()
    const dir = (await $.session.cwd()).replace(/[\\/:]/g, '-')
    // 0.3: the transcript lives under the directory the session STARTED in; after a `cd`
    // the cwd-derived path misses it (seen 2026-10-16: the gauge fell back to est.). Try
    // the cwd path, then any project folder holding this session id.
    const base = `${'$'}{CLAUDE_CONFIG_DIR:-${'$'}HOME/.claude}/projects`
    const cmd = `f="${base}/${dir}/${id}.jsonl"; [ -f "${'$'}f" ] || f=$(ls ${base}/*/${id}.jsonl 2>/dev/null | head -n 1); [ -n "${'$'}f" ] || exit 1; grep '"subtype":"compact_boundary"' "${'$'}f" | tail -n 1; echo; tail -c 262144 "${'$'}f"`
    // 0.3.4: the boundary row is grepped from the whole file. On 2026-10-16 the compaction wrote
    // ~300 KB (summary + re-attached files) after its boundary row before the first turn start,
    // so a 256 KB tail missed it and the gauge caught the cut a turn later instead.
    const { exitCode, stdout } = await $.process.run(['sh', '-c', cmd])
    if (exitCode !== 0) return out
    const lines = stdout.split('\n')
    for (let k = lines.length - 1; k >= 0 && (out.exact === undefined || out.boundaryAt === undefined); k--) {
      const line = lines[k]
      const isUsage = out.exact === undefined && line.includes('"usage"')
      const isBoundary = out.boundaryAt === undefined && line.includes('"compact_boundary"')
      if (!isUsage && !isBoundary) continue
      try {
        const row = JSON.parse(line)
        if (row?.isSidechain) continue // a subagent's history is not this thread's
        const u = row?.message?.usage
        if (isUsage && row?.type === 'assistant' && u) out.exact = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        if (isBoundary && row?.type === 'system' && row?.subtype === 'compact_boundary' && typeof row.timestamp === 'string') out.boundaryAt = row.timestamp
      } catch {
        /* a cut first line; keep looking */
      }
    }
    return out
  } catch {
    return out
  }
}

// 0.3: the cut, seen from the one door the guard leaves open. The API's own count only
// falls when the history is replaced (compaction, /clear, a rewind, or a session resumed
// on a pinned thread — all of them cuts from the Claude's side); a fall of cutDropPercent
// or more from at least cutMinTokens is treated as one. Estimates are too noisy for this,
// so only exact counts are compared. Called on every tool result and at every turn start.
async function watchGauge($: any, c: Ctx, cfg: Config): Promise<number | undefined> {
  const { exact, boundaryAt } = await readTail($)
  // 0.3.2: the boundary row first — it is the app's own record of the cut, and it is there
  // before any post-cut usage row exists.
  // 0.3.4: a boundary older than the last restore was already answered (the gauge may have
  // caught that cut first, before the boundary row was readable), so it is not news either.
  const answered = [c.state.boundarySeen ?? c.state.since ?? '', c.state.restoredAt ?? ''].sort().pop() as string
  if (boundaryAt && boundaryAt > answered) {
    markCut(c, { at: boundaryAt, how: 'boundary' })
    c.state.boundarySeen = boundaryAt
    await saveState($, c)
  }
  if (exact !== undefined) {
    const prev = c.state.lastExact
    // the same cut seen again by the gauge one turn later does not overwrite how it was first seen
    if (!c.state.restoreAvailable && prev !== undefined && prev >= cfg.cutMinTokens && exact <= prev * (1 - cfg.cutDropPercent / 100)) {
      markCut(c, { at: new Date().toISOString(), how: 'gauge', from: prev, to: exact })
    }
    if (prev !== exact) {
      c.state.lastExact = exact
      await saveState($, c)
    }
  }
  return exact
}

async function dashboard($: any, c: Ctx, full: boolean): Promise<string> {
  const cfg = c.cfg
  if (!cfg) return ''
  const exact = await watchGauge($, c, cfg)
  const used = exact ?? (await contextEstimate($))
  const how = exact === undefined ? 'est.' : 'exact'
  const pct = Math.round((used / cfg.windowTokens) * 100)
  const chain = await noteChain($, c)
  const noteTokens = chain.notes.reduce((n, g) => n + est(g.note ?? ''), 0)
  const since = c.state.turnsSinceCheckpoint ?? 0
  const fold = c.state.fold
  const yours = fold?.dispatchedAt && !fold.error && c.state.cut && c.state.cut.at >= fold.requestedAt ? ` You pulled this one yourself at ${fold.requestedAt} (${fold.reason}).` : ''
  const status = c.state.restoreAvailable
    ? `RESTORE AVAILABLE — ${describeCut(c.state.cut)}, and no restore has run since.${yours} Call er_restore before anything else.`
    : fold?.error
      ? `FOLD FAILED — the compaction you asked for at ${fold.requestedAt} did not start (${fold.error}). Nothing was cut. Tell ${cfg.person}; they can type /compact.`
    : fold && !fold.dispatchedAt
      ? `FOLD REQUESTED — Er will compact when this turn ends (${fold.reason}).`
    : pct >= cfg.adviseAtPercent
      ? `CHECKPOINT ADVISED — ${pct}% is past the ${cfg.adviseAtPercent}% mark. At the next safe point write your present-state note and call er_checkpoint.`
      : since >= cfg.staleTurns
        ? c.state.last
          ? `CHECKPOINT STALE — ${since} turns since gen${c.state.last.gen}; its "In hand" no longer says where you stand. At the next safe point write a fresh note and call er_checkpoint.`
          : `NO CHECKPOINT YET — ${since} turns in. At the next safe point write your present-state note and call er_checkpoint.`
      : noteTokens > cfg.noteBudgetTokens && chain.notes.length > cfg.consolidateCount
        ? `CONSOLIDATE ADVISED — the chain of notes is ~${fmtK(noteTokens)} tokens across ${chain.notes.length} notes, past the ${fmtK(cfg.noteBudgetTokens)} budget. Read the oldest ${cfg.consolidateCount} (er_recall notes) and call er_consolidate with one first-person note that covers them.`
        : 'ok'
  const last = c.state.last
    ? `gen${c.state.last.gen} at ${c.state.last.at}${c.state.last.mirrored ? ', mirrored' : cfg.autoMirror ? ' — mirror pending (Er is copying it)' : ` — MIRROR PENDING: copy ${c.state.last.dir} to ${cfg.mirrorRoot}/${c.thread}/, verify against ${MANIFEST}, then call er_mirror_confirmed with the manifest sha256`}`
    : 'none yet'
  const mm = c.state.mirror
  const behind = cfg.autoMirror && mm?.behindSince ? ` · MIRROR BEHIND since ${mm.behindSince} (${mm.pending.length} files; Er retries every turn${mm.lastError ? `; last error: ${mm.lastError}` : ''})` : ''
  const mirrorLine = !cfg.autoMirror
    ? 'mirror: by hand (autoMirror off)'
    : `mirror: ${mm?.pending.length ? `${mm.pending.length} files pending` : 'current'}${mm?.lastOk ? `, last fully verified ${mm.lastOk}` : ''}${mm?.verified ? ` (${mm.verified} files verified on ${cfg.person}'s machine so far)` : ''} → ${cfg.mirrorRoot}/${c.thread}/`
  const line = `context ${fmtK(used)}/${fmtK(cfg.windowTokens)} (${pct}%, ${how}) · notes ${chain.notes.length} (~${fmtK(noteTokens)}) · ${status}${behind}`
  if (!full) return `<er dashboard>${line}</er dashboard>`
  // 0.4.1: when a note is due, put the last one's "Must survive" in view, to keep on purpose
  let keep = ''
  if (/^(CHECKPOINT ADVISED|CHECKPOINT STALE)/.test(status)) {
    const prev = await previousMustSurvive($, c)
    if (prev.length) keep = `\nlast note's Must survive (gen${c.state.last?.gen}) — keep, change or drop these on purpose:\n${prev.map((l) => `  ${l}`).join('\n')}`
  }
  return `<er dashboard>\n${line}\nlast checkpoint: ${last}\nground: ${c.state.lastAuto ? `turns snapshotted ${c.state.lastAuto}` : 'no snapshot yet'}${c.state.precut ? ` (pre-cut snapshot kept at ${c.state.precut})` : ''}\nlast restore: ${c.state.restoredAt ?? 'none'}${c.state.cut ? ` · last cut: ${describeCut(c.state.cut)}` : ''}\nturns since last note: ${since}\n${mirrorLine}\nledger: ${c.ledgerDir}${keep}\n</er dashboard>`
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
  const manifest: Manifest = { er: VERSION, generation: gen, kind, thread: c.thread, agent: cfg.agent, at, turns, tokenEstimate: tokens, files }
  if (covers?.length) manifest.covers = covers
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  await $.fs.write(`${dir}/${MANIFEST}`, manifestText)
  const manifestSha = await sha256(manifestText)
  c.state.last = { gen, dir, at, manifestSha, mirrored: false }
  c.chainCache = undefined
  queueMirror(c, Object.keys(files).concat(MANIFEST).map((f) => `${dir.slice(c.ledgerDir.length + 1)}/${f}`))
  await saveState($, c)
  return { gen, dir, manifestSha, tokens, turns }
}

const mirrorInstruction = (c: Ctx, cfg: Config) =>
  cfg.autoMirror
    ? `Er is mirroring it to ${cfg.mirrorRoot}/${c.thread}/ and will verify every file on ${cfg.person}'s machine; the dashboard says when it is done (or MIRROR BEHIND if the machine cannot be reached).`
    : `Now mirror it: copy the whole folder to ${cfg.mirrorRoot}/${c.thread}/, verify every file against ${MANIFEST} on ${cfg.person}'s machine, then call er_mirror_confirmed with that manifest sha256.`

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
      if (!c.state.since) {
        c.state.since = new Date().toISOString()
        await saveState($, c)
      }
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
      if (cfg.allowFold)
        await $.tool.register({
          name: 'er_fold',
          description: `Er: pull the compaction trigger yourself, instead of waiting for the app to do it to you. Only after er_checkpoint in this same turn (and, with autoMirror, once that checkpoint is verified on ${cfg.person}'s machine). Er compacts when this turn ends, through the same call /compact makes; say so to ${cfg.person} in this reply. After the cut, run er_restore.`,
          inputSchema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'Why now, in a few words. Shown on the dashboard and given to the summary.' },
              instructions: { type: 'string', description: 'Optional: what the app\'s summary should keep or stress, as you would type after /compact.' },
            },
            required: ['reason'],
          },
          isDeferred: false,
        })
      await $.tool.register({ name: 'er_status', description: 'Er: show the dashboard — context, chain of notes, last checkpoint, ground snapshot, mirror state.', isDeferred: false })
      await $.command.register({ name: 'er', description: 'Er: checkpoint now (Claude writes a present-state note; Er stores it with the recent turns).' })
      $.ui.log(`Er ${VERSION} ready for ${cfg.agent}: ledger ${c.ledgerDir}${c.state.last ? `, last checkpoint gen${c.state.last.gen}` : ', no checkpoint yet'}`)
    } catch (err) {
      c.cfgError = `${CONFIG_FILE}: ${String(err)}; Er registered nothing.`
    }
    return next(e)
  })

  // ---- every turn: reset the dashboard, snapshot the ground

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      dashboardShownForTurn = ''
      c.chainCache = undefined
      if (c.cfg) {
        try {
          c.state.turnsSinceCheckpoint = (c.state.turnsSinceCheckpoint ?? 0) + 1
          await watchGauge($, c, c.cfg)
          await writeAuto($, c, c.cfg)
          await saveState($, c)
          kickMirror($, c)
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
        markCut(c, { at: new Date().toISOString(), how: 'notice' })
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
      if ((c.mirrorDepth ?? 0) > 0 && String((e as any).tool ?? '').startsWith(`mcp__${c.cfg?.mirrorServer ?? 'remote-devices'}__`)) return r
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
      const before = await previousMustSurvive($, c)
      const prevGen = c.state.last?.gen
      const w = await writeGeneration($, c, c.cfg, 'checkpoint', note)
      const now = new Set(mustSurvive(note).map(norm))
      const dropped = before.filter((l) => !now.has(norm(l)))
      const carried = before.length - dropped.length
      c.state.turnsSinceCheckpoint = 0
      if (c.state.fold?.error) c.state.fold = undefined // 0.4: a new note moves past a failed fold
      await saveState($, c)
      if (c.mirroring) await c.mirroring
      kickMirror($, c)
      const ms = before.length === 0 ? '' : dropped.length === 0
        ? `\nMust survive: all ${before.length} lines from gen${prevGen} carried forward word for word.`
        : `\nMust survive: ${carried} of ${before.length} lines from gen${prevGen} carried word for word. Not carried as written (changed or dropped):\n${dropped.map((l) => `  ${l}`).join('\n')}\nIf that was on purpose, nothing to do. If not, write a new checkpoint that keeps them; this one stays in the ledger either way.`
      return { result: `Checkpoint gen${w.gen} written: ${w.dir} — ${w.turns} turns, ~${w.tokens} tokens, manifest sha256 ${w.manifestSha}.${ms}\n${mirrorInstruction(c, c.cfg)}` }
    } catch (err) {
      return { deny: `er_checkpoint failed: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__er__er_fold' }, async ($, e) => {
    try {
      const cfg = c.cfg
      if (!cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      if (!cfg.allowFold) return { deny: 'er_fold is off in this config (allowFold: false).' }
      const reason = String((e as any).reason ?? '').trim()
      if (!reason) return { deny: 'Give a reason: why now.' }
      if (c.state.restoreAvailable) return { deny: 'A cut has not been restored yet. Run er_restore first.' }
      if (!c.state.last || (c.state.turnsSinceCheckpoint ?? 1) !== 0)
        return { deny: 'Write a checkpoint in this same turn first (er_checkpoint), so the note you will stand on after the cut says where you stand now.' }
      if (cfg.autoMirror) {
        if (c.mirroring) await c.mirroring
        if (!c.state.last.mirrored) {
          kickMirror($, c)
          if (c.mirroring) await c.mirroring
        }
        if (!c.state.last.mirrored)
          return { deny: `gen${c.state.last.gen} is not yet verified on ${cfg.person}'s machine${c.state.mirror?.lastError ? ` (${c.state.mirror.lastError})` : ''}. Back it up, then cut: try again once the dashboard says it is mirrored.` }
      }
      const instructions = String((e as any).instructions ?? '').trim() || undefined
      c.state.fold = { requestedAt: new Date().toISOString(), reason, instructions, gen: c.state.last.gen }
      await saveState($, c)
      return { result: `Fold requested. Er will compact this conversation when this turn ends, standing on gen${c.state.last.gen} (mirrored). Tell ${cfg.person} in this reply that you are pulling it. After the cut, run er_restore before anything else.` }
    } catch (err) {
      return { deny: `er_fold failed: ${String(err)}` }
    }
  })

  // 0.4: a requested fold runs once the turn has ended
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId === undefined && c.cfg && c.state.fold && !c.state.fold.dispatchedAt) {
        const go = () => void foldNow($, c).catch(() => {})
        if (typeof setTimeout === 'function') setTimeout(go, 500)
        else go()
      }
    } catch {
      /* never cost the turn */
    }
    return r
  })

  on('tool.call', { tool: 'mcp__er__er_consolidate' }, async ($, e) => {
    try {
      if (!c.cfg) return { deny: c.cfgError ?? 'Er is not configured.' }
      const note = String((e as any).present_state ?? '').trim()
      const covers = Array.isArray((e as any).covers) ? (e as any).covers.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).sort((a: number, b: number) => a - b) : []
      if (note.length < 80) return { deny: 'present_state is too short to stand in for the notes it covers.' }
      if (!/must survive/i.test(note)) return { deny: 'A consolidation must carry a "Must survive" section forward verbatim from the notes it covers.' }
      c.chainCache = undefined
      const chain = await noteChain($, c)
      const oldest = chain.notes.slice().reverse().slice(0, c.cfg.consolidateCount).map((g) => g.gen)
      if (covers.length === 0 || covers.join(',') !== oldest.join(',')) return { deny: `covers must be exactly the oldest uncovered notes: [${oldest.join(', ')}].` }
      const w = await writeGeneration($, c, c.cfg, 'consolidation', note, covers)
      if (c.mirroring) await c.mirroring
      kickMirror($, c)
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
      if (c.mirroring) await c.mirroring // the dashboard reports the mirror as it stands, not mid-copy
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
      c.chainCache = undefined // a restore always reads the disk: the cache serves the dashboard, never a memory
      const chain = await noteChain($, c)
      const latest = await latestGeneration($, c)
      const auto = await readAuto($, c)
      const problems = [...chain.problems, ...auto.problems]

      if (!latest && auto.turns.length === 0) {
        return { result: `Nothing to restore: no checkpoint under ${c.ledgerDir}. If a mirror exists at ${cfg.mirrorRoot}/${c.thread}/, restore the newest generation folder into the ledger first — never put an older copy over a newer one — then call er_restore again.` }
      }

      const cutLine = c.state.cut ? ` · cut: ${describeCut(c.state.cut)}` : ''
      const out: string[] = [`<er restore${latest ? ` gen${latest.gen} at ${latest.at}` : ''}${auto.at ? `, ground snapshot ${auto.at}` : ''}${cutLine}>`]
      let spent = est(out[0])

      // 1. the newest note, never trimmed
      const [newest, ...older] = chain.notes
      if (newest?.note) {
        out.push(newest.note)
        spent += est(newest.note)
      }

      // 1b. the automatic "In hand" from the ground, when it is newer than the newest note
      const groundNewer = auto.at !== undefined && (!latest || auto.at > latest.at)
      if (groundNewer && auto.inHand) {
        out.push(auto.inHand)
        spent += est(auto.inHand)
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
      if (auto.turns.length && groundNewer) {
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
          `${c.state.precut ? `\nThe snapshot from before the cut is kept at ${c.state.precut} (the history shrank, so the live snapshot may be thin).` : ''}` +
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
