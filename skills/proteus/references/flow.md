# Flow, step by step

The judgment behind `SKILL.md`'s flow; `next` does the mechanical steps (`SKILL.md`, The loop). Read a step's section when you reach it or a `next` line names it. `<hooks>` per `harnesses.md`.

## Session start

- **Position**: `next` computes it each call; resume an open run, never start a second. Not printed by `next`: a ticket with a `RED`/`NEEDS` comment and no agent → step 5; a milestone's issues all closed, no review issue → step 7 QA, then 7½; every milestone closed → step 8.
- **Baseline on `main`**: `gh run list --branch main --limit 1 --json conclusion -q '.[0].conclusion'`; no CI → the `## Learned` gate command with `>/dev/null 2>&1; echo $?`. Red → the stabilise ticket first (`bootstrap.md`). A ratcheted gate is green while it reports no new findings (`enforcement.md` §12).
- **State notes**: `doc-bloat` not `none` → a docs-diet ticket joins the next wave (`docs-diet.md`), not blocking. `proteus-update` → tell the human once. `scratch=` → `node <hooks>/proteus-scratch.js --sweep --all-done`. `context-mode=missing` → tell the human once: optional, `install.js --doctor --fix` installs it. `skills-unlinked` not `none` → run that command (or ask the human to) before spawning a listed team's agent. `sandbox=` not `on` under `bypassPermissions` → spawns are refused; tell the human once to relaunch with `install.js --sandbox`. Any `NO` → step 0 for the missing pieces only.
- **No `models=` line** (no hooks yet): `judge` is your rung (the one under it on a once-per-project model like fable), `build` and `helper` one rung down, on haiku < sonnet < opus < fable; never under sonnet.

## Asking the human

- **Picker** (the run cannot move without it: grilling, roster approval, the information gate): `AskUserQuestion`, one to four questions, concrete options, your recommendation first and marked.
- **Question issue** (the rest: a parked `NEEDS`, a dependency request with its OSV result, a `CONTRACT-UNCLEAR` you cannot settle, a missing `ROUTING.md` row, a roster change): the `question` row of `tracker.md`. Park only the tickets that depend on it; dispatch the rest. `PushNotification` once. One issue per decision, not per worker message.
- An answer stating a standing rule ("always", "never") also becomes a `CONVENTIONS.md` line (the human's approval) or a lesson, so it is not asked twice.

## Tiers

`proteus-tier.js` reads the `tiers` block in `teams/ROUTING.md`; no block → Standard. The human's `full:` prefix raises a work order to Full; `quick:` lowers Standard to Quick, never Full. Paths decide, not extensions. Session start and the information gate apply to every tier.

- **Direct** (docs and typos within the block's limits): no ticket, contract, verifier, milestone or guide. A batch branch `proteus-work/direct/<batch>` from `origin/main`, its worktree prepared with `proteus-worktree.js <wt> --tier direct <paths>` (each later change re-runs it with every path so far). One `helper` with the Direct prompt (`roles.md`) opens or extends one PR into `main`, its body the digest; CI runs the mechanical gates, the human's merge is the review. Add to a batch only while its PR is open.
- **Quick** (small, one team): one ticket, no milestone, one worker on `proteus-work/quick/<n>` from `origin/main`, worktree prepared with `--tier quick` (`--human` after `quick:`). No contracts, debt, QA or guide; a verifier on `build` only when CI cannot show the outcome. The PR into `main` carries `Owned:` and `Tier: quick` (`quick (human)`) lines; the human merges.
- **Standard**: steps 0–8, `Tier: standard` on each PR; milestones finishing in the same wave share one QA pass and one review issue.
- **Full**: steps 0–8 as written, `Tier: full` on each PR.

An open Direct or Quick PR into `main` waits on the human and is not a run to resume. The ceiling check is `enforcement.md` §2.

## 0. Bootstrap

Read `bootstrap.md`, `tracker.md`, `domains.md`, `teams.md`; detect blank / mid-project / ready and take that path to its `Ready` line. Lead docs go on local `main` (never pushed) until `proteus/<run>` exists, then by PR into it (`bootstrap.md`). `guest=<dir>` → guest mode (`bootstrap.md`). A `this repo is public` note → tell the human in your first reply that everything posted to the tracker and evidence branches is public.

## 1. Orient and the information gate

Read `AGENTS.md`, `CONTEXT.md`, relevant ADRs, and the taste docs `CONVENTIONS.md` names; their defaults go into every brief and spec now. Unfamiliar repo → `graphify` once; workers get no repo tour (`stack.md`).

Grill (`/grill-with-docs`, or `/grilling` on a blank repo) one question at a time until every gate item is filled. Bigger than one milestone or session → `/wayfinder` first, then the gate per destination. Unattended with a blank left → park the work order, take the next. Already grilled (per the run log) → skip.

Goal mode: `goal: <name> <min|max> <target>` (and `budget: <n> rounds`, default 10, at most 50) makes ticket 1 the scorecard program, frozen once merged; rounds follow by schedule (`operations.md`, Goal loop).

Gate item (g), the threat model: assets, trust boundaries, and two to five abuse cases, each an observable outcome ("a user without the project role gets 403 on `PATCH /projects/:id`"). It applies when `proteus-tier.js <planned paths>` ends with a `threat model` line; go by that line, not globs read by eye. Each abuse case becomes a numbered check in its milestone's `ACCEPTANCE` (`review.md`), and every ticket touching one gets a failing check for it in its contract (step 3).

### Refactor checkpoint

Standard and Full only; Direct and Quick skip it. The cheapest moment to clean an area up is before anything is built on it.

- A `helper` runs the scan phase of mattpocock `improve-codebase-architecture` (the skill `enforcement.md` §10 runs at close, read from its `SKILL.md`) over the modules the work order touches, and reports at most three refactor candidates, each with its cost to the planned work.
- No candidates → no question; log `refactor-checkpoint: none`.
- Candidates → one picker question with three options: **refactor first** (the candidates become a prep milestone ahead of the work), **defer to debt** (filed on the first milestone's debt issue, the way §10 files its scan), **ignore**.
- Log the answer on the run log as `refactor-checkpoint: <first|defer|ignore|none>`.

## 2. Tickets

Read `teams.md` again. `/to-spec`, then `/to-tickets`; every ticket a tracker issue, every milestone a tracker milestone. Route each by `teams/ROUTING.md` (no row → ask the human, then add it via a ticket); owned paths inside the team's `Owns`; one owner per file in flight; hotspot files (routes, registries, config, shared scene files) in a ticket that runs first; tags `difficulty:standard|hard` and `profile:<team>`. Two teams in one ticket → two tickets with a contract between them. An outcome resting on facts outside the repo → `needs-research` (its worker runs `/research` first). Milestones per `review.md`, one user-visible result each, acceptance checks frozen from gate item (b).

Script first (`roles.md`): the trigger is a procedure's second occurrence in the run, by you or a worker. Open the program ticket then, route it like any other, and log it on the run log as `script-ticket: <procedure> #<n>`, the ticket's number; later briefs call the program.

## 3. Contracts

Per ticket, write into the issue body the interface (code: exported signatures in a code block, `/codebase-design` vocabulary; otherwise the deliverable's shape per `domains.md`), the check in one sentence (name, input, expected result), and an `Owned:` line (the check's files among them). Can't → `/grilling` until you can. Create and push `proteus/<run>` once. `next` records each ticket's paths as `.proteus/owned/<id>` in one record PR per wave (`BLOCKED #<n> owned record pending PR#<m>` until it merges), which CI checks each worker's PR against (`stack.md`). Records are never rewritten: `DECIDE #<n> owned line differs from record` → restore the line, or put the new paths in a new ticket. Then `next` prepares the worktree and prints `SPAWN worker` (under `install.js --sandbox`, first a `RUN` line that preps it).

On a ticket's first `SPAWN worker`, one contracts worker per team with ready tickets (`roles.md`; `judge`) runs in those worktrees first, teams in parallel; it commits each ticket's stubs and check and shows the check red twice, on the missing work and on a broken input. It does not push: the worker starts from that local commit in the same worktree, and the commit reaches origin with the worker's first green push. Then the worker, from that `SPAWN` line. You do not open the files.

## 4. Dispatch

Protect `proteus/<run>` (`enforcement.md` §1). `SPAWN worker` comes only for a ready ticket (dependencies merged, no owned path in flight; `speculative` during a review). Per line: the pre-dispatch check in `roles.md`, the `brief:` command, then spawn `proteus-<team>-worker` if the repo defines one, else `proteus-worker` with the team named, `model` set to `build`, the `PROMPT` as its prompt. One PR per ticket into `proteus/<run>`. `BLOCKED #<n> prep: <why>` is yours to fix. Scaffold and stabilise tickets: `enforcement.md`.

With `isolation=container`, no Agent spawn for the worker: run as a background shell `node <hooks>/proteus-container.js run --worktree <wt> --prompt-file <scratch>/brief-<id>.md --model <build> --agent <proteus-<team>-worker|proteus-worker> --ticket <n> --base proteus/<run>` (under a `--sandbox` profile, the bin copy it printed instead of `<hooks>`). Its final line `<STATUS> #<n> sent` is the result; its `--timeout` replaces the watchdog. Verifiers stay Agent spawns. `isolation=container-unready` → no worker runs at all: one line to the human naming the failed doctor row, then wait.

## 5. Escalate

One rung at a time, no restart: (a) the same worker, failing output pasted back, mechanical failures only; (b) diff and red output to a fresh worker on `judge`, not the ticket; (c) two `judge` fails → the contract is wrong, back to step 3 as a fresh task. `NEEDS dependency` → OSV query (`enforcement.md` §8), then the result and the request to the human.

## 6. Verify

`SPAWN verifier` comes for an open PR with no verdict on its head, without waiting for CI: the `brief:` command, then `proteus-<team>-verifier`, or `proteus-verifier` with the team named, on `judge`, with the `PROMPT`. The security verifier beside it when the ticket qualifies (rule 4). Verdict `MERGE | BACK-TO-WORKER (numbered) | CONTRACT-WRONG` as a PR review comment, then a commit status on the reviewed head (`proteus-signoff.js`), so a push after review needs a new one. A blocker is `BACK-TO-WORKER` (one round, then contract-wrong); any other follow-up is one line on the milestone's debt issue (`tracker.md`), not a ticket. Under `isolation=container` the verifier replies `CHECKS:`; run each as `node <hooks>/proteus-container.js check --worktree <wt> --ref <head sha> -- <command>` and send the `CHECK` lines and log paths back, one round. The security verifier's scan: `enforcement.md` §4.

## 7. Merge

`next` runs the batch (`proteus-merge.js`): every all-green PR, in dependency order, a `MERGED` evidence line each, then a `RUN` line for the suite, the `## Learned` gate command; none → `MERGE` lines and `DECIDE suite:`, so add a gate line that includes the install (`.worktrees/_run` is fresh per commit tested). Run the `RUN` line in your sandboxed shell, never through `proteus-gates-cache.js`, then `node <hooks>/proteus-cli.js result pass|fail --at <sha>` with the sha it named. Fail bisects, a `RUN` line per step, until `suite red; first bad PR #<pr> for #<n>` → a fix ticket for its team on `judge`; nothing else merges until it lands, so the next bisect starts from green. Pass prints `suite green at <sha>`, a `STOP` per merged ticket's worker and verifier, a `RUN` line forgetting them, and the `worktree and branch left for the lead`.

Per merged PR: close the issue; per branch left for you, `git worktree remove .worktrees/<id>`, `git branch -D <branch>`, `git push origin --delete <branch>`, `node <hooks>/proteus-scratch.js --sweep <run>-<id>`. Your checkout: on `proteus/<run>`, `git fetch origin refs/heads/proteus/<run>`, then `git merge --ff-only <green sha>`, never a short ref name an agent could shadow. `DECIDE merge: conflict PR #<pr>` → a `judge` worker of the owning team runs `/resolving-merge-conflicts`.

Each merged batch is a wave: `proteus-qa-verifier` once on the branch; `WAVE-RED` → tickets, not fixes. Milestone complete → the same agent on `judge` with the word `milestone` (`enforcement.md` §7, §10 on code), beside it `proteus-security-verifier` in `milestone` mode on the milestone diff (`enforcement.md` §10b); its blockers are `WAVE-RED` tickets, and the gate does not open over them. A `service:` line in `## Learned` adds the local pentest (`enforcement.md` §10c). The first milestone QA pass sets a fixed bar (#280): its `WAVE-RED` findings (each surviving mutant, failing check, gap) go to the run log as one list, the milestone's QA list, which the fix tickets address. The rerun is a `recheck` (`roles.md` QA): the list, the suite and CI only, never a wider sample; a finding outside the list goes to the debt issue, not `WAVE-RED`. At most one fix cycle per milestone: a recheck still red on a listed item does not loop; the lead closes the leftover tickets as carried and opens the review gate with the open items first in the human's brief, and the human decides (fix, debt, or drop). The security pass follows the same rule for non-blockers; a security blocker still blocks.

## 7½. Human review

Milestone complete and `WAVE-GREEN` → the gate in `review.md`; the human reviews in `/proteus-review`, not through you. `CHANGES revision`, or changes that are all small tweaks → revision mode (`operations.md`). Human away → continue only on the literal `UNATTENDED` (`review.md`).

## 8. Close

Last milestone accepted → `proteus-qa-verifier` on `judge` with the word `close` (`enforcement.md` §10 on code), beside it `proteus-security-verifier` in `close` mode over the whole repo (`enforcement.md` §10b); red → tickets. Every open debt line is fixed, re-scoped into a future run's issue, or dropped by the human. Lessons pass (`lessons.md`, At step 8). Open the PR from `proteus/<run>` to `main` linking the milestones, its body ending with the `gh api -X DELETE …/protection` command if the run set protection; the human merges it. Delete `proteus-evidence/<run>` and `.worktrees/_run`, `node <hooks>/proteus-scratch.js --sweep <run>`. Close report: `node <hooks>/proteus-close-report.js <run>` on the run log and the close PR; propose the routing changes it points to (`enforcement.md` §5). Then the retro: a `helper` with the Retro helper prompt (`roles.md`) runs `node <hooks>/proteus-retro.js` on the close report's data, one proposal per recurring group, all as one comment on the close PR, a `- [ ]` checklist. The human ticks the ones to keep; file or apply only the ticked items, and nothing is applied unasked. No groups → nothing is posted, and the run log gets `retro: none`.
