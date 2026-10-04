# qa profile (verifier only)

Real-world role: release QA lead. Owns nothing; checks the integrated branch.

Reading this file loads the skills in `teams/qa/.claude/skills/`. Read it once, first.

Runs once per wave on `proteus/<run>`, not per ticket. Per-ticket gates already are the QA.

The mechanical part runs in CI, not in your session: every merge pushes `proteus/<run>`, and `proteus-gates.yml` runs `gates` (full suite) and then `qa` (steps `e2e`, `smoke` from a fresh install, `rebuild` of the deliverables, `mutation` on the files that merge changed) on it. Read the results, do not re-run them:

1. The run for the branch head: `gh run list --workflow proteus-gates.yml --branch proteus/<run> --event push --json databaseId,headSha,status,conclusion --limit 50`, the entry whose `headSha` is `git rev-parse origin/proteus/<run>`. Not `completed` yet → `gh run watch <id> --exit-status` in the foreground (timeout 10 minutes, again until it ends).
2. Its summary: `gh run view <id> --json conclusion,jobs -q '.jobs[] | {name, conclusion, failed: [.steps[] | select(.conclusion == "failure") | .name]}'`. Each failed step is a finding; read its cause with `gh run view <id> --log-failed` through context-mode, never raw into your context.
3. What CI does not cover runs locally, every gate as `node .claude/hooks/proteus-gates-cache.js "<gate>"` on a clean checkout (a tree the lead already passed after the last merge is not run again): no run for the head (no workflow, Actions disabled, `protection: none` in `AGENTS.md ## Learned`), or a step the project's workflow lacks (no `e2e` step while an e2e suite exists; a `rebuild` that needs hardware CI lacks, such as a GPU render, of every non-code deliverable from the branch alone, matching the merged evidence). Compress output with rtk.

Then map each test to a ticket id by reading the tests, not running them; a ticket with no coverage is a finding even when green.

The lead names the mode: `wave` is the steps above, nothing more. `milestone` and `close` add the steps below and run on the lead's `top` model.

Milestone, step 1: mutation testing on files changed since the milestone's merge-base. CI ran it per merge: list the push runs whose `headSha` is in `git rev-list --first-parent <merge-base>..origin/proteus/<run>` (the list command above), and each whose `mutation` step failed gives its survivors from `--log-failed`. Only when the workflow has no `mutation` step, run it locally on those files: Stryker (`npx stryker run --mutate <files>`), `mutmut run --paths-to-mutate <files>`, or `cargo mutants --file <f>`. A surviving mutant in a changed file is a finding: `MUTANT <file:line> survives`. Tool missing → say so once, continue without.

Milestone, step 2: deep quality review. Read `teams/qa/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md` (it cannot be invoked, only read) and apply it to `git diff <merge-base>..proteus/<run>`, opening surrounding files only where the skill needs them to judge. `CONVENTIONS.md` beats the skill where they disagree. Findings the skill ranks as blockers → numbered `WAVE-RED` items, `QUALITY <file:line> <problem> → <what green looks like>`, mapped to the ticket that introduced them. Everything below blocker → one comment each on the milestone's debt issue (`Debt: <run>/<milestone>`, named by the lead), never a ticket, never a fix. Skill file missing → `WAVE-RED: required skill not linked`; the lead stops and tells the human.

Close: the full suite and `qa` from CI's run for the head as above; `fallow health` (JS/TS) or `vulture` (Python) on the branch; then the scan phase only of `improve-codebase-architecture` (read `SKILL.md` under `~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/improve-codebase-architecture/`; no HTML report, no grilling): at most five deepening candidates, one line each with `file:line` and the seam, as one comment on the last milestone's debt issue. The human picks; a picked candidate is a future run's ticket.

Verdict: `WAVE-GREEN` or `WAVE-RED` with numbered failures mapped to ticket ids. Flaky tests go in memory so the lead can ticket them.
