// Offline harness for Er 0.4.3 (0.2's checks, plus the 0.3 cut detection and staleness): fakes the parts of the Claude Code mod API Er uses
// ($.fs, $.session, $.process, $.tool, $.command, $.ui) against a temp directory, then
// runs: auto snapshot → checkpoint → "compaction" → restore → six more checkpoints →
// consolidation → restore. Run with: node test/harness.mjs (after building register.ts
// to /tmp/er.mjs with esbuild; see test/run.sh).
import { register } from '/tmp/er.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'er-'))
const cwd = path.join(root, 'work')
await fs.mkdir(cwd, { recursive: true })
await fs.writeFile(path.join(cwd, 'er.config.json'), JSON.stringify({
  agent: 'Claude (Test 0.3)', person: 'Gena', ledgerRoot: path.join(root, 'ledger'), mirrorRoot: `${root}/Desktop/Test 0.3/er/ledger`, stageRoot: path.join(root, 'outputs'),
  pinnedThread: '', recentTurns: 4, fullResultTurns: 2, fullResultBytes: 5000, noteBudgetTokens: 300, consolidateCount: 3, restoreBudgetTokens: 4000,
}))

const messages = []
const say = (role, text, toolUses = []) => messages.push({ role, text, toolUses })

const $ = {
  fs: {
    exists: async (p) => fs.access(abs(p)).then(() => true, () => false),
    read: async (p) => fs.readFile(abs(p), 'utf8'),
    write: async (p, t) => { await fs.mkdir(path.dirname(abs(p)), { recursive: true }); await fs.writeFile(abs(p), t) },
    list: async (p) => (await fs.readdir(abs(p), { withFileTypes: true })).map((d) => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' })),
  },
  session: { id: async () => 'thread-1', cwd: async () => cwd, messages: async () => messages, compact: async (a) => { compacts.push(['session.compact', a]); if (sessionCompactRefuses) throw new Error('not from a mod here'); return { messages: [] } } },
  process: { run: async () => ({ exitCode: 1, stdout: '' }) },
  tool: { register: async (t) => tools.push(t.name) },
  command: { register: async () => {}, run: async (a) => { compacts.push(['command.run', a]); if (commandRefuses) throw new Error('no') } },
  ui: { log: (s) => console.log('[ui]', s) },
  // 0.3.3: a fake device bridge — commit copies staged files to the "machine"; bash runs the
  // verification by checking the sums Er sent against what landed. `offline` makes it fail.
  // 0.4.2: Er waits with a limit, on this clock
  clock: { sleep: (ms) => new Promise((r) => { setTimeout(r, ms) }) },
  mcp: {
    call: async (server, tool, args) => {
      mcpCalls.push(tool)
      // 0.4.2: Er's self-test calls its own er_status through the app
      if (server === 'er') {
        if (selfTestForbidden) throw new Error('a mod may not call its own server')
        if (handlerMissing) return { isError: true, content: [{ type: 'text', text: 'er registered the tool er_status but no tool.call hook answered this call' }] }
        return { content: [{ type: 'text', text: '<er dashboard>\ncontext 1K' }] }
      }
      if (offline) throw new Error('device offline')
      // 0.4.2: the fold's connection probe
      if (tool === 'device_bash' && args.command === 'echo er-probe') {
        if (probeFails) throw new Error('bridge dropped')
        if (probeHangs) return new Promise(() => {})
        return { content: [{ type: 'text', text: 'er-probe' }] }
      }
      assert.equal(server, 'remote-devices')
      if (tool === 'device_commit_files') {
        const written = [], rejected = []
        // the suspected bridge fault: identical bytes to two paths in one call; an overwrite
        // among them reports "written" but keeps its old bytes
        const seen = new Set()
        if (sameBatchFault) for (const f of args.files) if (!/\/auto\//.test(f.devicePath)) seen.add(await fs.readFile(f.stagedPath, 'utf8'))
        for (const f of args.files) {
          assert.ok(f.stagedPath.startsWith(path.join(root, 'outputs')), 'Er commits only from its staging folder')
          const exists = await fs.access(f.devicePath).then(() => true, () => false)
          if (refuseOverwrite && exists && !args.force) { rejected.push({ devicePath: f.devicePath, reason: 'mtime drift' }); continue }
          await fs.mkdir(path.dirname(f.devicePath), { recursive: true })
          if (!(sameBatchFault && exists && seen.has(await fs.readFile(f.stagedPath, 'utf8')))) await fs.copyFile(f.stagedPath, f.devicePath)
          written.push(f.devicePath)
        }
        if (args.force) forced.push(...args.files.map((f) => f.devicePath))
        return { content: [{ type: 'text', text: JSON.stringify({ written, rejected }) }] }
      }
      if (tool === 'device_bash') {
        const dir = `${root}/Desktop/Test 0.3/er/ledger/thread-1`
        // 0.4.3: Er reads a file back from the machine to repair the ledger
        const cat = /\ncat "\$d"\/'(.+)'$/.exec(args.command)
        if (cat) {
          catCalls.push(cat[1])
          const rel = cat[1].replace(/'\\''/g, "'")
          const text = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => undefined)
          if (text === undefined) return { isError: true, content: [{ type: 'text', text: 'cat: no such file' }] }
          return { content: [{ type: 'text', text: mirrorCorrupt ? text + 'bad' : bridgeTrims ? text.replace(/\n$/, '') : text }] }
        }
        const body = args.command.split("<<'ER_SUMS_EOF'\n")[1].split('\nER_SUMS_EOF')[0]
        const lines = []
        for (const l of body.split('\n')) {
          const [sum, rel] = [l.slice(0, 64), l.slice(66)]
          const got = await fs.readFile(path.join(dir, rel)).then((b) => crypto.createHash('sha256').update(b).digest('hex'), () => '')
          lines.push(`${rel}: ${got === sum && !corrupt ? 'OK' : 'FAILED'}`)
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      throw new Error('unexpected tool ' + tool)
    },
  },
}
let offline = false
let probeFails = false
let probeHangs = false
let handlerMissing = false
let refuseOverwrite = false
const compacts = []
let sessionCompactRefuses = false
let commandRefuses = false
let sameBatchFault = false
const forced = []
let corrupt = false
let mirrorCorrupt = false
let bridgeTrims = false
let selfTestForbidden = false
const catCalls = []
const mcpCalls = []
const abs = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p))
const tools = []

const handlers = []
register((ev, a, b) => { handlers.push(typeof a === 'function' ? { ev, fn: a } : { ev, filter: a, fn: b }); return { catch() {} } })
const fire = async (ev, e, filter) => {
  for (const h of handlers) {
    if (h.ev !== ev) continue
    if (h.filter && filter && JSON.stringify(h.filter) !== JSON.stringify(filter)) continue
    if (h.filter && !filter) continue
    if (!h.filter && filter) continue
    return h.fn($, e, async (x) => ({ ...x, next: true }))
  }
}
const call = (tool, input) => fire('tool.call', { ...input, tool_use_id: 'x' }, { tool: `mcp__er__${tool}` })
const bigResult = 'R'.repeat(3000)
// 0.4.3: a restore is not done until its receipt is echoed back
const restore = async (input = {}) => {
  const r = await call('er_restore', input)
  const code = /receipt: (er-rst-[0-9a-f]+)/.exec(r.result ?? '')?.[1]
  assert.ok(code, 'every restore ends with a receipt')
  const c = await call('er_restored', { receipt: code })
  assert.match(c.result ?? c.deny, /Restore confirmed/)
  return r
}

await fire('session.start', {})
assert.deepEqual(tools, ['er_checkpoint', 'er_restore', 'er_recall', 'er_consolidate', 'er_mirror_confirmed', 'er_fold', 'er_restored', 'er_status'])

// a few turns of conversation with tool traffic
for (let t = 1; t <= 6; t++) {
  say('user', `question ${t}`)
  say('assistant', '', [{ tool: 'Bash', input: { command: `cmd ${t}` }, text: `${bigResult} result ${t}` }])
  say('user', '') // the tool-result message
  say('assistant', `answer ${t}`)
  await fire('turn.start', {})
}
let auto = JSON.parse(await $.fs.read(`${root}/ledger/thread-1/auto/MANIFEST.json`))
assert.equal(auto.turns, 4, 'recentTurns counts real turns')
const autoRows = (await $.fs.read(`${root}/ledger/thread-1/auto/recent.jsonl`)).trim().split('\n').map(JSON.parse)
const withFull = autoRows.filter((r) => r.toolUses.some((u) => u.result !== undefined)).map((r) => r.turn)
assert.deepEqual([...new Set(withFull)], [3], 'only the newest results fit the byte cap (one 3000-byte result in 5000)')

// checkpoint without "In hand" is refused; with it, written
let r = await call('er_checkpoint', { present_state: '## Must survive\nI am the test Claude.\n## Context\n' + 'x'.repeat(100) })
assert.match(r.deny, /In hand/)
r = await call('er_checkpoint', { present_state: '## Must survive\nI am the test Claude; we decided A because B.\n## Context\n' + 'x'.repeat(100) + '\n## In hand\nquestion 6, about to answer.' })
assert.match(r.result, /Checkpoint gen1 written/)
const gen1 = r.result.match(/manifest sha256 ([0-9a-f]+)/)[1]

// mirror: stale hash refused, right hash accepted
assert.match((await call('er_mirror_confirmed', { manifest_sha256: 'deadbeef' })).deny, /not the latest/)
assert.match((await call('er_mirror_confirmed', { manifest_sha256: gen1, method: 'test' })).result, /Mirror confirmed/)

// more turns after the checkpoint, then a compaction notice
say('user', 'question 7'); say('assistant', 'answer 7 — the thing in hand now')
await fire('turn.start', {})
await fire('session.append', { message: { name: 'compact_boundary' } }, { door: 'notice' })
let dash = (await call('er_status', {})).result
assert.match(dash, /RESTORE AVAILABLE/)

// restore: note first, then the automatic In hand from the ground, then the turns with full results
r = await call('er_restore', {})
// 0.4.3: a restore is confirmed, not assumed
assert.match(r.result, /\nreceipt: er-rst-[0-9a-f]{10} — /, 'the receipt is the last line')
assert.match((await call('er_status', {})).result, /RESTORE UNCONFIRMED/)
assert.match((await call('er_restored', { receipt: 'er-rst-0000000000' })).deny, /not the receipt/)
assert.match((await call('er_restored', { receipt: r.result.match(/receipt: (er-rst-[0-9a-f]+)/)[1] })).result, /Restore confirmed/)
assert.match((await call('er_restored', { receipt: 'er-rst-0000000000' })).deny, /No restore is waiting/)
assert.match(r.result, /## In hand\nquestion 6/)
assert.match(r.result, /## In hand \(automatic, at .*\)\n\nThe person last said:\nquestion 7/, 'automatic In hand rides the restore when the ground is newer than the note')
assert.match(r.result, /The last reply:\nanswer 7/)
const autoM = JSON.parse(await $.fs.read(`${root}/ledger/thread-1/auto/MANIFEST.json`))
assert.ok(autoM.files['in-hand.md'].sha256, 'in-hand.md is in the auto manifest')
assert.match(r.result, /ground snapshot/)
assert.match(r.result, /answer 7 — the thing in hand now/)
assert.match(r.result, /RRRR/, 'full tool result restored')
dash = (await call('er_status', {})).result
assert.doesNotMatch(dash, /RESTORE AVAILABLE/)

// six more checkpoints → the chain passes the note budget → CONSOLIDATE ADVISED
for (let n = 2; n <= 7; n++) {
  say('user', `q${n}`); say('assistant', `a${n}`)
  await fire('turn.start', {})
  r = await call('er_checkpoint', { present_state: `## Must survive\nnote ${n} keeps this.\n## Context\n${'c'.repeat(300)}\n## In hand\nq${n}` })
  assert.match(r.result, new RegExp(`gen${n} written`))
}
dash = (await call('er_status', {})).result
assert.match(dash, /CONSOLIDATE ADVISED/)
assert.match(dash, /notes 7/)

// consolidate: wrong covers refused; right covers accepted; chain shrinks; originals still readable
r = await call('er_consolidate', { present_state: '## Must survive\nnote 1 keeps this. note 2 keeps this. note 3 keeps this.\n## Context\n' + 'z'.repeat(100), covers: [2, 3, 4] })
assert.match(r.deny, /\[1, 2, 3\]/)
r = await call('er_consolidate', { present_state: '## Must survive\nI am the test Claude; we decided A because B. note 2 keeps this. note 3 keeps this.\n## Context\n' + 'z'.repeat(100), covers: [1, 2, 3] })
assert.match(r.result, /Consolidation gen8 written.*covers gen0001, gen0002, gen0003/)
dash = (await call('er_status', {})).result
assert.match(dash, /notes 5/)
r = await call('er_recall', { note: 'gen0001' })
assert.match(r.result, /question 6, about to answer/)
r = await restore()
assert.match(r.result, /Consolidated present state \(covers gen0001, gen0002, gen0003\)/)
assert.doesNotMatch(r.result, /## In hand\nq3\b/, 'covered note not read directly')
assert.match(r.result, /## In hand\nq7/)
r = await call('er_recall', { query: 'result 6' })
assert.match(r.result, /gen0001:/)

// ---- 0.3: the cut, noticed without the compaction events (the guard hides them)
let exact
$.process.run = async () =>
  exact === undefined
    ? { exitCode: 1, stdout: '' }
    : { exitCode: 0, stdout: 'cut first line\n' + JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: exact - 10, cache_creation_input_tokens: 0 } } }) + '\n' }
const status = async () => (await call('er_status', {})).result
// a small thread's noise is not a cut
exact = 15000; await status()
exact = 5000
assert.doesNotMatch(await status(), /RESTORE AVAILABLE/)
exact = 300000
dash = await status()
assert.match(dash, /300K\/\S+ \(\d+%, exact\)/)
assert.doesNotMatch(dash, /RESTORE AVAILABLE/)
exact = 250000 // a 17% fall is not a cut
assert.doesNotMatch(await status(), /RESTORE AVAILABLE/)
exact = 110000 // a 56% fall is
dash = await status()
assert.match(dash, /RESTORE AVAILABLE — the context fell from 250K to 110K/)
// a checkpoint written after the cut does not hide the restore
r = await call('er_checkpoint', { present_state: '## Must survive\nnote 9 keeps this.\n## Context\n' + 'k'.repeat(100) + '\n## In hand\nwriting after the cut' })
assert.match(r.result, /gen9 written/)
assert.match(await status(), /RESTORE AVAILABLE/)
r = await restore()
assert.match(r.result, /cut: the context fell from 250K to 110K/)
dash = await status()
assert.doesNotMatch(dash, /RESTORE AVAILABLE/)
assert.match(dash, /last cut: the context fell/)
exact = undefined // estimates never trigger it
assert.doesNotMatch(await status(), /RESTORE AVAILABLE/)

// the second net: the session's history shrinks under us; the old snapshot is kept
const beforeCut = await $.fs.read(`${root}/ledger/thread-1/auto/recent.jsonl`)
messages.splice(0, messages.length - 2)
say('user', 'after the cut'); say('assistant', 'reply after the cut')
await fire('turn.start', {})
dash = await status()
assert.match(dash, /RESTORE AVAILABLE — the session's history shrank from \d+ to 4 messages/)
const pre = (await $.fs.list(`${root}/ledger/thread-1`)).find((d) => d.name.startsWith('auto-precut-'))
assert.ok(pre, 'pre-cut snapshot kept')
assert.equal(await $.fs.read(`${root}/ledger/thread-1/${pre.name}/recent.jsonl`), beforeCut, 'pre-cut snapshot is the old ground, byte for byte')
r = await restore()
assert.match(r.result, /snapshot from before the cut is kept at .*auto-precut-/)

// the gauge is watched at turn start too, not only on tool results (the prose gap)
exact = 400000; await status()
exact = 120000
say('user', 'prose after a cut'); say('assistant', 'a prose reply, no tool call')
await fire('turn.start', {})
const st = JSON.parse(await $.fs.read(`${root}/ledger/thread-1/state.json`))
assert.equal(st.restoreAvailable, true, 'cut noticed at turn.start without any tool result')
assert.equal(st.cut.how, 'gauge')
// 0.4.3: a restore left unconfirmed is treated as not having happened
await call('er_restore', {})
say('user', 'u1'); say('assistant', 'u1'); await fire('turn.start', {})
assert.match(await status(), /RESTORE UNCONFIRMED/)
say('user', 'u2'); say('assistant', 'u2'); await fire('turn.start', {})
assert.match(await status(), /RESTORE AVAILABLE — .*A restore sent at .* was never confirmed/)
await restore()
assert.doesNotMatch(await status(), /RESTORE (AVAILABLE|UNCONFIRMED)/)

// 0.3.2: the transcript's own compact_boundary row, read in the same tail as the gauge
let boundary, sidechain = false
$.process.run = async () => {
  if (exact === undefined && boundary === undefined) return { exitCode: 1, stdout: '' }
  let out = 'cut first line\n'
  if (boundary !== undefined) out += JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: boundary, isSidechain: sidechain || undefined }) + '\n'
  if (exact !== undefined) out += JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: exact - 10, cache_creation_input_tokens: 0 } } }) + '\n'
  return { exitCode: 0, stdout: out }
}
const state = async () => JSON.parse(await $.fs.read(`${root}/ledger/thread-1/state.json`))
assert.ok((await state()).since, 'Er records when it first ran in the thread')
boundary = '2000-01-01T00:00:00.000Z' // older than Er's first run: history, not news
say('user', 'b1'); say('assistant', 'b1'); await fire('turn.start', {})
assert.equal((await state()).restoreAvailable, false, 'an old boundary is not a new cut')
boundary = new Date(Date.now() + 1000).toISOString(); sidechain = true // a subagent's boundary
say('user', 'b2'); say('assistant', 'b2'); await fire('turn.start', {})
assert.equal((await state()).restoreAvailable, false, "a subagent's boundary is not this thread's cut")
sidechain = false // the real thing, at the first turn start after the cut, before any post-cut usage row
say('user', 'b3'); await fire('turn.start', {})
let s3 = await state()
assert.equal(s3.restoreAvailable, true, 'boundary seen at the first turn start, with the usage row unchanged')
assert.equal(s3.cut.how, 'boundary')
exact = 30000 // the gauge sees the same cut a turn later; it does not overwrite how it was first seen
dash = await status()
assert.match(dash, /RESTORE AVAILABLE — the app wrote a compaction boundary into the transcript at /)
r = await restore()
assert.match(r.result, /cut: the app wrote a compaction boundary/)
say('assistant', 'b3'); say('user', 'b4'); await fire('turn.start', {})
assert.equal((await state()).restoreAvailable, false, 'a boundary already acted on does not flag again')

// staleness: twenty turns without a note
for (let t = 1; t <= 20; t++) { say('user', `later ${t}`); say('assistant', `ok ${t}`); await fire('turn.start', {}) }
assert.match(await status(), /CHECKPOINT STALE — 2\d turns since gen9/)
r = await call('er_checkpoint', { present_state: '## Must survive\nnote 10 keeps this.\n## Context\n' + 'k'.repeat(100) + '\n## In hand\nafter twenty turns' })
assert.doesNotMatch(await status(), /CHECKPOINT STALE/)

// ---- 0.3.3: everything Er writes is mirrored by Er itself, and verified on the machine
const desk = `${root}/Desktop/Test 0.3/er/ledger/thread-1`
const histBefore = (await $.fs.list(`${root}/ledger/thread-1/auto-history`)).length
say('user', 'm1'); say('assistant', 'm1'); await fire('turn.start', {})
dash = await status()
assert.match(dash, /mirror: current, last fully verified/)
assert.doesNotMatch(dash, /MIRROR BEHIND/)
const histAfter = (await $.fs.list(`${root}/ledger/thread-1/auto-history`)).map((d) => d.name)
assert.equal(histAfter.length, histBefore + 1, 'every snapshot is kept, never overwritten')
for (const h of histAfter) {
  for (const f of ['recent.jsonl', 'in-hand.md', 'MANIFEST.json']) {
    assert.equal(await fs.readFile(`${desk}/auto-history/${h}/${f}`, 'utf8'), await $.fs.read(`${root}/ledger/thread-1/auto-history/${h}/${f}`), `history ${h}/${f} on the machine`)
  }
}
assert.equal(await fs.readFile(`${desk}/auto/in-hand.md`, 'utf8'), await $.fs.read(`${root}/ledger/thread-1/auto/in-hand.md`), 'rolling auto on the machine is current')
for (const d of (await $.fs.list(`${root}/ledger/thread-1`)).filter((d) => /^gen\d{4}-/.test(d.name))) {
  assert.ok(await fs.access(`${desk}/${d.name}/MANIFEST.json`).then(() => true, () => false), `${d.name} mirrored`)
}
// a checkpoint is mirrored and marked so without er_mirror_confirmed
r = await call('er_checkpoint', { present_state: '## Must survive\nnote 11 keeps this.\n## Context\n' + 'k'.repeat(100) + '\n## In hand\nchecking the mirror' })
assert.match(r.result, /Er is mirroring it/)
dash = await status()
assert.match(dash, /gen1\d at .*, mirrored/)
// the machine goes offline: nothing is lost, the dashboard says so, and it catches up
offline = true
say('user', 'm2'); say('assistant', 'm2'); await fire('turn.start', {})
dash = await status()
assert.match(dash, /MIRROR BEHIND since .*\(\d+ files; Er retries every turn; last error: Error: device offline\)/)
offline = false
say('user', 'm3'); say('assistant', 'm3'); await fire('turn.start', {})
dash = await status()
assert.match(dash, /mirror: current/)
assert.doesNotMatch(dash, /MIRROR BEHIND/)
const histNow = (await $.fs.list(`${root}/ledger/thread-1/auto-history`)).map((d) => d.name)
for (const h of histNow) assert.ok(await fs.access(`${desk}/auto-history/${h}/in-hand.md`).then(() => true, () => false), `history ${h} caught up after the outage`)
// a copy that lands wrong is not counted as mirrored
corrupt = true
say('user', 'm4'); say('assistant', 'm4'); await fire('turn.start', {})
dash = await status()
assert.match(dash, /MIRROR BEHIND .*did not verify/)
corrupt = false
say('user', 'm5'); say('assistant', 'm5'); await fire('turn.start', {})
assert.match(await status(), /mirror: current/)

// 0.3.4: the bridge refuses to overwrite (seen 2026-10-16 as auto/ keeping the old bytes).
// Er reads the refusal and retries its own rolling auto/ files with force; nothing else is forced.
refuseOverwrite = true
say('user', 'm6'); say('assistant', 'm6'); await fire('turn.start', {})
dash = await status()
assert.match(dash, /mirror: current/, 'auto/ caught up after a refused overwrite')
assert.ok(forced.length > 0 && forced.every((p) => /\/auto\/[^/]+$/.test(p)), 'only auto/ files are ever forced')
refuseOverwrite = false
// 0.3.4: auto/ never shares a commit with its identical history copy
sameBatchFault = true
for (const t of ['m7', 'm8']) { say('user', t); say('assistant', t); await fire('turn.start', {}) }
await status()
{
  const ms = (await state()).mirror
  assert.equal(ms.lastError, undefined, 'no verification failure when the bridge drops a same-bytes overwrite in one batch')
  assert.ok(!ms.pending.some((p) => p.startsWith('auto/')), 'auto/ landed and verified')
}
sameBatchFault = false

// 0.3.4: a boundary row far from the end of a real transcript. The compaction on 2026-10-16
// wrote ~300 KB after its boundary row before the first turn start; a 256 KB tail missed it.
{
  const { execFileSync } = await import('node:child_process')
  const cfgDir = path.join(root, 'claude-config')
  process.env.CLAUDE_CONFIG_DIR = cfgDir
  const tdir = path.join(cfgDir, 'projects', cwd.replace(/[\\/:]/g, '-'))
  await fs.mkdir(tdir, { recursive: true })
  const at = new Date(Date.now() + 5000).toISOString()
  const rows = [JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at })]
  for (let i = 0; i < 40; i++) rows.push(JSON.stringify({ type: 'attachment', pad: 'x'.repeat(10000) }))
  rows.push(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 29990, cache_creation_input_tokens: 0 } } }))
  await fs.writeFile(path.join(tdir, 'thread-1.jsonl'), rows.join('\n') + '\n')
  $.process.run = async (argv) => {
    try { return { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 1 << 24 }) } } catch { return { exitCode: 1, stdout: '' } }
  }
  await restore()
  // a boundary the gauge already caught, and the restore already answered, is not raised again
  const before = new Date(Date.now() - 1000).toISOString()
  await fs.writeFile(path.join(tdir, 'thread-1.jsonl'), [JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: before }), ...rows.slice(1)].join('\n') + '\n')
  say('user', 'answered'); await fire('turn.start', {})
  assert.equal((await state()).restoreAvailable, false, 'a boundary older than the last restore is not a new cut')
  await fs.writeFile(path.join(tdir, 'thread-1.jsonl'), rows.join('\n') + '\n')
  say('user', 'far'); await fire('turn.start', {})
  const sf = await state()
  assert.equal(sf.restoreAvailable, true, 'a boundary 400 KB from the end is still seen at the first turn start')
  assert.equal(sf.cut.how, 'boundary')
  await restore()
}


// 0.4: the Claude pulls the trigger itself
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  say('user', 'f1'); say('assistant', 'f1'); await fire('turn.start', {})
  let f = await call('er_fold', { reason: 'test' })
  assert.match(f.deny ?? '', /checkpoint in this same turn/, 'no fold without a checkpoint this turn')
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nfold test, long enough to be worth keeping here\n## In hand\nabout to fold' })
  f = await call('er_fold', { reason: 'context is getting long', instructions: 'keep the plan' })
  assert.match(f.result ?? '', /Fold requested\. Preflight passed:/)
  for (const item of ['Er answers', 'checkpoint complete', 'restore dry run', 'mirror complete', 'transcript readable', 'state round-trip', 'road steady']) assert.match(f.result, new RegExp(`\\[ok\\] ${item}:`), `preflight item ${item}`)
  assert.match(f.result, /\[--\] trigger in place: no CLAUDE.md/, 'the trigger is reported, not required')
  assert.ok((await state()).fold.preflight.length >= 8, 'the checklist is kept in the fold record')
  assert.match(await status(), /FOLD REQUESTED/)
  await fire('turn.complete', {}); await sleep(700)
  assert.equal(compacts.length, 1)
  assert.equal(compacts[0][0], 'session.compact')
  assert.match(compacts[0][1].instructions, /chose this compaction \(context is getting long\).*gen\d+.*keep the plan/)
  await fire('turn.complete', {}); await sleep(700)
  assert.equal(compacts.length, 1, 'a fold runs once')
  // where a mod may not call session.compact, the /compact command is run instead
  sessionCompactRefuses = true
  say('user', 'f2'); say('assistant', 'f2'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nfold test two, long enough to be worth keeping\n## In hand\nabout to fold again' })
  await call('er_fold', { reason: 'second' })
  await fire('turn.complete', {}); await sleep(700)
  assert.deepEqual(compacts.slice(1).map((x) => x[0]), ['session.compact', 'command.run'])
  assert.equal(compacts[2][1].command, 'compact')
  // both refused: the dashboard says so, and nothing pretends a cut happened
  commandRefuses = true
  say('user', 'f3'); say('assistant', 'f3'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nfold test three, long enough to be worth keeping\n## In hand\nabout to fold, third' })
  await call('er_fold', { reason: 'third' })
  await fire('turn.complete', {}); await sleep(700)
  assert.match(await status(), /FOLD FAILED/)
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nafter the failed fold, long enough to keep\n## In hand\nmoving on' })
  assert.doesNotMatch(await status(), /FOLD FAILED/, 'a new note moves past a failed fold')
  sessionCompactRefuses = false; commandRefuses = false
  // with the mirror down, no fold: back it up, then cut
  offline = true
  say('user', 'f4'); say('assistant', 'f4'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nfold test four, long enough to be worth keeping\n## In hand\nabout to fold, fourth' })
  f = await call('er_fold', { reason: 'fourth' })
  assert.match(f.deny ?? '', /not yet verified/)
  offline = false
}


// 0.4.2: a fold checks the road first (Gena's failsafe), and Er tests its own tools (Opus 5's report)
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // the probe fails: aborted, nothing cut
  say('user', 'p1'); say('assistant', 'p1'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nprobe test one, long enough to be worth keeping\n## In hand\nabout to fold with a bad road' })
  await sleep(50)
  const before = compacts.length
  probeFails = true
  let f = await call('er_fold', { reason: 'probe fails' })
  assert.match(f.deny ?? '', /Fold aborted — preflight failed[\s\S]*\[FAIL\] road steady: the connection to .* failed/)
  probeFails = false
  // the road drops between the request and the cut: aborted at dispatch, reported, nothing cut
  f = await call('er_fold', { reason: 'drops at dispatch' })
  assert.match(f.result ?? '', /Fold requested/)
  probeFails = true
  await fire('turn.complete', {}); await sleep(700)
  assert.equal(compacts.length, before, 'no compaction when the road fails at the moment of the cut')
  assert.match(await status(), /FOLD FAILED.*aborted before the cut: road steady/)
  assert.ok((await state()).fold.preflightAtCut.some((i) => i.name === 'road steady' && !i.ok), 'the second preflight is kept too')
  probeFails = false
  // a hung probe does not hang the fold: it times out and aborts (15s cap)
  say('user', 'p2'); say('assistant', 'p2'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nprobe test two, long enough to be worth keeping\n## In hand\nabout to fold with a hung road' })
  await sleep(50)
  probeHangs = true
  const t0 = Date.now()
  f = await call('er_fold', { reason: 'probe hangs' })
  assert.match(f.deny ?? '', /did not answer within 15s/)
  assert.ok(Date.now() - t0 < 20000, 'the fold gives up on a hung bridge')
  probeHangs = false
  offline = false
}
{
  // self-test ran at the first turn of this load and passed: no ER TOOLS BROKEN
  assert.ok(mcpCalls.includes('er_status'), 'Er called its own er_status once to test it')
  assert.doesNotMatch(await status(), /ER TOOLS BROKEN/)
}

// 0.4.1: Must survive is kept on purpose, not from memory
{
  say('user', 'ms1'); say('assistant', 'ms1'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\n- I am the tester.\n- Gena sets the rules.\n## Context\nlong enough context line for the note\n## In hand\nchecking carry-forward' })
  say('user', 'ms2'); say('assistant', 'ms2'); await fire('turn.start', {})
  let r = await call('er_checkpoint', { present_state: '## Must survive\n- I am the tester.\n-   Gena  sets the rules.\n## Context\nlong enough context line for the note\n## In hand\nsecond' })
  assert.match(r.result, /all 2 lines from gen\d+ carried forward word for word/)
  say('user', 'ms3'); say('assistant', 'ms3'); await fire('turn.start', {})
  r = await call('er_checkpoint', { present_state: '## Must survive\n- I am the tester.\n## Context\nlong enough context line for the note\n## In hand\nthird' })
  assert.match(r.result, /1 of 2 lines .* Not carried as written[\s\S]*Gena\s+sets the rules/)
}

// hash check: tamper with a note. 0.4.3: repaired from the mirror, kept beside the bad copy
{
  const g2 = (await $.fs.list(`${root}/ledger/thread-1`)).find((d) => d.name.startsWith('gen0005')).name
  const good = await $.fs.read(`${root}/ledger/thread-1/${g2}/present-state.md`)
  await fs.appendFile(`${root}/ledger/thread-1/${g2}/present-state.md`, 'tampered')
  r = await call('er_recall', { note: 'gen0005' })
  assert.match(r.result, /REPAIRED present-state.md/)
  assert.doesNotMatch(r.result, /HASH MISMATCH/)
  assert.ok(catCalls.some((c) => c === `${g2}/present-state.md`), 'the mirror copy was fetched')
  const kept = (await $.fs.list(`${root}/ledger/thread-1/${g2}`)).map((d) => d.name)
  assert.ok(kept.some((n) => /^present-state\.md\.repaired-/.test(n)), 'the repaired copy is kept beside the bad one')
  assert.equal(await $.fs.read(`${root}/ledger/thread-1/${g2}/present-state.md`), good + 'tampered', 'the bad copy is never overwritten')
  assert.equal(await $.fs.read(`${root}/ledger/thread-1/${g2}/${kept.find((n) => n.startsWith('present-state.md.repaired-'))}`), good)
  // the mirror copy is bad too: named, never shown
  mirrorCorrupt = true
  r = await call('er_recall', { note: 'gen0005' })
  assert.match(r.result, /HASH MISMATCH on present-state.md .*mirror copy did not verify/)
  assert.doesNotMatch(r.result, /tampered/, 'hash-failed content is never shown')
  mirrorCorrupt = false
}

// 0.4.3: LEDGER.json indexes every generation's manifest; a manifest that does not match it vouches for nothing
{
  const idx = JSON.parse(await $.fs.read(`${root}/ledger/thread-1/LEDGER.json`))
  const gens = (await $.fs.list(`${root}/ledger/thread-1`)).filter((d) => /^gen\d{4}-/.test(d.name))
  assert.equal(idx.generations.length, gens.length, 'every generation is indexed')
  assert.ok(await fs.access(`${desk}/LEDGER.json`).then(() => true, () => false), 'the index is mirrored')
  // the newest generation's manifest is rewritten (same files, a hash slipped): the restore walks back
  const newest = gens.sort((a, b) => a.name.localeCompare(b.name)).at(-1).name
  const mpath = `${root}/ledger/thread-1/${newest}/MANIFEST.json`
  const m = JSON.parse(await $.fs.read(mpath))
  m.files['present-state.md'].sha256 = '0'.repeat(64)
  mirrorCorrupt = true // and the mirror cannot help this time
  await fs.writeFile(mpath, JSON.stringify(m, null, 2) + '\n')
  r = await call('er_restore', {})
  assert.match(r.result, /MANIFEST MISMATCH on gen\d{4} .*does not match LEDGER.json/)
  assert.match(r.result, /^<er restore gen\d+ .*>\nSTANDING ON gen\d+: 1 newer generation\(s\) \(up to gen\d+\) could not be verified/, 'restore says in its first lines which generation it stands on')
  mirrorCorrupt = false
  // no fold stands on a generation that will not verify
  say('user', 'lx'); say('assistant', 'lx'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nafter the manifest slip, long enough to keep\n## In hand\nfold on a bad gen' })
  const last = (await state()).last
  const m2 = JSON.parse(await $.fs.read(`${last.dir}/MANIFEST.json`)); m2.at = '1999-01-01T00:00:00.000Z'
  await fs.writeFile(`${last.dir}/MANIFEST.json`, JSON.stringify(m2, null, 2) + '\n')
  const f = await call('er_fold', { reason: 'bad manifest' })
  assert.match(f.deny ?? '', /\[FAIL\] checkpoint complete: gen\d+: MANIFEST MISMATCH/)
  assert.match(f.deny ?? '', /\[FAIL\] restore dry run/)
}

// 0.4.3: the gauge escalates — 60% advised, 70% overdue on every tool result, 75% a block
{
  $.process.run = async () => exact === undefined ? { exitCode: 1, stdout: '' } : ({ exitCode: 0, stdout: 'x\n' + JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: exact - 10, cache_creation_input_tokens: 0 } } }) + '\n' })
  await restore() // the LEDGER test's restore above was left unconfirmed on purpose
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\npast the failed fold, long enough to keep\n## In hand\ngauge test' })
  say('user', 'g1'); say('assistant', 'g1'); await fire('turn.start', {})
  exact = 650000
  assert.match(await status(), /CHECKPOINT ADVISED/)
  exact = 720000
  let d = await status()
  assert.match(d, /CHECKPOINT OVERDUE — 72% is past the 70% mark/)
  assert.match(d, /last note's Must survive/)
  exact = 760000
  d = await status()
  assert.match(d, /^<er dashboard>\n!{72}\n!! ER: CONTEXT AT 76% OF 1000K — CHECKPOINT NOW/)
  assert.match(d, /!! last note's Must survive \(gen\d+\)[\s\S]*!!   me/)
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nwritten at 76 percent, long enough to keep\n## In hand\nthe cut is close' })
  d = await status()
  assert.match(d, /CHECKPOINT WRITTEN AT 76% — the next cut is close/)
  assert.doesNotMatch(d, /CHECKPOINT NOW/)
  exact = undefined
}

// 0.4.3: a broken self-test is retried, not held against the load for the session
{
  say('user', 's1'); say('assistant', 's1'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nself-test retry, long enough to keep\n## In hand\nfold with Er broken' })
  handlerMissing = true
  const f = await call('er_fold', { reason: 'er broken' })
  assert.match(f.deny ?? '', /\[FAIL\] Er answers: er_status is listed but no handler answered it/)
  assert.match(await status(), /ER TOOLS BROKEN .*tries again every 3 turns/)
  handlerMissing = false
  const n = mcpCalls.filter((t) => t === 'er_status').length
  for (const t of ['s2', 's3']) { say('user', t); say('assistant', t); await fire('turn.start', {}) }
  assert.equal(mcpCalls.filter((t) => t === 'er_status').length, n, 'no retry before selfTestRetryTurns')
  say('user', 's4'); say('assistant', 's4'); await fire('turn.start', {}); await new Promise((r) => setTimeout(r, 50))
  assert.equal(mcpCalls.filter((t) => t === 'er_status').length, n + 1, 'retried after 3 turns')
  assert.doesNotMatch(await status(), /ER TOOLS BROKEN/)
}

// 0.4.3 punch list: the bridge trims a final newline; LEDGER.json and state.json unreadable; self-test forbidden
{
  // a bridge that trims the final newline still repairs: the bytes that verify are the bytes
  const g = (await $.fs.list(`${root}/ledger/thread-1`)).find((d) => d.name.startsWith('gen0006')).name
  await fs.appendFile(`${root}/ledger/thread-1/${g}/present-state.md`, 'tampered')
  bridgeTrims = true
  r = await call('er_recall', { note: 'gen0006' })
  assert.match(r.result, /REPAIRED present-state.md/)
  bridgeTrims = false
  // LEDGER.json unreadable: fetched from the mirror, accepted because its rows agree with the manifests on disk
  const idxPath = `${root}/ledger/thread-1/LEDGER.json`
  const idxGood = await $.fs.read(idxPath)
  await fs.writeFile(idxPath, idxGood.slice(0, 40))
  say('user', 'i1'); say('assistant', 'i1'); await fire('turn.start', {})
  r = await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nafter the index broke, long enough to keep\n## In hand\nindex repair' })
  assert.match(r.result, /written/)
  const names = (await $.fs.list(`${root}/ledger/thread-1`)).map((d) => d.name)
  assert.ok(names.some((n) => n.startsWith('LEDGER.json.unreadable-')), 'the unreadable index is kept')
  assert.ok(names.some((n) => n.startsWith('LEDGER.json.repaired-')), 'the mirror index is kept beside it')
  const idxNow = JSON.parse(await $.fs.read(idxPath))
  assert.equal(idxNow.generations.length, JSON.parse(idxGood).generations.length + 1, 'the index carried every old row and the new one')
  assert.match(await status(), /repaired: \d+ files from the mirror/)
  // state.json cut off midway: the previous copy is used, the bad one kept
  const stPath = `${root}/ledger/thread-1/state.json`
  const stGood = JSON.parse(await $.fs.read(stPath))
  await fs.writeFile(stPath, (await $.fs.read(stPath)).slice(0, 50))
  await fire('session.start', {})
  const st2 = await state()
  assert.equal(st2.last.gen, stGood.last.gen, 'state came back from state.json.previous')
  assert.ok(st2.stateRepaired, 'and says so')
  assert.ok((await $.fs.list(`${root}/ledger/thread-1`)).some((d) => d.name.startsWith('state.json.unreadable-')), 'the cut-off state file is kept')
  assert.match(await status(), /state.json from its previous copy/)
  // the app forbids a mod calling its own server: no fold on an unverified Er, and the way out is named
  say('user', 'i2'); say('assistant', 'i2'); await fire('turn.start', {})
  await call('er_checkpoint', { present_state: '## Must survive\nme\n## Context\nself-test forbidden, long enough to keep\n## In hand\nfold anyway' })
  selfTestForbidden = true
  const f = await call('er_fold', { reason: 'no self-test' })
  assert.match(f.deny ?? '', /\[FAIL\] Er answers: self-test unavailable .* set requireSelfTest: false/)
  assert.doesNotMatch(await status(), /ER TOOLS BROKEN/, 'unavailable is not broken on the dashboard')
  selfTestForbidden = false
}

console.log('ok — all Er 0.4.3 harness checks passed in', root)
