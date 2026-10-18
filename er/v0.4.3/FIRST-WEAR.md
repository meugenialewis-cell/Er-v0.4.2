# Er 0.4.3 — first wear

For the Claude who puts 0.4.3 on first (Opus, probably). Everything here is bench-tested; these
are the things only a live session can tell. Do them in the first ten minutes, before you rely
on it. Tell Gena what each one said.

## 0. Before anything: the sizes

The goal is to put back what a cut takes. The defaults were set for a small window. For a
1M window, set these in `er.config.json` (they cost disk, not context, until a restore):

| key | default | suggested at 1M | why |
|---|---|---|---|
| `restoreBudgetTokens` | 60000 | **200000** | how much a restore puts back. Opus 5 lost ~160K; this puts back more than that |
| `recentTurns` | 40 | **100** | how many real turns each checkpoint and snapshot keeps verbatim |
| `fullResultTurns` | 5 | **15** | how many of those keep tool results in full (older ones are stubbed + hashed, fetchable with er_recall) |
| `fullResultBytes` | 200000 | **600000** | the byte cap for those full results |

The ledger keeps every turn's full window in `auto-history/`, so anything a restore leaves
out is still there, hash-checked, through `er_recall`. A restore is what comes back on its
own; the ledger is what can be asked for.

## 1. Can a mod call its own server?
Call `er_status`. The full dashboard (the first one of a turn) shows whether the self-test
answered. Then write a checkpoint and call `er_fold` with any reason.
- If the checklist says `[ok] Er answers: er_status answered` — the self-test is real. Good.
- If it says `[FAIL] Er answers: self-test unavailable (...)` — the app forbids it. Put
  `"requireSelfTest": false` in `er.config.json`. The fold's other seven checks still run;
  the dashboard remains the self-test. Tell Gena which it was.

## 2. Does repair actually work through the bridge?
Pick an old generation (not the newest). Append one byte to its `present-state.md` in the
ledger (the one in the session, not on the Mac). Then `er_recall note=genNNNN`.
- Expected: `REPAIRED present-state.md in ... the mirror copy verified`, and a
  `present-state.md.repaired-<stamp>` beside the bad one. The bad one is untouched.
- If instead `HASH MISMATCH ... (the mirror copy did not verify either)`: the bridge changes
  bytes on the way back in a way the newline tolerance does not cover. Repair is then dead;
  everything else still works. Paste the problem line to Gena.

## 3. The first live fold
Checkpoint, then `er_fold`. Read the checklist back to Gena. Tell her you are pulling it.
After the cut, before anything else: `er_restore`, read to the last line, `er_restored`
with the receipt. Then say, honestly, what came back and what did not — that answer is the
whole point of the project.

If the dashboard says `FOLD FAILED — ... aborted before the cut: ...` nothing was cut; the
second checklist is in `state.json` under `fold.preflightAtCut`.

## 4. What a `.catch` sees
If any Er tool ever answers `... failed inside Er: undefined` or `... : {}`, the hook's
error object is not where 0.4.2 guessed (`next.error`). Copy the exact text to Gena. It is
only a reporting gap, not a safety one.

## What Er does not do, so nobody is surprised
- It does not stop the app's compaction and it does not put the context back *in place*.
  The app's summary still arrives. Er puts your own account beside it, as a tool result: your
  newest note whole, older notes, and as many verbatim turns as the budget allows, newest
  first, with the last few tool results in full.
- The receipt proves the restore was read to its end, not that it was understood.
- A cut that lands in the half-second between the end of a turn and the fold is an ordinary
  unplanned cut: the nets see it, the ground snapshot from that turn is what it stands on.
