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
git checkout -b proteus/<run> main && git push -u origin proteus/<run>
git worktree add .worktrees/<id> -b proteus-work/<run>/<id> proteus/<run>
node <hooks>/proteus-worktree.js .worktrees/<id> <owned paths…>
git rev-parse proteus/<run>   # fork point, record in task
```
`<hooks>` is `.claude/hooks`, `.codex/hooks` on Codex. On Codex run each line as its own command: a `cd`, pipe or `$(…)` keeps git and `gh` inside the sandbox (`harnesses.md`).
Worktrees live in `.worktrees/` (Direct `direct-<batch>`, Quick `quick-<n>`), git-excluded by `proteus-worktree.js`; an older run's stay in `../<repo>-proteus/` (`git worktree list`). The lead makes each ready ticket's worktree at step 3, forked from `proteus/<run>` after its dependencies merged; the contracts worker commits the contract there and the ticket's worker continues on that branch. Worker branches are `proteus-work/<run>/<id>`, outside `proteus/`, so a rule on `proteus/*` binds run branches and leaves workers free to push (`enforcement.md` §1). An older run keeps `proteus/<run>-<id>`; the hooks read both.
Per worktree: own dev-server port (`.env.local`), own DB/container/SQLite, own install dir. Shared services are why "passes alone, fails together". Binaries outside the worktree (a symlinked `.blend`, an absolute path to a media library or a spreadsheet) are shared too: one writer at a time, or each worktree builds its own copy from the committed scripts. A check that reads the shared original while a worker writes it measures nothing (`domains.md`).

Merge: `git worktree remove .worktrees/<id>` (a checked-out branch cannot be deleted), then `gh pr merge <pr> --merge --delete-branch`, and after the batch's last merge `git checkout proteus/<run> && git pull`. Suite and bisect run in `.worktrees/_run`, which nests no worktree for vitest, jest or eslint to walk: `git worktree add --detach .worktrees/_run proteus/<run>` once (own install), `git checkout --detach proteus/<run>` per batch, removed at close; there (Codex: `workdir`, no `cd`), `node ../../<hooks>/proteus-gates-cache.js "<suite>" >/dev/null 2>&1; echo $?` (QA on the same tree replays it); red is bisected (SKILL.md step 7).

More than ~6 parallel workers or multi-repo → hand worktree lifecycle to Composio Agent Orchestrator or Conductor; keep this skill for judgement.
