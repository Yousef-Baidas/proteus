# Enforcement

Rules in prompts drift. These make the important ones mechanical. Templates ship in `teams/templates/` (copied by `install.js --project`); the scaffold or stabilise ticket installs them once. §3–6 and §8 apply to every domain; §1 CI applies wherever the checks run headless; §7, §9, §10 are code-only (other domains get their deep pass from the team rubric in `domains.md`).

## 1. CI on every ticket PR + run-branch rules

Scaffold ticket: copy `teams/templates/ci/proteus-gates.yml` to `.github/workflows/`, replace every `EDIT` line with the gate commands from `## Learned`, commit.

What binds `proteus/<run>` is the human's, set once per repo: `install.js --protect`, run by an admin of the repo, adds the ruleset "proteus runs" on `proteus/*` (a PR with `gates` green, no force push, nobody bypasses, admins included) and gives the agents' own GitHub account write access. Worker branches are `proteus-work/<run>/<id>`, outside the pattern. Per run, right after `git push -u origin proteus/<run>`, check that it binds:

```
gh api "repos/{owner}/{repo}/rules/branches/proteus%2F<run>" --jq '[.[].type]'
```

`pull_request`, `required_status_checks` and `non_fast_forward` all listed → done. Otherwise fall back to protecting the branch itself:

```
gh api -X PUT "repos/{owner}/{repo}/branches/proteus%2F<run>/protection" \
  --input - <<'EOF'
{"required_status_checks":{"strict":false,"contexts":["gates"]},
 "required_pull_request_reviews":null,
 "enforce_admins":true,"restrictions":null}
EOF
```

The PUT needs an admin's login. Under the agents' own account (`identity=separate` in `proteus-state`) it fails with 403 or 404, as it should: tell the human once to run `install.js --protect`, and continue with prompt-enforced gates until they do. Under `identity=shared` it succeeds, and `enforce_admins` makes it bind your own login too; but that login can delete it: the guards refuse an agent's delete, so it stops a slip, not a determined script. It also fails on a private repo on GitHub Free, which has no rulesets either, and `gates` never reports when Actions is disabled. Either → write `protection: none` under `AGENTS.md ## Learned` once, tell the human once, continue with prompt-enforced gates; the verifier then runs the suite itself.

Now no PR merges into `proteus/<run>` without the `gates` check green. `strict` is off: merges are sequential and the full suite runs on `proteus/<run>` after each one, so requiring every ticket branch to be up to date first would only add an update-branch and a fresh CI run per PR. Required reviews are not set: worker, verifier and lead share one `gh` login, and GitHub refuses `--approve` on your own PR, so the verifier's `MERGE` is a review comment and a record, not a lock (a verifier approving as a GitHub App is #69). Verifier reads `gh pr checks <pr> --json name,state` instead of re-running the suite; it re-runs only what it needs to reproduce a finding, or the whole suite when the checks list is empty.

The guards hold every agent to this, ruleset or not: they refuse `gh pr merge --admin`, a push to `main` or to an existing `proteus/<run>` (the push that creates it passes), deleting either, and any change to branch protection or a ruleset except the PUT above.

At close, if the PUT set the protection, the human deletes it before deleting the branch; the guards refuse it to agents, so the close PR's body ends with `gh api -X DELETE "repos/{owner}/{repo}/branches/proteus%2F<run>/protection"` for them. The ruleset stays.

## 2. Path ownership hook

Before spawning a worker, from the repo root (`<hooks>` is `.claude/hooks`, `.codex/hooks` on Codex; other names per `harnesses.md`):

```
node <hooks>/proteus-worktree.js <wt> <owned paths and globs…>
```

It writes the owned-paths file `<wt>/.claude/proteus-owned` (`.codex/proteus-owned` on Codex; one path or glob per line; re-running replaces the list), copies the worker hooks and their settings into the worktree as a backup, and adds those local files to the repo's `info/exclude`; same on Linux, macOS, and Windows. Workers run inside the lead's process, so the rule that bites is the lead's `proteus-lead-guard.js`: for a subagent it refuses every edit (`Edit`/`Write`, Codex `apply_patch`) outside the worktree's `proteus-owned` list with the `NEEDS` instruction as the error, any edit in another worker's worktree, and any subagent edit to the main checkout while a run is open. A subagent's worktree is its cwd's when that is a prepared worktree; otherwise (a subagent keeps the lead's cwd on both CLIs) its first edit in a prepared worktree binds it there, recorded per agent id in `<git-common-dir>/proteus/agents/`. An edit in a different prepared worktree is refused, naming the agent's own, while the own one has uncommitted changes; once they are committed the binding moves, which is how a contracts worker goes from one ticket's worktree to the next. The first edit decides: a worker whose very first edit lands in a sibling's worktree is bound there and not refused, so the brief still names each worker's worktree by absolute path. Shell writes (`sed -i`, redirects) skip those hooks, so two more checks run `proteus-owned-check.js`: a `pre-commit` hook that `proteus-worktree.js` installs in that worktree only (`extensions.worktreeConfig` plus `git config --worktree core.hooksPath`, git 2.20+, same on every OS; the main checkout's hooks are untouched, and the repo's existing hooks such as lefthook's commit-msg are forwarded) refuses a commit whose staged paths are outside the `proteus-owned` list, and the `owned paths` step of `proteus-gates.yml` fails a PR from `proteus-work/<run>/<id>` that changes a path outside the `Owned:` line of its body (the list is machine-local, so the worker copies it from the ticket into the PR body; no line fails the step). `git commit --no-verify` skips the hook, and a worker controls its own PR body, so neither is airtight; the verifier's `gh pr diff <pr> --name-only` against the owned paths stays the backstop and any file outside them is `BACK-TO-WORKER`. These files are untracked and die with the worktree. No list file → allowed, so verifiers and bootstrap are unaffected.

## 3. lefthook + commit-msg check

Scaffold ticket: install lefthook (`npm i -D lefthook` / `pip install lefthook` / `cargo binstall lefthook` / `pacman -S lefthook` / `brew install lefthook`), copy `teams/templates/lefthook.yml` to the root, fill the `EDIT` lines, `lefthook install`. lefthook and `proteus-gates.yml` run `node teams/templates/hooks/commit-msg.js`, so `teams/templates/` is committed. The commit-msg check rejects non-Conventional subjects, >72 chars, and any AI attribution trailer. CI runs the same check on every commit in the PR, so a worker that skipped hooks still fails.

## 4. semgrep in the security verifier

`teams/security/PROFILE.md` runs `semgrep --config p/owasp-top-ten --config p/secrets --json --quiet $(gh pr diff <pr> --name-only)` first and attaches findings, then reads. Missing semgrep → `pipx install semgrep` or note once and continue.

## 5. Cost

Step 8 reports cost per merged ticket from `npx ccusage@20.0.26 session --json` (Codex: `npx @ccusage/codex@19.0.0 session --json`; they read local JSONL, and npx fetches the pinned version once), summed over the run's sessions. Long-term trends: Claude Code's OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, endpoint of your collector); per-profile cost falls out of the session tags.

## 6. Skill pinning

`teams/link-skills.js` writes `teams/skills-lock.json` (source and sha256 over the skill's files, per linked skill) and warns `drift: <skill>` when a machine's copy differs from the committed hash. Commit the lock; a teammate whose install drifted re-runs `npx skills update <skill>` or accepts the new hash by re-running the link script with `--relock`.

Drift blocks dispatch. Each session start re-hashes every skill linked under `teams/<team>/.claude/skills` and `.agents/skills` against the lock (`proteus-state` shows `skills-lock=drift:<skills>` and a note), and `proteus-lead-guard.js` refuses a `proteus-worker`, `proteus-verifier` or `proteus-<team>-worker`/`-verifier` spawn while any differs, naming the skills and both fixes. Helpers (scout, guide, any other agent) still spawn. The check is local: a clean result is cached in `<git-common-dir>/proteus/skills-drift.json` until the lock changes or the next session starts, and a drift is re-checked on every spawn, so the block lifts as soon as the copy matches or the lock is rewritten. Re-locking is the human's call, since it admits new third-party text into every worker.

## 7. Mutation testing per milestone

`teams/qa/PROFILE.md`: once per milestone, on files changed since the milestone's merge-base, run Stryker (`npx stryker run --mutate <files>`), `mutmut run --paths-to-mutate <files>`, or `cargo mutants --file <f>`. Surviving mutants in a changed file → `WAVE-RED` finding `MUTANT <file:line> survives`, ticketed like any other red. Per milestone, not per ticket; it is the slow gate.

## 8. Dependency check on `NEEDS`

Worker comments `NEEDS dependency <ecosystem>/<name>@<version>`. Lead, before asking the human:

```
curl -s https://api.osv.dev/v1/query -d '{"package":{"name":"<name>","ecosystem":"<npm|PyPI|crates.io|Go>"},"version":"<version>"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=(JSON.parse(s).vulns||[]);console.log(v.length?v.map(x=>x.id+" "+(x.summary||"")).join("\n"):"osv: clean")})'
```

Result goes into the issue comment with the request. The human still decides; unattended mode parks it.

## 9. anti-slop lint rules (JS/TS)

Required, `teams/devops/required.txt`. The scaffold or stabilise worker reads `teams/devops/PROFILE.md`, runs the `install-anti-slop` skill, and the vendored oxlint plugin (`tools/oxlint/anti-slop/`) joins the lint gate: lefthook pre-commit, CI `gates`, and every worker's green. After that it costs no agent a token; slop fails lint like a type error fails the build. A rule that fights `CONVENTIONS.md` is disabled in `oxlint.config.ts` with the convention quoted; the human's file wins. No JS/TS in the repo → write `anti-slop: n/a` under `## Learned` once. Updating the rules is a devops ticket, never a side effect.

## 10. Deep review per milestone, architecture scan at close

Required, `teams/qa/required.txt`. Per-ticket verifiers check a diff against its contract; nobody at that level sees what five merged tickets did to a module. So at every milestone the QA pass (`top`) applies `thermo-nuclear-code-quality-review` to the milestone diff; its blockers are `WAVE-RED` tickets and the human gate stays shut until they merge. Per milestone, not per ticket: on a forty-line diff it demands rewrites the ticket never asked for and doubles the verifier bill. At close the same agent runs the scan phase of mattpocock `improve-codebase-architecture` and files at most five candidates on the last milestone's debt issue. Both are read from their `SKILL.md`; both are `disable-model-invocation`. Non-blocker findings go to the milestone's debt issue, where the human decides at close what becomes a run.

## 11. Hooks

`install.js --project` runs `install-lead-hooks.js`, which copies every hook to `.claude/hooks/` and registers the lead's set in `.claude/settings.local.json` (untracked, so a worker's worktree never inherits it); with `--harness codex`, `.codex/hooks/`, `.codex/hooks.json` and `.codex/rules/proteus.rules` (`harnesses.md`). The autostart re-syncs changed hooks from the Proteus checkout at every session start, so a hook fix reaches every project without reinstalling. All hooks fail open: an internal error never blocks the session.

Lead (main checkout):

- `proteus-autostart.js` (`SessionStart`): prints the skill body and a `proteus-state` line from local files, so every session opens as the lead at "Session start" with no command typed. Also: `doc-bloat`, `lessons`, `proteus-src`, `proteus-update`, `scratch` (over 1 GB), `context-mode=missing` (plugin not installed and enabled) in the state line; the run-log tail at startup with an open run and after a compaction; after a compaction, the last ten human messages verbatim. Once a day it fetches the Proteus checkout and its tags in the background. The newest `vX.Y.Z` tag past HEAD shows as `proteus-update=<tag>`, its commit count goes to `~/.claude/proteus.json` for the status line; with `autoUpdate` on it fast-forwards a clean checkout to that tag once `git verify-tag` accepts it and notes the `CHANGELOG.md` sections in between, else notes why not. While the tour is pending (`toured` in that file unset, or a `feat` commit since it) it adds one offer line at up to three session starts, then records it declined. Each session it starts `proteus-scratch.js --sweep --stale` detached.
- `proteus-lead-guard.js` (`PreToolUse`): on the main thread refuses edits (`Edit`/`Write`, Codex `apply_patch`) inside the repo except `CONTEXT.md`, `CONVENTIONS.md` (bootstrap, then only a standing rule the human approved; the hook cannot check that), `AGENTS.md`, `docs/adr/*.md`, `docs/lessons/*.md`; refuses a spawn (`Agent`, Codex `spawn_agent`) with no model, a model above the lead's, a once-per-project model (Fable by default; the lead is its one instance), or one under the floor (Sonnet by default, so Haiku), per the ladder in `proteus-lib.js` (`models` in `~/.claude/proteus.json`, a `models:` line in `AGENTS.md`); refuses new spawns at `PROTEUS_HANDOFF_HARD` context; refuses worker and verifier spawns while a team skill has drifted from `teams/skills-lock.json` (§6); refuses `gh … --edit-last` (one account posts for every agent, so an edit can overwrite a ruling) and an agent's comment opening with `ACCEPT`, `CHANGES` or `ANSWER`, the human's words (`tracker.md`); refuses reading an image (`Read`, Codex `view_image`; png, jpg, webp, exr, …) unless the human's latest message names the file, because each costs the lead ~1.5k tokens and judging renders is the verifier's or the human's job. Inside subagents it refuses `run_in_background` Bash, `Monitor` (neither visible on Codex), `--edit-last`, those three words, and edits outside the worktree's owned paths or in another worker's worktree (§2). Shell file writes are not caught; rule 1 of the skill covers them.
- `proteus-journal.js` (`UserPromptSubmit`): appends every human message to `.git/proteus/journal.jsonl` (last 500) with common secrets replaced by `[redacted]` (tokens and keys from GitHub, Anthropic, OpenAI, AWS, Slack; JWTs; private key blocks; `Authorization:` values; `password`/`secret`/`token`/`api_key` assignments; `proteus-lib.js` `redact`), redacting again when the autostart re-injects them, reminds the lead to log decisions, names open question issues at most every ten minutes, and meters context (`stack.md`).
- `proteus-lessons.js` (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`): trigger-based lesson recall (`lessons.md`).
- `proteus-scratch.js` (`PreToolUse`, `PostToolUse`, `PostToolUseFailure` on `Bash`, subagents included): ledgers each new entry directly in the temp dir that this user owns and the command or its output names; `--path`, `--sweep` and `--size` from the command line (`operations.md`). Only a sweep deletes, and only what the ledger or the scratch dir holds.
- `proteus-stall.js` (`SubagentStop`, `TeammateIdle`; Codex `SubagentStop` only): refuses a stop that ends waiting on a background job instead of reporting (`operations.md`).
- `proteus-statusline.js` (status line): appends `proteus: N questions · M reviews` to your own status line while any are open; it reads a cache and refreshes it in the background at most once a minute. Registered only when the project has no `statusLine` of its own. Codex has no scriptable status line; `inbox=` in `proteus-state` carries the count.
- Not hooks: `proteus-status.js` (the `status` command), `proteus-inbox.js` (`--refresh` lists open questions and reviews; the `questions` command), `proteus-verdict.js` (the trusted verdict or answer on an issue, `tracker.md`), `proteus-worktree.js` (§2).

Worker worktree (written by `proteus-worktree.js`, a backup for sessions opened inside a worktree): `proteus-owned-paths.js` (§2), `proteus-owned-check.js` (§2; the worktree's `pre-commit` and the CI step), `proteus-worker-guard.js` (no `run_in_background`, no `Monitor`, no `--edit-last`, no `ACCEPT`/`CHANGES`/`ANSWER` comment), `proteus-lessons.js`, `proteus-scratch.js`, `proteus-stall.js` on `Stop`.

No hook reads Claude Code's hook JSON itself. `proteus-harness.js` loads the adapter named by `PROTEUS_HARNESS` (`proteus-harness-<name>.js`, default and fallback `claude`), which turns the CLI's input into one Proteus event, answers for the hook (deny, add context, keep going), reads the transcript, and knows where the CLI keeps settings, agents and worker hooks. `proteus-lib.js` is the part every CLI shares. The event and adapter contract are documented at the top of `proteus-harness.js`. Hooks installed under `.codex/hooks` use the Codex adapter. The default model ladder belongs to the adapter; a CLI without one runs single-model, every spawn on the lead's model, until `models.ladder` is set.

`PROTEUS=0 claude` (`PROTEUS=0 codex`) opens a plain session with none of the lead's hooks: the review session, or the human working by hand. Hook state lives in `<git-common-dir>/proteus/` (`journal.jsonl`, `inbox.json`, `lesson-hits.jsonl`, `lead-model.json`, `skills-drift.json`, `visibility.json`, `scratch-ledger.jsonl`, `scratch/`, `scratch-size.json`, lesson and stall caches) and is never committed. `node <Proteus checkout>/install.js --doctor` checks the whole install, `--doctor --fix` repairs what it safely can.
