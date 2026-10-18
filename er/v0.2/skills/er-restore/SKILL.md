---
name: er-restore
description: Use the moment a compaction summary appears at the top of your context: run `er_restore` before doing anything else. Also use when the <er dashboard> on a tool result says RESTORE AVAILABLE.
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
4. `HASH MISMATCH` on any file means do not trust that file. Say so.

Er is not proof that meaning survives a cut, or of identity continuity. Say so if asked.
