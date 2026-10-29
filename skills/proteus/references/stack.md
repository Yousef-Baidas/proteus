# Stack and worktrees

## Who loads what
| Tool | Lead | Worker | Verifier |
|---|---|---|---|
| graphify | once, unfamiliar repo | – | – |
| LSP plugin / Serena | – | yes | yes |
| ponytail | – | full on Quick and mechanical tickets | – |
| caveman | lite | full | lite |
| rtk + context-mode (optional) | yes | yes | yes |
| code-review-graph | – | – | yes |
| fallow (JS/TS) | `health` at close | `dead-code` on owned paths | `dupes` on diff |
| vulture / vulture-rs (Python) | close | `--min-confidence 80` owned paths | diff |
| ripgrep | yes | yes | yes |
| anti-slop oxlint rules (JS/TS) | – | via lint gate | via CI |
| thermo-nuclear review | – | – | QA, per milestone |
| improve-codebase-architecture | – | – | QA, at close |

caveman owns prose, ponytail owns code size, rtk + context-mode own tool output. Chisle covers all three in one ruleset; beside them it restates caveman and ponytail and the prose styles fight, so it is not in the stack. Its one uncovered axis, eliding oversized non-Bash tool output, is optional: install with `CHISLE_DEFAULT_MODE=off` so only the compress hook runs, and never let it elide spawn output (`Agent`, `wait_agent`), where verdicts arrive.

One graph tool per role. Workers get no repo tour; if one asks for context, fix the ticket. Missing tool → note once in the task list, continue.

## Context budget (200k lead)
The lead reads no worker output or diffs (the verifier does) and produces no deliverable (`SKILL.md` rule 1). It holds: skill, issue numbers, contracts, task list, one-line verdicts; tracker reads go through `--json … -q` (`tracker.md`). `proteus-journal.js` meters context from the transcript: at `PROTEUS_HANDOFF_AT` (default 75% of the lead's context window) it tells the lead to finish the step, log the position, and `/handoff`; at `PROTEUS_HANDOFF_HARD` (default 90%) the guard refuses new spawns until it does. The window is the smallest of the model's nominal one, the harness cap the human set (Claude Code `autoCompactWindow`, Codex `model_auto_compact_token_limit`) and `contextWindow` in `~/.claude/proteus.json`, else 200k. Workers and verifiers are unaffected by a lead restart. Set both lower on a 200k model if compaction still fires first.

## Worktrees
```
git checkout main && git pull --rebase origin main   # merged work under the unpushed lead docs
git checkout -b proteus/<run> main
# write .proteus/owned/<id> per ticket: its owned paths and globs, one per line
git add .proteus/owned && git commit -m "chore(proteus): record owned paths for <run>"
git push -u origin proteus/<run>
git worktree add .worktrees/<id> -b proteus-work/<run>/<id> proteus/<run>
node <hooks>/proteus-worktree.js .worktrees/<id> <owned paths…>   # the same paths as .proteus/owned/<id>
git rev-parse proteus/<run>   # fork point, record in task
```
`<hooks>` per `harnesses.md`. On Codex run each line as its own command: a `cd`, pipe or `$(…)` keeps git and `gh` inside the sandbox (`harnesses.md`).
Worktrees live in `.worktrees/` (Direct `direct-<batch>`, Quick `quick-<n>`), git-excluded by `proteus-worktree.js`; an older run's stay in `../<repo>-proteus/` (`git worktree list`). The lead makes each ready ticket's worktree at step 3, forked from `proteus/<run>` after its dependencies merged; the contracts worker commits the contract there and the ticket's worker continues on that branch. Worker branches are `proteus-work/<run>/<id>`, outside `proteus/`, so a rule on `proteus/*` binds run branches and leaves workers free to push (`enforcement.md` §1). An older run keeps `proteus/<run>-<id>`; the hooks read both.
Owned-path records. `.proteus/owned/<id>` on `proteus/<run>` is what CI's `owned paths` step checks a worker's PR against (`enforcement.md` §2), read from the base and never from the PR, so it is written by the lead and changes only by a merged PR. The run branch's first commit carries the record of every ticket known then. A ticket added later (a fix ticket, a `WAVE-RED`, a contract rewritten, a revision branch) gets its record through the lead-docs PR (`bootstrap.md`; a verifier signs it off like any PR), merged before its worktree is cut with `gh pr merge <pr> --merge --match-head-commit <the sha you pushed>`, so a commit you did not push fails the merge. Records stay on the branch and reach `main` with the run; ids are issue numbers, so the next run does not collide with them. `proteus-worktree.js` warns when the paths it is given differ from the branch's record.

Per worktree: own dev-server port (`.env.local`), own DB/container/SQLite, own install dir. Shared services are why "passes alone, fails together". Binaries outside the worktree (a symlinked `.blend`, an absolute path to a media library or a spreadsheet) are shared too: one writer at a time, or each worktree builds its own copy from the committed scripts. A check that reads the shared original while a worker writes it measures nothing (`domains.md`).

Merge (`proteus-merge.js`, `flow.md` step 7): `gh pr merge <pr> --merge` per ready PR, no `--delete-branch` (a branch a worktree holds cannot be deleted, and gh would run its own git here); the script writes no ref, so the lead fetches and fast-forwards its checkout on `proteus/<run>` (`git fetch origin refs/heads/proteus/<run>`, then `git merge --ff-only <sha>` with the full sha the script's `suite green at <sha>` printed, origin's tip and the commit the lead tested, or nothing when they differ, never a short ref name such as `origin/proteus/<run>`, which a planted `refs/tags/origin/...` would shadow). Suite and bisect run in `.worktrees/_run`, a repo of its own that reads the project's objects and nests no worktree for vitest, jest or eslint to walk: for each commit to test the lead runs, sandboxed, `node <hooks>/proteus-run-tree.js <sha>`, which makes `_run` anew and checks that commit out there (so the suite does its own install), then the suite there (Codex: `workdir`, no `cd`), bare, never through the gates cache, which refuses below a checkout's top; removed at close. The lead reports pass or fail to the script with `--at <sha>`, the commit it tested; the script refuses a result for any other commit and bisects a red one. After the batch the lead removes each merged worktree and deletes its branch, locally and on origin.

More than ~6 parallel workers or multi-repo → hand worktree lifecycle to Composio Agent Orchestrator or Conductor; keep this skill for judgement.
