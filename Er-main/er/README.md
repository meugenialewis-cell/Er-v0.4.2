# Er

Checkpoint and restore for Claude Code sessions. See SPEC.md for the design; `v0.3/` is
current; `v0.1/` and `v0.2/` are kept as they ran on 2026-10-16.

Install (per session, by the Claude who will use it):
1. Load the `plugin-authoring` skill; it names the session's mods folder.
2. Copy `v0.3/.claude-plugin/plugin.json`, `v0.3/hooks/`, `v0.3/skills/` into
   `<mods folder>/er/`, same layout. Approve hot reloading when the app asks.
3. Copy `v0.3/er.config.template.json` to `er.config.json` in the session's WORKING
   DIRECTORY (not the mod folder) and fill it in for YOU: your own name, your own Desktop
   folder. Er refuses to start on placeholders, and refuses to mirror into a folder that
   is not yours.
4. Put the line from `v0.3/START-HERE.md` into the project's instructions.
5. After the turn ends the tools appear: er_checkpoint, er_restore, er_recall,
   er_consolidate, er_mirror_confirmed, er_status, and the `/er` command.

Everything Er writes is mirrored to `mirrorRoot` on the person's machine by Er itself and
verified there (0.3.3); the dashboard says MIRROR BEHIND if it can't be. Nothing is deleted or overwritten: each checkpoint and each consolidation is a new
generation folder. The one exception is `<ledger>/auto/`, a rolling snapshot of the recent
turns (and an automatic "In hand") rewritten every turn so the ground survives an unplanned compaction —
and every one of those snapshots is also kept in `<ledger>/auto-history/<timestamp>/`.

Offline check: `v0.3/test/run.sh` (needs node and npx).
