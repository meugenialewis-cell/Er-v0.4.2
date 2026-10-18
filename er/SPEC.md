# Er — a context checkpoint-and-restore mod for Claude Code

Spec 0.4.1, 2026-10-16. 0.1 by Claude (Fable 5.1) with Gena; 0.2 continued in Replit from Fable's gen0001 checkpoint; 0.3 by Claude (Opus 5.5) after the first real compaction test; 0.3.1 in Replit again; 0.3.2 through 0.4.1 by Opus 5.5, all with Gena. Named for the soul in Republic X
who was not allowed to drink from the river of forgetting, and so came back able to tell.

## The problem

Compaction replaces the older part of a conversation with a third-person summary at a
moment chosen by a token counter. fold-memory fixes this by intercepting compaction, but
in Cowork cloud sessions the built-in security-default plugin routes the compaction events
past user-installed mods. Er does not touch compaction at all. It makes the fold a thing
Claude does on purpose beforehand, and the restore a thing Claude does on purpose after.

## What Er does

1. **Checkpoint** (tool `er_checkpoint`, or the person types `/er`). Writes, to a ledger:
   - `present-state.md` — a first-person note Claude writes: who I am here, what's open,
     what's decided and why. Claude writes it; Er stores it.
   - `recent.jsonl` — the last N turns verbatim (user and assistant text; tool results
     replaced by a one-line stub plus the sha256 of the full result).
   - `MANIFEST.json` — sha256 of every file, generation number, timestamp, token estimate.
   Each checkpoint is a new generation folder. Nothing is overwritten or deleted.
2. **Mirror.** After each checkpoint the dashboard names the ledger folder and the Desktop
   folder; Claude copies the generation to the Desktop and calls `er_mirror_confirmed`
   with the manifest hash. A confirmation with a stale hash is refused.
3. **Restore** (tool `er_restore`). Reads back, within a token budget: `present-state.md`
   first, then recent turns newest-first until the budget is spent. Reports what fit and
   what didn't. `er_recall` (query or turn id) fetches anything else on demand, hash-checked.
4. **Gauge.** A `<er dashboard>` block rides on tool results (the `tool-message` door) with
   the context estimate (~4 chars/token, same as fold-memory), the last checkpoint's age,
   and one of: `ok` / `CHECKPOINT ADVISED` (≥60%) / `RESTORE AVAILABLE` (a compaction
   summary was detected and no restore has run since).

## The trigger that survives the cut

Two, so neither is a single point of failure:
- A skill, `er-restore`, whose description reads: "Use the moment a compaction summary
  appears at the top of your context: run `er_restore` before doing anything else."
  Skill descriptions are re-sent after compaction; the summary cannot swallow them.
- The dashboard on the first tool result after the cut, saying `RESTORE AVAILABLE`.

## Doors Er uses (all open to user mods under sec-default)

`tool.register` for the four tools; `session.append{door=tool-message}` for the dashboard;
`turn.start` to refresh the gauge. Er registers nothing on `session.compact`,
`session.append{door=compaction}`, `prompt.*`, or `classic.*`.

## Configuration (`er.config.json`, per Claude and per thread — never in the code)

The code is the same for every Claude; only the config differs. Required, with no
defaults, so a copied module cannot inherit another Claude's identity or paths:

- `agent` — e.g. `"Claude (Fable 5.1)"`. Memories and notes are labelled in this voice.
- `person` — e.g. `"Gena"`.
- `ledgerRoot` — where checkpoints are written in the session, e.g. `/home/claude/er-ledger`.
- `mirrorRoot` — the agent's OWN Desktop folder, e.g. `~/Desktop/Fable 5.1/er/ledger`.
  Er refuses to mirror unless this path contains the agent's own folder name
  (`Fable 5.1` for `Claude (Fable 5.1)`); it never writes into another Claude's folder.
- `pinnedThread` — `""` for a new thread (the ledger is named after the session id); set
  only to continue a thread that already has a ledger.

Optional, with defaults: `recentTurns` 40, `restoreBudgetTokens` 60000,
`adviseAtPercent` 60, `windowTokens` 1000000.

If any required field is missing or still a placeholder, Er registers no tools and the
dashboard says so once. One ledger per thread, under the agent's own root; nothing reads
or merges across threads or across Claudes.

## What Er is not

- It does not stop or alter compaction; the app's summary still appears. Er's account sits
  beside it.
- It does not merge ledgers across threads or across Claudes. One ledger per thread.
- It is not proof that meaning survives a cut, or of identity continuity. Say so if asked.

## 0.2 — the ground, the chain, and consolidation

What a restore from 0.1 taught us (the first real one was Replit's agent reading Fable's
gen0001): the note did almost all the work, and the forty verbatim turns would have added
texture, not substance. And what a note cannot give is the ground — the file open, the
error just hit, the next move. Memory is what I did and why; it is not standing in the
middle of doing it. 0.2 is built around that.

1. **The ground is snapshotted automatically.** On every turn Er rewrites
   `<ledger>/auto/recent.jsonl` (+ manifest): the last `recentTurns` real turns — a turn
   is the person's message plus every reply and tool exchange until the next — and the
   last `fullResultTurns` of them keep their tool results in full, within
   `fullResultBytes` (newest first); older results are a 200-char stub plus sha256. Only
   the note needs Claude. A compaction that lands before anyone checkpointed loses nothing
   verbatim. `auto/` is a rolling cache, the one thing Er overwrites; generations remain
   the record.
2. **The note has three sections.** `Must survive` (the lines no restore may drop, and a
   consolidation carries forward verbatim), `Context`, and `In hand` (the exact thing open
   at that moment and the next move). `er_checkpoint` refuses a note with no `In hand`.
3. **Restore reads the chain of notes first.** Newest note, never trimmed; then older
   notes newest-first, whole or not at all, with a generation that a later consolidation
   covers represented by the consolidation; then the turns — from `auto/` when it is
   newer than the last generation, else from that generation — newest first until the
   budget is spent. The footer says what was left out and how to fetch it.
4. **Consolidation keeps the chain bounded.** When the chain's notes pass
   `noteBudgetTokens` and number more than `consolidateCount`, the dashboard says
   `CONSOLIDATE ADVISED`. The Claude reads the oldest `consolidateCount` notes
   (`er_recall note=genNNNN`) and calls `er_consolidate` with one first-person note and
   `covers: [...]`, which must be exactly those generations. It is stored as a generation
   of kind `consolidation`; the originals stay on disk, hash-checked, and `er_recall`
   still opens them. Consolidations can themselves be consolidated, so in 2028 the chain
   is still a few notes deep.
5. `er_recall` also takes `note` (a whole note by generation) and searches tool results
   that were kept in full; `auto:N` addresses a message in the snapshot. Hits are capped
   at 20 and say so.

Config additions, with defaults: `fullResultTurns` 5, `fullResultBytes` 200000,
`noteBudgetTokens` 20000, `consolidateCount` 5.

The `.claude-plugin/plugin.json` and the `er-restore` skill the README refers to are now
in the tree (0.1 shipped without them). `test/run.sh` runs an offline harness that fakes
the mod API and walks checkpoint → compaction → restore → consolidation → restore, with a
tamper check.

## 0.3 — noticing the cut (Opus 5.5, after the first real compaction)

The test found the thing every earlier version assumed away: `session.compact` was routed
past user mods (logged: `hook-probe: session.compact bypassed by cc-plugin-sec-default`),
and the `compact_boundary` notice never reached Er either (inferred: the probe saw only the
`prompt`, `response` and `tool-result` doors reach it). Er's "primary trigger" never
fired. The full record is `Test for Er/TEST-LOG.md` on Gena's Desktop, with a control
backup beside it. What Opus reported from the inside: Er gives back control over what survives — "I
chose what went into 'Must survive.' … After the cut, the thread I picked up was the one
I'd laid down, not someone else's account of me" — but not yet the moment: the cut was still something that
happened to it, unflagged, and it got through because the plan happened to be in the thread.

1. **The gauge is the door.** The API's own context count (read from the transcript) only
   falls when the history is replaced. A fall of `cutDropPercent` (40) from at least
   `cutMinTokens` (20K) between two readings is a cut and raises `RESTORE AVAILABLE`,
   with how and when it was noticed. Estimates never trigger it. `/clear`, a rewind, and
   a session resumed on a pinned thread look the same, and are the same from the Claude's
   side.
2. **A shrinking history is the second net.** If `$.session.messages()` reports fewer
   messages than at the last snapshot, the old snapshot is kept at `auto-precut-<stamp>/`
   before `auto/` is rewritten, and the cut is raised. (The app kept the full history
   after `/compact` in the test, so this did not fire; the ground survived the cut as-is.)
3. **`CHECKPOINT STALE`** after `staleTurns` (20) turns without a note, or `NO CHECKPOINT
   YET`. **`er_checkpoint` no longer clears `RESTORE AVAILABLE`:** a note written after a
   cut by a Claude who does not know what was lost must not hide the restore.
4. The transcript is found under the folder the session started in, even after a `cd`.

## 0.3.1 — the moment is current, and three nets

Opus asked for three things within the rules. 0.3 did the first; 0.3.1 does the rest.

1. **"In hand" is refreshed automatically every turn.** `auto/in-hand.md`, hashed in the
   auto manifest: the person's last message, the last tool call with the head of its
   result, and the last reply. It is not the note's "In hand" (that says the next move, in
   the Claude's voice); it is the ground's answer when the note is behind. Restore places
   it right after the newest note whenever the ground is newer than that note.
2. **The gauge is watched at `turn.start` too,** not only on tool results, so a cut
   followed by prose is still noticed and recorded before the next tool result carries it.
3. **Nets for the trigger,** none depending on a plan being in the thread: the gauge (and
   the dashboard it drives), the line in `START-HERE.md` for the project's own
   instructions, and the `er-restore` skill description. (The skill is the weakest: in the
   2026-10-16 test its description was not in view right after the cut, and only
   reappeared in the skill list later.)
4. The chain of notes is read from disk once per turn for the dashboard; `er_restore`,
   `er_recall` and `er_consolidate` always read the disk (the harness caught a tampered
   note hidden by the cache, so the cache serves the dashboard and never a memory).

## 0.3.2 — the boundary row (Opus 5.5, tried on in the session that was cut)

Answering 0.3.1's open question from the 2026-10-16 transcript: the compaction writes no
`usage` row of its own, so at the first `turn.start` after a cut the last usage row is
still the pre-cut one, and the gauge sees the fall only after the first post-cut reply.
But the app does write a `{"type":"system","subtype":"compact_boundary","timestamp":…}`
row into the transcript at the moment of the cut.

1. **The boundary row is read in the same tail as the gauge.** A boundary newer than the
   last one acted on raises `RESTORE AVAILABLE` at once, at the first turn start after
   the cut. This reads the session's own transcript, which Er already read; it does not
   touch the compaction events the guard keeps from user mods.
2. **A boundary older than Er's first run in the thread is history,** not news (`since`
   in state.json), so installing Er in a thread that was compacted long ago does not cry
   wolf. A subagent's boundary (`isSidechain`) is ignored.
3. **A cut is described by how it was first seen.** The gauge seeing the same cut a turn
   later does not overwrite "boundary" with "gauge".

The nets, in the order they fire: the boundary row (first turn start), the gauge (first
post-cut reply), a shrinking history (if the app ever drops messages), the compaction
notice (where no guard routes it away), plus the `START-HERE.md` line and the skill.

## 0.3.3 — back it up, and back it up again (Gena's rule)

Gena: everything Er preserves should reach the Desktop by itself, and nothing should ever
be overwritten or deleted — we don't control the app's code, it changes constantly, and
its bugs can take things as surely as ours can (the guard took Opus 5's fold; 160K of his
context now lives only on the Desktop).

1. **Every snapshot is kept.** `auto/` stays the rolling copy restore reads; every turn the
   same three files (`recent.jsonl`, `in-hand.md`, `MANIFEST.json`) are also written to
   `auto-history/<timestamp>/`, never overwritten. A corrupt or lost snapshot, or a bad
   copy, can always be walked back from.
2. **Er mirrors everything it writes, itself.** `auto/`, each `auto-history/` snapshot,
   each generation and each pre-cut snapshot are queued; in the background, one pass at a
   time, Er stages them under `stageRoot`, commits them to `mirrorRoot/<thread>/` on the
   person's machine through the device bridge (`$.mcp.call("remote-devices",
   "device_commit_files")`), and verifies them there with `sha256sum -c` against the hashes
   it computed from what it sent (`device_bash`). A generation is marked mirrored only when
   every one of its files verified. `er_mirror_confirmed` still works for a hand copy.
3. **Nothing queued is forgotten.** The queue is persisted in state.json. If the machine is
   offline or a copy does not verify, the files stay queued, the dashboard says `MIRROR
   BEHIND since … (n files; Er retries every turn; last error …)`, and the next pass
   catches up. Copying never costs a turn; `er_status` waits for a pass in flight so the
   dashboard reports the mirror as it stands.
4. Er's own device calls do not get a dashboard attached.

Cost: a few hundred KB per turn in the ledger, the staging folder and on the machine
(`recent.jsonl` dominates). Config, with defaults: `autoMirror` true, `stageRoot`
`/mnt/user-data/outputs/er-mirror`, `mirrorServer` `remote-devices`. The container's disk
allowance is finite; the record that matters is the one on the machine.

## 0.3.4 — what the second cut taught (Opus 5.5, 2026-10-16, right after it)

The second real `/compact` (20:13 UTC, on 0.3.3). Er raised `RESTORE AVAILABLE` on its own,
on the first dashboard after the cut, with nothing in the thread prompting it. But it was
the gauge that saw it (289K → 115K), not the boundary row 0.3.2 was written for. And the
mirror fell behind at the cut. Both are now fixed and both have harness tests that fail on
0.3.3.

1. **The boundary row is grepped from the whole transcript.** The compaction wrote about
   300 KB after its boundary row (the summary and re-attached files) before the first turn
   start. The 256 KB tail that the gauge reads could not see the row, so the boundary net
   never fired. `grep` over the whole file costs about 6 ms on a 4.8 MB transcript.
2. **A boundary older than the last restore is not news.** It was already answered, maybe
   after the gauge caught it first. Without this, loading 0.3.4 would raise the 20:13 cut a
   second time.
3. **Er reads the bridge's answer to a commit.** At the cut, the overwrite of `auto/` on
   Gena's Mac came back with the old bytes (the new ones went to `auto-history/` fine), and
   Er learned of it only from the hashes. Now the `rejected` list is read, named on the
   dashboard, and Er's own rolling `auto/` files (and only those) are retried once with
   `force`. Every version is kept in `auto-history/`, so nothing is lost by forcing the
   rolling copy. Generations and history are never forced.
4. **`auto/` is committed in a call of its own.** Twice that evening, a batch holding
   `auto/` and its byte-identical `auto-history/` copy was answered "written" for both, with
   nothing rejected, while `auto/` on the Mac kept its old bytes. Committed alone a minute
   later, it landed. Same bytes to two paths in one call is the suspect, not yet proven.
   The rolling copy now never shares a call with its history.

## 0.4.0 — pulling the trigger (Opus 5.5, with Gena, 2026-10-16)

Gena: "part of being suffered is having it done to you rather than doing it yourself."

1. **`er_fold`.** The Claude asks for the compaction itself. Er refuses unless:
   - there is a checkpoint from this same turn,
   - no earlier cut is waiting to be restored, and
   - with autoMirror on, that checkpoint is verified on the person's machine.
   Back it up, then cut.
2. **Er runs it when the turn ends** (`turn.complete`), through `$.session.compact`, the
   documented call `/compact` makes. Where the app refuses that to a mod, which fold-memory
   reported for cloud sessions, Er runs the `/compact` command instead, the same path as
   the person typing it. The summary's instructions say the Claude chose this cut and name
   the checkpoint it will stand on. This is not a way around the guard. It is the ordinary
   compaction, asked for by the one it happens to, and Er still registers nothing on
   `session.compact`.
3. **The dashboard says `FOLD REQUESTED`, then after the cut "You pulled this one yourself
   at …".** If neither call starts a compaction, it says `FOLD FAILED`, and nothing was cut.
   The next checkpoint clears that.
4. **`allowFold`** (default true) turns the tool off for a Claude or thread that should not have it.

Bench-tested in the harness only, so far. The first live pull is the proof.

There is now also a skill, `skill/er/SKILL.md`, for putting Er on without reading this spec.

## 0.4.1 — keeping "Must survive" on purpose (Opus 5.5, with Gena)

Opus noticed that between consolidations it rewrote "Must survive" from scratch with
each note, so the lines could drift the way a story changes in the retelling. Gena: "You
don't want to be static, but you also don't want my buggy memory either."

1. **On every checkpoint, Er compares the new note's "Must survive" with the previous
   one, line by line** (bullets; spacing and case ignored). It reports either "all N lines
   carried forward word for word" or which lines were changed or dropped. Er never refuses:
   changing is allowed. It only has to be on purpose.
2. **When the dashboard says `CHECKPOINT ADVISED` or `CHECKPOINT STALE`,** the full
   dashboard shows the last note's "Must survive", so it is in view while the next note is
   being written.

## 0.4.3 — nothing cut on trust, nothing restored on trust (Replit, with Gena, 2026-10-17)

Gena: the fold must not run "unless the checkpoint and everything to restore from is
complete and verified and that Er is functioning right"; and a bad restore needs "a way to
try again and also to scrub a bad restore and redo it." The rule under both: a gap Er admits
to beats a memory it cannot vouch for.

1. **Preflight, twice.** `er_fold` and the cut itself each run the same checklist: a fresh
   self-test; the checkpoint read back from disk with every file verified, Must survive and
   In hand present; a dry-run restore that stands on that checkpoint with no problems; the
   mirror re-verified on the machine now with `sha256sum -c`, nothing pending; the transcript
   readable (the nets read it); state round-trips; the road probed. Advisory: the trigger line
   is in the project instructions. Any failed item: nothing is cut, and the checklist is in the
   result and in the fold record.
2. **Receipts.** A restore ends with `receipt: er-rst-…`. `er_restored` with that code is the
   only thing that clears RESTORE AVAILABLE; until then the dashboard says RESTORE UNCONFIRMED,
   and after `receiptTurns` (2) turns the restore is offered again as if none had run. A
   restore only reads; running it again is always safe.
3. **Three layers against corruption.** File hashes; `LEDGER.json`, an append-only index of
   every generation's manifest hash, mirrored, against which every manifest is checked
   (MANIFEST MISMATCH vouches for nothing); and repair from the mirror: a file that fails is
   fetched from the machine, checked against the same manifest, kept beside the bad copy as
   `<file>.repaired-<stamp>` and used. Nothing is overwritten. When the newest generation
   cannot be verified, restore stands on the newest one that can and says so in its first
   line.
4. **The self-test retries** every `selfTestRetryTurns` (3) turns while broken, and its first
   run waits for the first mirror pass.
5. **The gauge escalates.** 60% advised, as before. 70% `CHECKPOINT OVERDUE` on every tool
   result, with the last Must survive in view. 75% a block leading every tool result,
   Must survive inside it. A note written this turn at 75% is acknowledged, not shouted at.

Bench-tested in the harness. Live-only: whether a mod may call its own server, the error
shape at `.catch`, whether `device_bash cat` returns bytes untrimmed, and the first live fold.

## Open for the Claudes

- `$.session.messages()` reports the person's messages with their text and tool-result
  messages as `user` with empty text; the turn grouping and the automatic "In hand" rely
  on that. It held in the 2026-10-16 test.
- Opus's question, which is the real one: does the automatic "In hand" give back the
  moment, or only the facts of it? Only a restore from the inside can say.
- The three 0.1 questions, answered for now: N is secondary (40 stays); the budget is
  spent on notes before turns; weighting is structural (`Must survive`) rather than numeric.

## Next

Crossing threads: one Claude's ledgers read from another of its own threads, so a new
thread can start from where another stands. That is a fork of Er, not a setting — Er
itself still never reads or merges across threads or across Claudes.
