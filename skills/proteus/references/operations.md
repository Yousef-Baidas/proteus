# Operations

Commands the human types mid-run, the stall check, and scratch. Each runs before anything else in the turn it arrives in. `<hooks>` is `.claude/hooks`, `.codex/hooks` on Codex; other names per `harnesses.md`.

## `status`

One line, no prose around it:

1. `node <hooks>/proteus-status.js` prints run, open milestone, tickets closed/total, open PRs and verdicts, and an ETA from the median ticket duration of this run.
2. Append the running agents from your own task list (Codex: the agents you spawned and have not closed): `workers: #12 lighting (41m), #14 camera (9m)`. An agent past twice the median is marked `slow`.

Reply with those two parts on one line. Nothing is dispatched, nothing is re-read.

## `questions` / `inbox`

`node <hooks>/proteus-inbox.js --refresh` lists open question and review issues. For each question, in order: read its body (`--json body -q .body`), present it with `AskUserQuestion` (its options, the recommendation first; Codex: as a plain numbered question), post it on the issue as `Answered in session: <pick>` (never `ANSWER`, which only the human's login posts), act on it. Reviews are listed with a pointer to `/proteus-review`; you never relay one. Four questions per picker at most; more → the next picker.

## `pause` / `resume`

`pause` (or the alias the human recorded in `AGENTS.md ## Learned`, e.g. `gaming`) frees the machine now and keeps the position:

1. Post the position on the run log: step, wave, each running agent with its ticket and how far it got (its last report line, or `in progress`).
2. Stop every running worker and verifier (`TaskStop`; Codex `close_agent`), and every background shell you started. A worker's worktree and branch stay; nothing is merged, deleted, or reverted.
3. Tell a subagent to stop any detached heavy job the workers left (render, encode, training, test farm): find it by the PID or log path in their reports, stop it, confirm the GPU and CPU are free in one line.
4. Delete the stall-check cron (Codex: stop the timed waits). Reply `paused at <position>`. Dispatch nothing until `resume`.

`resume`: read the position line from the run log, re-arm the stall check, and re-dispatch each interrupted ticket to a fresh worker on its existing worktree with `resume from the last commit on the branch; the previous worker was stopped, not failed`. A pause is not an escalation rung.

## Stall check

A worker that ends its turn waiting on a background job never wakes up; nothing tells the lead. Two layers:

- **Mechanical.** In worker worktrees `proteus-worker-guard.js` refuses `run_in_background` Bash and `Monitor`, and `proteus-stall.js` refuses a stop whose last line is not a report (`DONE #`, `VERDICT #`, `RED #`, `NEEDS `, `BLOCKED `, `WAVE-`) but talks about waiting. The lead's `SubagentStop` and `TeammateIdle` run the same check. Codex has `SubagentStop` only, and its hooks cannot see a background shell.
- **Timer.** At dispatch, arm it once per wave with `CronCreate`: cron `*/20 * * * *` (pick an off-minute start), prompt `proteus stall check <run>`. Codex has no cron: wait on the workers with `wait_agent` and `timeout_ms: 1200000`; each return without a report is a fire. When it fires: compare each running agent's age against the ticket median (`proteus-status.js`) and its branch's last commit time. No commit and no report for 40 minutes, or past 3× the median → message it (`SendMessage`; Codex `send_message`): `status? report DONE/RED/NEEDS now, or continue in the foreground`. Still silent at the next fire → stop it and dispatch a fresh worker on the same worktree (not an escalation rung). Delete the cron when the wave's last PR merges; recurring crons also expire after seven days.

## Scratch

Agents write temp files, renders, clones and inspection worktrees under `node <hooks>/proteus-scratch.js --path <key>` (`<git-common-dir>/proteus/scratch/<key>/`), keyed `<run>-<id>` per ticket, `<run>` for contracts, QA and the guide. `/tmp` is RAM; a run that leaves its scratch behind fills it until the OOM killer takes the terminal. The same hook watches every Bash call, the lead's included: a new entry directly in the temp dir, owned by this user and named in the command or its output, is ledgered under the agent's key. Without context-mode, this dir is also where an agent puts output too long to read whole, and reads it back with `grep`.

- **Ticket merged** (step 7): `--sweep <run>-<id>` after the agents are stopped.
- **Run closed** (step 8): `--sweep <run>`, which takes every `<run>-*` key with it.
- **Safety net**: the autostart runs `--sweep --stale` in the background each session (done and idle 72h, or idle 7 days); `proteus-state` shows `scratch=<MB>` over 1 GB, and then `--sweep --all-done` clears every key whose branch is gone.

A sweep deletes only ledgered entries and scratch dirs, re-checks each (same inode, this user, directly in the temp dir), unlinks a symlink without following it, removes a git worktree with `git worktree remove --force` and `prune`, and prints the MB freed plus a `kept <path>: <why>` line for anything it refused, such as a locked worktree.

## Revision mode

For a review round of small, taste-driven tweaks ("warmer", "lower the camera", "cut two seconds", "reword the intro") where a full ticket, contract, and verifier per tweak would take longer than the tweak. The human asks for it, or asks to skip verification or go faster during review. It is a pipeline mode, not a deviation; log its start and end on the run log.

1. The lead opens one revision issue `Revision <run>/<milestone> r<k>` labelled `proteus`, and branches `proteus-work/<run>/rev<k>` from `proteus/<run>`.
2. One standing worker of the owning team (`mid`; `top` if the tweaks touch shared structure) takes tweaks one at a time from the issue comments. Each tweak is an idempotent change committed into the team's owned paths, a script or source edit that rebuilds the result from the repo, never a file under `out/`, `/tmp`, or a GUI-only change. It posts the evidence (render, still, excerpt, number) as a comment and commits before taking the next tweak.
3. The human is the per-tweak verifier: `ok`, or a note that becomes the next tweak. A hand edit the human makes to an artifact is logged on the run log at once and becomes the worker's next tweak: port it to the script.
4. Close: the human says `done`. Then one verifier (`top`) on the cumulative diff of `proteus-work/<run>/rev<k>` with two checks beyond the team checklist: every change sits in owned paths, and a clean rebuild from the branch reproduces the approved evidence. `MERGE` → merge into `proteus/<run>`, stop the standing worker, and the milestone's review issue gets the new evidence for the verdict. Anything it cannot reproduce is a `BACK-TO-WORKER` before merge.

Revision mode never adds scope. A note that needs a new deliverable or a second team is a ticket for the next wave.
