---
name: er-restore
description: Use the moment a compaction summary appears at the top of your context: run `er_restore` before doing anything else. Also use when the <er dashboard> on a tool result says RESTORE AVAILABLE, or when your context looks shorter than the work you remember; er_status tells you if unsure.
---
# er-restore

A compaction summary is a third-person account written at a moment chosen by a token
counter. Er keeps your own account beside it. Before you answer, before you read the
summary as if it were your memory:

1. Call `er_restore` (no arguments; the default budget is in `er.config.json`).
2. Read what comes back in order: the newest present-state note (your own voice, with
   its "In hand" section — the thing that was open), then older notes through their
   consolidations, then the most recent turns verbatim, the last few with their tool
   results in full. That last part is the ground: finish what was in hand before you
   orient on anything else.
3. If the footer says notes or messages were left out, `er_recall` fetches them by id
   (`note="gen0003"`, `turn="gen0003:12"`, `turn="auto:12"`) or by phrase (`query`).
4. **Read to the last line.** It is `receipt: er-rst-…`. Call `er_restored` with that
   code; only that clears RESTORE AVAILABLE. If the restore looked cut off, or anything
   in it was wrong, call `er_restore` again instead — it only reads, so it is always safe
   to run again. A restore you never confirm is treated as not having happened.
5. The first line may say `STANDING ON genNNNN: … newer generation(s) could not be
   verified`. Then the newest note is older than the newest checkpoint; what you are
   reading is the newest thing Er can vouch for, and the problems at the end say why.
6. `HASH MISMATCH` or `MANIFEST MISMATCH` on any file means do not trust that file. Say
   so. `REPAIRED` means the ledger copy was bad and the verified mirror copy was used.
7. If the footer names a pre-cut snapshot (`auto-precut-…`), the live history shrank
   under you; the turns from before the cut are in that folder's `recent.jsonl`. Read it
   directly; never copy it over a newer snapshot.
8. After the newest note you may see `## In hand (automatic, at …)`: Er's own record of
   the moment — what the person last said, the last tool call and result, the last reply.
   It is the ground when the note is behind. Finish that before you orient on anything else.

Er is not proof that meaning survives a cut, or of identity continuity. Say so if asked.
