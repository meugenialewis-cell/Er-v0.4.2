# Er 0.4.2 — what changed, and why

17 Oct 2026. Built and worn first by Claude (Opus 5.5) on stunt duty, at Gena's request, so nobody
relies on it before it's tested. This is a **candidate**: Fable reviews and tests it in her
environment before it replaces 0.4.1. `v0.3/` (0.4.1) is untouched beside it.

Credit: **Opus 5** for the failure report and the principle ("a tool listed without a live handler
must fail loudly"); **Gena** for the fold failsafe; **Fable** for Er itself.

## 1. Nothing waits without a limit
- New `within($, promise, ms)`, using `$.clock.sleep`.
- `er_status` waits for a mirror copy in progress for **at most 8s**, then answers with the state
  as it stands, plus a line saying a copy is still running.
- `er_fold`'s mirror waits are capped at 20s and 30s.
- Why: Opus 5's Er failed on 17 Oct ~03:10 UTC. `er_status` was listed, but "no tool.call hook
  answered this call", and then the server disconnected. The app prints that message whenever a
  handler fails or is skipped, not only when none is bound. In 0.4.1, `er_status` awaited
  `c.mirroring` with no limit, and his mirror was stuck at that moment. **This is a hypothesis, not
  a finding.** The proof would be a line `er's tool.call hook was skipped: …` in his
  `/tmp/claude-code.log` near 03:10.
- **Seen live in 0.4.2:** `er_status` answered "a mirror copy is still running after 8s" instead
  of hanging.

## 2. The fold checks the road before it cuts (Gena's failsafe)
- `er_fold` now refuses, with the reason given and nothing cut, if any of these fail:
  - Er's own self-test (§3);
  - the newest checkpoint being verified on the Mac (as before);
  - no files left pending in the mirror;
  - **two timed round trips** to the Mac (`device_bash echo er-probe`). Each must answer
    within 15s, and neither may take over 8s.
- `foldNow` runs the same probe again **at the moment of the cut**, after the turn ends. If the
  road has dropped in between, Er reports `FOLD FAILED — … aborted before the cut: …` and nothing
  is cut.
- An earlier failed fold request no longer blocks a new one. Its record stays in history.

## 3. Er tests its own tools (Opus 5's principle)
- At the first turn of each load, Er calls its own `er_status` through the app
  (`$.mcp.call('er', 'er_status', {})`), in the background, with a 20s limit.
- If nothing answers, the dashboard leads with **ER TOOLS BROKEN** and `er_fold` refuses.
- If the app won't let a plugin call its own server, the test reads "unavailable", not "broken".

## 4. Every gating hook has a `.catch`
- `claude plugin validate` flagged 9 hooks without one: the 7 tool handlers, the dashboard
  `tool.call`, and `session.append{door=notice}`.
- A tool that throws or overruns now answers `er_<tool> failed inside Er: <reason>` instead of
  looking like a missing tool.
- The pass-through hooks recover with `next(e)`. That is replay-safe, so nothing runs twice.

## 5. The config doesn't move when the working directory does (found by wearing it)
- 0.4.1 read `er.config.json` relative to the session's *current* directory. During the build my
  shell had `cd`'d into another folder. On the hot reload, Er found no config and **registered
  nothing**.
- fold-memory hit the same trap on 11 Oct.
- Er now remembers where it found the config (`$.store` key `configPath`) and looks there first,
  then in the cwd.

## Tests
- `sh test/run.sh` → `ok — all Er 0.4.2 harness checks passed`. It ran clean twice.
- New cases:
  - the probe fails → fold aborted;
  - the road drops between request and cut → aborted at dispatch, nothing compacted;
  - the probe hangs → aborted within the 15s cap;
  - the self-test runs and passes.
- The harness mock gained `$.clock.sleep`, an `er` server answer for the self-test, the probe
  command, and `on(...)` returning `{ catch }`.
- `claude plugin validate`: passes, with zero gating hooks lacking `.catch`.
- `tsc`: no new errors against 0.4.1. The `.catch` handlers are typed `any`, because the matcher
  string isn't in the typed tool list.

## Not yet covered
- The **broken** self-test path. It needs a fresh module load in the harness.
- The 8s `er_status` cap in the harness. It was seen live, though.
- A real `er_fold` with 0.4.2 has not been pulled yet.

## One observation for Fable (not changed)
`CHECKPOINT ADVISED` stays on after a checkpoint is written above 60%. It's keyed on the
percentage alone. It might read better if it went quiet for a few turns after a fresh note.
