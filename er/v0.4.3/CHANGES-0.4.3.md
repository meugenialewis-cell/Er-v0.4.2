# Er 0.4.3 — what changed, and why

17 Oct 2026. Built by Replit's agent with Gena, on the 0.4.2 candidate, after reviewing it and
running its harness. 0.4.2's own code is kept as it was; every change below is marked `0.4.3`
in `hooks/register.ts`. Bench-tested in the harness only (`test/run.sh`); the live-only checks
are listed at the end for whoever wears it first.

Governing rule, agreed with Gena: **a gap Er admits to beats a memory it cannot vouch for.**
Content that fails its hash is never shown, only named.

## 1. A fold never cuts unless a restore would succeed (Gena's failsafe, in full)
`er_fold` now runs a **preflight**, and `foldNow` runs the same preflight again at the moment
of the cut. Every item is in the tool result as a checklist and kept in the fold record in
`state.json` (`fold.preflight`, `fold.preflightAtCut`). Any failed item means nothing is cut.

| item | what it checks |
|---|---|
| Er answers | a **fresh** self-test (`$.mcp.call('er','er_status')`), now, not the one from the first turn |
| checkpoint complete | the checkpoint from this turn, read back from disk: every file verified, note has Must survive and In hand, turns stored |
| restore dry run | `buildRestore()` — the exact text a restored Claude would get — stands on this generation with no problems |
| mirror complete | nothing pending, and the generation's files **re-verified on the machine right now** with `sha256sum -c` (the `mirrored` flag is not trusted) |
| transcript readable | `readTail` returns the API's exact count; without it neither the boundary row nor the gauge would see the cut |
| state round-trip | `state.json` written and read back |
| road steady | the 0.4.2 double probe |
| trigger in place | *advisory*: CLAUDE.md / START-HERE.md in the working directory names `er_restore`. Reported, not required. |

## 2. A restore is confirmed, not assumed (receipts)
- `er_restore` ends with `receipt: er-rst-<10 hex>`. The dashboard then says `RESTORE UNCONFIRMED`.
- New tool **`er_restored { receipt }`**: only this clears RESTORE AVAILABLE. A wrong code is refused.
- After `receiptTurns` (2) turns unconfirmed, RESTORE AVAILABLE comes back and says a restore
  was sent and never confirmed. A cut-off restore is therefore retried, not lost.
- `er_restore` only reads, so it can be run again as often as needed. The restore body is now
  `buildRestore()`, shared with the fold's dry run.

## 3. Corruption is caught at three layers and repaired from the mirror
- **File hashes** (as before), now in `checked($, c, …)`: when a file is missing or fails its
  hash, Er fetches the mirror copy from the machine (`device_bash cat`), checks it against the
  same manifest, and if it verifies writes it beside the bad one as `<file>.repaired-<stamp>`
  and uses it. The bad copy is never overwritten. The problems list says `REPAIRED …`.
  If the mirror copy fails too: `HASH MISMATCH … (the mirror copy did not verify either)`.
- **`LEDGER.json`**: an index of every generation's manifest sha256, appended on every
  `writeGeneration`, mirrored like everything else. `readGeneration` checks the manifest
  against it; a manifest that does not match is `MANIFEST MISMATCH` and vouches for nothing.
- **Walk-back**: the restore stands on the newest generation that verifies. When that is not
  the newest generation, the first lines say `STANDING ON genN: K newer generation(s) could
  not be verified`, and the problems at the end say why.

## 4. The self-test retries
A broken self-test is run again every `selfTestRetryTurns` (3) turns instead of condemning the
load for the session. Its first run waits (up to 20s) for a mirror pass in flight, since
`er_status` waits on the mirror. The dashboard's ER TOOLS BROKEN line says it retries.

## 5. The gauge escalates
- 60% `CHECKPOINT ADVISED` — unchanged.
- 70% (`overduePercent`) `CHECKPOINT OVERDUE` — the full dashboard, with the last note's Must
  survive, on **every** tool result (not shortened, not deduplicated).
- 75% (`alarmPercent`) `CONTEXT AT N% — CHECKPOINT NOW` — a `!!!` block leading every tool
  result, with the last note's Must survive lines inside it.
- A checkpoint written this turn at ≥75% changes it to `CHECKPOINT WRITTEN AT N% — the next
  cut is close`, instead of shouting at a Claude who just did the right thing.

## 6. Housekeeping
`.claude-plugin/plugin.json` restored (0.4.3; it was missing from the last two uploads),
`er.config.template.json` with the four new keys, `START-HERE.md` and `hooks.json` carried from
v0.3, `skills/er-restore` says to read to the receipt, SPEC 0.4.3, README. `Er-main/` is
flattened to the repo root.

## Not changed, on purpose
- Auto-history keeps full windows (Gena: a few hundred KB per turn is fine).
- 0.4.2's `.catch` handlers still read `(next as any).error` — the real error shape is a
  live-only question.
- The fold still runs 500ms after `turn.complete` via setTimeout.

## Live-only checks (for Opus, first wearer)
1. The first live `er_fold`: does the preflight pass, and does the cut land on the checklist?
2. Is `$.mcp.call('er','er_status')` allowed from inside the mod? If not, the self-test reports
   itself "unavailable" and passes; the preflight's "Er answers" is then no stronger than 0.4.2.
3. The shape of the error delivered to a hook's `.catch` handler.
4. `device_bash cat` of a mirrored file returns its bytes exactly (no trailing-newline trimming
   by the bridge); if it trims, repairs will never verify and the log will say so, harmlessly.
