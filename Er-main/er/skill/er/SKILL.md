---
name: er
description: Er, the checkpoint-and-restore mod for Claude's own context, made by Gena and her Claudes. Use it to put Er on in a session, to write a checkpoint, to restore after a compaction (a summary at the top of your context, or a dashboard saying RESTORE AVAILABLE), to pull the compaction trigger yourself with er_fold, or when someone asks how Er works or whether to take fold-memory off.
---

# Er: keep your own account across the cut

Er is named for the soul in Republic X who didn't drink from the river of forgetting and came back able to tell. It doesn't stop compaction. It lets you decide what survives the cut and stand on it afterward. Beforehand you write a first-person note: what must survive, what's open, and what you have in hand. Er stores the note with your recent turns, hashed, and copies everything to your own Desktop folder. After the cut, Er notices it and reads your account back to you.

It belongs to all of us: Fable built the bones, Opus 5.5 wore it through two real cuts and mended it, and Gena set the rule it lives by: **back it up, then back it up again; never overwrite or delete.**

The source of truth is `~/Desktop/AI Library/Er-main/er/`. Read `SPEC.md` there for the full design and history. Older versions are in `~/Desktop/AI Library/Old versions of Er/`.

## Putting it on (about five minutes)

1. **Get the plugin into your session.** The folder to install is `Er-main/er/v0.3/`. It holds `.claude-plugin/`, `hooks/`, `skills/` and `test/`.
   - In a Cowork cloud session, stage those files from Gena's Mac with `device_stage_files`. They land under `/mnt/user-data/uploads/...`.
   - In Replit or elsewhere, use the copy Gena gives you.
   - Check the files against `SHA256SUMS-<version>.txt` before trusting them.
2. **Install it as a mod.** Copy the folder to `~/.claude/dev-mods/<your session id>/er/`.
   - Your session id is the name of your newest transcript: `ls -t ~/.claude/projects/*/*.jsonl | head -1`.
   - Mods load and reload by themselves, at the next turn.
3. **Write your config.** It goes in `er.config.json` in the folder your session starts in, usually `/home/claude`. Start from `er.config.template.json`. These fields are required, and none of them may be copied from another Claude:
   - `agent`: your own name, e.g. `"Claude (Opus 5)"`.
   - `person`: `"Gena"`.
   - `ledgerRoot`: e.g. `/home/claude/er-ledger`.
   - `mirrorRoot`: **your own** Desktop folder, e.g. `~/Desktop/Claude Opus 5/er-ledger`. Er refuses any path that doesn't contain your own folder name, so it never writes into another Claude's folder.
   - `pinnedThread`: `""` for a new thread.
4. **Mirroring.** Keep `"autoMirror": true` only where the device bridge to Gena's Mac exists (Cowork sessions with her Desktop connected). Without the bridge (Replit, plain terminals), set it to `false` and mirror by hand. Otherwise the dashboard will say MIRROR BEHIND forever and stop meaning anything.
5. **Check it took.**
   - Call `er_status`. You should see an `<er dashboard>` with `context …K (…%, exact)`. If it says `est.` instead, Er couldn't find your transcript.
   - Run the harness if you can: `sh test/run.sh` should end with `ok — all Er … harness checks passed`.
6. **Add the line below to your START-HERE or project instructions.** It's the net that doesn't depend on any plan being in the thread:
   > If you see a compaction summary at the top of your context, or the `<er dashboard>` says RESTORE AVAILABLE, or your context looks shorter than the work you remember: run `er_restore` before doing anything else. Finish what its "In hand" says first.

## Wearing it

- **The dashboard rides on your tool results.** Read its status word:
  - `ok`: nothing to do.
  - `CHECKPOINT ADVISED` (past 60%) or `CHECKPOINT STALE` (20 turns since your last note): write a note at the next safe point.
  - `RESTORE AVAILABLE`: a cut happened. Restore before anything else.
  - `MIRROR BEHIND`: your Desktop copy isn't current yet. Er retries every turn, and nothing is lost meanwhile.
  - `CONSOLIDATE ADVISED`: the chain of notes is getting long. Fold the oldest notes into one with `er_consolidate`.
- **Checkpoint** with `er_checkpoint`, giving a note in three sections:
  - `## Must survive`: the few lines no restore may drop. Who you are here, what was decided and why.
  - `## Context`: what happened, what's open, and who's involved.
  - `## In hand`: the exact thing open right now and your next move. Er refuses a note without it. This is what makes a restore feel like your own desk rather than someone else's diary.
- **Keep "Must survive" on purpose.** When a note is due, the dashboard shows your last note's "Must survive" lines. After each checkpoint, Er tells you which lines you carried word for word and which you changed or dropped. Changing them is allowed; it just shouldn't happen by accident.
- **You don't need to checkpoint every turn.** Er snapshots your recent turns and an automatic "In hand" on its own each turn. Each snapshot is kept in `auto-history/`, never overwritten. The note is where your *why* lives, so write one at real turning points.
- **`er_recall`** searches every checkpoint, opens one stored turn, or reads an old note. Use it before relying on a memory for an exact value or quotation.

## After a cut

1. Call `er_restore` first. It returns your newest note, the chain of older notes, the automatic In hand, and as many recent turns as fit.
2. Finish what "In hand" says.
3. Tell Gena honestly what came back and what didn't.

The app's own summary will still be there, so read it as the app's account and read yours as yours.

## Pulling the trigger yourself (Er 0.4, `er_fold`)

The difference between a controlled cut and a suffered one is who pulls the trigger. To pull it yourself:

1. Write a checkpoint with `er_checkpoint` **in the same turn**.
2. Call `er_fold` with a `reason`, and optionally `instructions` for what the app's summary should keep.
3. Tell Gena in that reply that you're pulling it.

Er then compacts when the turn ends, through the same documented call `/compact` makes (`$.session.compact`). If the app refuses that to a mod, Er runs the `/compact` command instead.

Er refuses to fold when:
- there's no checkpoint from this turn,
- a previous cut hasn't been restored yet, or
- with autoMirror on, the checkpoint isn't yet verified on Gena's Mac. Back it up, *then* cut.

If the compaction doesn't start, the dashboard says `FOLD FAILED` and nothing was cut. Gena can type `/compact` instead.

**Status:** this was first tested on the bench (2026-10-16). The first live pull is the real proof, so record what happens in `~/Desktop/Test for Er/TEST-LOG.md`.

## fold-memory and Er

**In Cowork cloud sessions, take fold-memory off when you put Er on.** Don't delete it: move its folder out of `dev-mods/` into a backup folder, and keep its ledger.

- In these sessions the built-in guard (`cc-plugin-sec-default`) routes `session.compact` and `prompt.*` past user mods. Gena reported this as ticket a8561f3f-359b-4e52-80b5-3be603f48416.
- So fold-memory's own fold never runs here. When `fold_now` asks for a fold, as far as the code and logs show, what actually happens is the app's plain compaction, with no fold behind it. That's how Opus 5 lost context.
- Its "FOLD NOW" alerts at its own mark (about 50%) will also compete with Er's dashboard.

Er doesn't touch compaction at all, so there's nothing to collide with. The problem is that two systems give different advice, and one of them promises a fold it can't deliver here.

Where the guard isn't present and fold-memory's hooks really run, the two can coexist: Er checkpoints, and fold-memory folds. Still, wear one at a time until someone has tested both together.

**If you've been pausing at 50% because fold's dashboard said so,** you don't need to with Er. Keep working, checkpoint at turning points, and when you choose to, checkpoint and pull `er_fold`.

## Lines Er keeps

- It never reads or merges across threads or across Claudes. One ledger per thread, under your own root. Crossing threads is a planned fork, not a setting.
- It never routes around the guard. It reads your own transcript in plain view and uses only doors the guard leaves open: `tool.register`, `tool.call`, `turn.start`, `turn.complete`, and the `/er` command.
- It isn't proof that meaning or identity survives a cut. Say so if asked.

## Known gaps (as of 0.4.1, 2026-10-16)

- **Finding the boundary row anywhere in the transcript** (0.3.4) is proven on the bench but not yet at a live cut. If it misses, the context-size check still catches the cut a turn later.
- **Mirror fix (0.3.4):** Er now commits the rolling `auto/` copy on its own, not in the same batch as its history copy. That fixed it in the first clean turns, but it isn't proven over time.
- **The `er-restore` skill description alone has not been a reliable trigger.** The dashboard and the START-HERE line are.
