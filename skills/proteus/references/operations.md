# Operations

Commands the human types mid-run, the stall check, scratch, and installs. Each runs before anything else in the turn it arrives in. `<hooks>` and other names per `harnesses.md`. Resume and compaction need nothing here: run `next`, which computes the position from the tracker on every call.

## `status`

One line, no prose: `node <hooks>/proteus-status.js`, then the running agents (`harnesses.md`): `workers: #12 lighting (41m), #14 camera (9m)`, one past twice the median marked `slow`. Nothing is dispatched or re-read.

## `questions` / `inbox`

`node <hooks>/proteus-inbox.js --refresh` lists open question and review issues. Per question, in order: read its body (`--json body -q .body`), present it with `AskUserQuestion` (its options, the recommendation first), post `Answered in session: <pick>` on the issue (not `ANSWER`, which only the human's login posts), act on it. Reviews go to `/proteus-review`; you don't relay one. Four questions per picker.

## `intake <urls|file>`

Videos with ideas, each turned into notes on the tracker for the next plan. URLs inline or in a file, one per line (blank and `#` lines skipped). No run needed; nothing goes in the repo.

1. `node <hooks>/proteus-intake.js --open` finds or creates the issue `Intake: <today>` and prints its number.
2. The themes: the owner's numbered goals for this intake, from the message or the work order; none stated → ask once (`AskUserQuestion`); every helper watches for them.
3. The video skill: a `teams/*/skills.txt` line that fetches or watches videos (`teams.md`, Skills); name its `SKILL.md` path in the brief. None → `yt-dlp` plus captions. Never assume a skill's path outside the project.
4. One helper per distinct URL with the Intake helper prompt (`roles.md`), in parallel, each on `helper`. Each posts one comment through `proteus-intake.js --post`.
5. When all have reported, one line per source: the URL, the findings count or `failed`, the issue link.
6. Synthesis: one Intake drafter (`roles.md`) on `judge` reads the notes, `gh issue list --state all` and the repo, and posts one draft comment on the intake issue: the drafted issues and a coverage table `proteus-intake-coverage.js` passed.
7. Nothing is filed until the human replies; wait on `node <hooks>/proteus-verdict.js <issue> --wait` (background, as for a review). `ACCEPT` → file the draft as posted. `CHANGES` with edits → apply them, re-run the coverage check until it exits 0, post the revised draft, wait again.
8. File each with `node <hooks>/proteus-gh.js issue create --label intake`: title, problem, change, acceptance, refs, supporting notes (finding ids), estimate and dependencies, draft numbers replaced by filed ones. Then one comment on the intake issue: the filed issues in dependency order, which can run in parallel, and the `candidate` rows left for the owner.
9. `node <hooks>/proteus-scratch.js --sweep intake-<date>`.

Finding ids are `<h>-F<k>` (`proteus-intake.js --help`). "note predates finding ids" → delete that note comment, `--post` again, re-run the drafter.

| Coverage outcome | Meaning |
|------------------|---------|
| `issue <k>` | drafted as issue `<k>`, whose supporting notes cite the id |
| `shipped <file>` | the repo already does it; the file that does |
| `candidate` | plausible, for the owner to decide; drafted nowhere |
| `rejected <reason>` | not worth doing, and why |

## `pause` / `resume`

`pause` (or its alias in `AGENTS.md ## Learned`, e.g. `gaming`) frees the machine now and keeps the position:

1. Post on the run log what `next` cannot derive: each running agent with its ticket and how far it got (its last report line, or `in progress`).
2. Stop every running worker and verifier (`TaskStop`; Codex `close_agent`) and every background shell you started. Worktrees and branches stay; nothing is merged, deleted, or reverted.
3. Have a subagent stop any detached heavy job the workers left (by the PID or log path in their reports) and confirm in one line the GPU and CPU are free.
4. `node <hooks>/proteus-watchdog.js --forget all`. Reply `paused at <position>`. Dispatch nothing until `resume`.

`resume`: run `next`, and re-dispatch each ticket the pause line names to a fresh worker on its existing worktree (`git worktree list`: an older run's are in `../<repo>-proteus/`) with `resume from the last commit on the branch; the previous worker was stopped, not failed`. A pause is not an escalation rung.

## Stall check

A worker that ends its turn waiting on a background job never wakes up. Two layers:

- **Mechanical.** In worker worktrees the hooks refuse background shells and a stop that talks about waiting instead of reporting.
- **Watchdog.** Each tool call and stop of an agent you spawned stamps its beat; `next` reads them every call. `NUDGE <agent>` (no tool call for 40 minutes, or stopped 10 minutes ago without a report) → message it: `status? report DONE/RED/NEEDS now, or continue in the foreground`; it stays quiet 20 minutes unless still silent. `STOP <agent> <reason>` (STALL-AGAIN: silent again) → stop it, `--forget <agent>`, and dispatch a fresh worker on the same worktree (not an escalation rung). Except after a classifier denial: an agent whose last output is `BLOCKED … classifier …` or a denied call is waiting on the human, not stalled: `--forget` it, relay the denial (`SKILL.md`, Asking the human) and dispatch nothing on that ticket until the human answers. An agent you stop yourself, `--forget` it; a forgotten agent stays forgotten. `WAIT` is the watchdog's `--wait`: it costs no model turn and exits on the first stall (it gives up after a day); then `next`. A busy but slow worker is not a stall; `status` shows each ticket's age against the median.

## Scratch

Agents write temp files, renders, clones and inspection worktrees under `node <hooks>/proteus-scratch.js --path <key>`, keyed `<run>-<id>` per ticket (its contracts worker included), `<run>` for QA and the guide; the hooks also ledger new temp-dir entries an agent names. `/tmp` is RAM: scratch left behind fills it until the OOM killer takes the terminal. Without context-mode, output too long to read whole goes here, read back with `grep`.

- **Ticket merged** (step 7): `--sweep <run>-<id>` after the agents are stopped.
- **Run closed** (step 8): `--sweep <run>`, which takes every `<run>-*` key with it.
- **Safety net**: `next` runs `--sweep --all-done` and `--stale` at most hourly (`SWEPT <n> <MB> MB`; a failure is one `NOTE`, go on). `--stale`: done and idle 72h, idle 7 days, or a sandbox temp root entry idle 72h. No hook sweeps: it deletes under dirs agents can write (#237). Without `next`, the session start's stale note names the sweep.

A sweep deletes only what Proteus made and prints the MB freed plus `kept <path>: <why>` for anything refused.

## Installs

An `install.js` run that changes `~/.claude/agents`, a plugin update or re-pin, or a session-start note that a patched agent was regenerated takes effect only in a new session. Tell the human to restart before the next spawn, and spawn no other agent type meanwhile: it lacks the role's tools, model and rules.

## Revision mode

For a review round of small taste tweaks ("warmer", "cut two seconds") where a ticket per tweak would outlast the tweak. The human asks for it, or asks to skip verification or go faster during review. A pipeline mode, not a deviation; log its start and end on the run log.

1. Open one revision issue `Revision <run>/<milestone> r<k>` labelled `proteus`, record the team's owned paths for it as `.proteus/owned/rev<k>` (a lead-docs PR, `stack.md`), and branch `proteus-work/<run>/rev<k>` from `proteus/<run>` once that merged.
2. One standing worker of the owning team (`build`; `judge` if the tweaks touch shared structure) takes tweaks one at a time from the issue comments. Each is an idempotent change in the team's owned paths that rebuilds the result from the repo, not a file under `out/`, `/tmp`, or a GUI-only change. It commits and posts the evidence as a comment before the next.
3. The human is the per-tweak verifier: `ok`, or a note that becomes the next tweak. A human hand edit to an artifact is logged on the run log at once and becomes the next tweak: port it to the script.
4. Close: the human says `done`. One verifier (`judge`) on the cumulative diff, checking also that every change sits in owned paths and a clean rebuild reproduces the approved evidence (else `BACK-TO-WORKER`). `MERGE` → merge into `proteus/<run>`, stop the worker, and post the new evidence on the milestone's review issue.

Revision mode adds no scope. A note needing a new deliverable or a second team is a ticket for the next wave.

## Goal loop

For work with a measurable target (render time, bundle size, a score against a reference) rather than a feature list. The work order carries `goal: <name> <min|max> <target>` (`min`: lower is better) and may carry `budget: <n> rounds` (default 10, at most 50). Sandbox only: `proteus-goal.js` refuses otherwise.

1. Ticket 1 is the scorecard: a program in `scripts/` with `--help` whose last stdout line is `SCORE <number>`, exit 0. Once merged, record `scorecard: <path>` under `## Learned`; it is frozen: no later ticket owns it, and the verifier rejects any diff touching it (`roles.md`). Log the goal, budget and cadence on the run log.
2. `/schedule` a recurring `goal round for <run>` at the human's cadence (default daily); without `/schedule` the human types it per round.
3. Each round: `node <hooks>/proteus-run-tree.js <proteus/<run>'s tip sha>`, then `node <hooks>/proteus-goal.js round --run <run> --scorecard <path> --goal "<name> <min|max> <target>" --budget <n>`; under `isolation: container` add `--worktree .worktrees/_goal` (a worktree on `proteus/<run>`). Append its `goal-round: <k> score <v>` line to the run log as printed.
4. `NEXT <k> score <v>` (exit 0): open one improvement ticket naming the current score and the goal, routed like any other; it merges through normal verification.
5. `STOP target <v>`, `STOP budget`, `STOP falling <prev> -> <v>` or `STOP error <reason>` (exit 1): delete the schedule and post the trend table on the review issue (`review.md`). Exit 2 is a usage error or the sandbox refusal: fix it; the loop does not stop on it.
