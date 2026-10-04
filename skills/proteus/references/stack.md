# Stack and worktrees

## Who loads what
| Tool | Lead | Worker | Verifier |
|---|---|---|---|
| graphify | once, unfamiliar repo | – | – |
| LSP plugin / Serena | – | yes | yes |
| ponytail | – | full | – |
| caveman | lite | full | lite |
| rtk + context-mode | yes | yes | yes |
| code-review-graph | – | – | yes |
| fallow (JS/TS) | `health` at close | `dead-code` on owned paths | `dupes` on diff |
| vulture / vulture-rs (Python) | close | `--min-confidence 80` owned paths | diff |
| ripgrep | yes | yes | yes |
| anti-slop oxlint rules (JS/TS) | – | via lint gate | via CI |
| thermo-nuclear review | – | – | QA, per milestone |
| improve-codebase-architecture | – | – | QA, at close |

caveman owns prose, ponytail owns code size, rtk + context-mode own tool output. Chisle covers all three in one ruleset; loaded beside them it restates caveman and ponytail and the two prose styles fight, so it is not part of the stack. Its one uncovered axis, eliding oversized non-Bash tool output, is optional: install it with `CHISLE_DEFAULT_MODE=off` so only the compress hook runs, and never let it elide spawn output (`Agent`, `wait_agent`), which is where verdicts arrive.

Never two graph tools on one role. Workers get no repo tour; if one asks for context, fix the ticket. Missing tool → note once in the task list, continue.

## Context budget (200k lead)
Lead never reads worker output or diffs; the verifier does. Lead never produces a deliverable either; a fix is a decision dispatched to a worker on the ladder. Lead holds: skill, issue numbers, contracts, task list, one-line verdicts. Never a raw `gh issue view`; always `--json … -q`. `proteus-journal.js` meters context from the transcript: at `PROTEUS_HANDOFF_AT` (default 150000 tokens) it tells the lead to finish the step, log the position, and `/handoff`; at `PROTEUS_HANDOFF_HARD` (default 180000) the guard refuses new spawns until it does. Workers and verifiers are unaffected by a lead restart. Set both lower on a 200k model if compaction still fires first.

## Worktrees
```
git checkout -b proteus/<run> main && git push -u origin proteus/<run>
git worktree add ../<repo>-proteus/<id> -b proteus-work/<run>/<id> proteus/<run>
node <hooks>/proteus-worktree.js ../<repo>-proteus/<id> <owned paths…>
git rev-parse proteus/<run>   # fork point, record in task
```
`<hooks>` is `.claude/hooks`, `.codex/hooks` on Codex. On Codex run each line as its own command, as written: a `cd`, pipe to a filter, or `$(…)` keeps git and `gh` inside the sandbox (`harnesses.md`).
The lead makes each ready ticket's worktree at step 3, forked from `proteus/<run>` after its dependencies merged; the contracts worker commits each ticket's contract there, and the ticket's worker continues on the same branch. Worker branches are `proteus-work/<run>/<id>`, outside `proteus/`, so a rule on `proteus/*` binds run branches and leaves workers free to push (`enforcement.md` §1). A run opened before this keeps `proteus/<run>-<id>` until it closes; the hooks read both.
Per worktree: own dev-server port (`.env.local`), own DB/container/SQLite, own install dir. Shared services are why "passes alone, fails together". Binaries outside the worktree (a symlinked `.blend`, an absolute path to a media library or a spreadsheet) are shared too: one writer per such file at a time, or each worktree builds its own copy from the committed scripts. A check that reads the shared original while a worker writes it measures nothing (`domains.md`).

Merge: `git worktree remove ../<repo>-proteus/<id>` (the branch cannot be deleted while checked out), then `gh pr merge <pr> --merge --delete-branch`, and after the batch's last merge `git checkout proteus/<run> && git pull` and the full suite once; red is bisected (SKILL.md step 7).

More than ~6 parallel workers or multi-repo → hand worktree lifecycle to Composio Agent Orchestrator or Conductor; keep this skill for judgement.
