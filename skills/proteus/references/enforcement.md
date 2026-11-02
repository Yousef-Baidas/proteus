# Enforcement

Rules in prompts drift. These make the important ones mechanical. Templates ship in `teams/templates/` (copied by `install.js --project`); the scaffold or stabilise ticket installs them once. §3–6, §8 and §12 apply to every domain; §1 CI applies wherever the checks run headless; §7, §9, §10 are code-only (other domains get their deep pass from the team rubric in `domains.md`).

## 1. CI on every ticket PR + run-branch rules

Scaffold ticket: copy `teams/templates/ci/proteus-gates.yml` to `.github/workflows/`, replace every `EDIT` line with the gate commands from `## Learned` (`EDIT-docs` with the docs gates: markdown lint, link check, spelling; it is the whole check on a Direct batch PR), commit. It also runs on every push to `proteus/*`, so each merge gets `gates` on the integrated tree and then `qa`: `e2e`, `smoke` from a fresh install, `rebuild` of the deliverables, `mutation` on the files the merge changed. A step the project has no use for is deleted, not left green. Keep the template's hardening: a `${{ }}` value goes through `env:`, never inside `run:`; the token stays read-only (`permissions: contents: read`, wider only on the job that needs it) and checkout keeps `persist-credentials: false`; every added action is pinned to a full commit SHA with its version as a comment; installs skip lifecycle scripts (`npm ci --ignore-scripts`). The QA verifier reads these runs and re-runs locally only what they do not cover (`teams/qa/PROFILE.md`). On PRs into `main` the workflow runs only from `proteus-work/quick/` and `proteus-work/direct/` branches; the human's own PRs are not gated.

The scaffold does not copy `teams/templates/ci/proteus-trust.yml`: GitHub runs a `pull_request_target` workflow from the default branch only, so `install.js --protect` opens a PR (`proteus-setup/trust`) adding it there for the human to merge; when `--doctor` warns that it is missing there or differs, tell the human once. Its jobs run only for PRs into `proteus/*` and check out the base sha, so `proteus-security.js` comes from the run branch and the PR's code never runs: it lists the PR's files through the API, checks the head out under `head/` as data for the scanners (§4), and posts `proteus/security` on the head: success when no changed path matches the `security` block of `teams/ROUTING.md` and the scanners found nothing new, else failure naming the paths, until the security verifier signs off. It runs as two jobs on two VMs: `scan` (`contents: read`, no secret) runs the scanners and uploads their reports; `post`, the one job with `statuses: write`, checks out only the base and reads that artifact as data (size-capped JSON, nothing run) before it posts.

What binds `proteus/<run>` is the human's, set once per repo: `install.js --protect`, run by a repo admin, adds the ruleset "proteus runs" on `proteus/*` (a PR with `gates`, `proteus/verdict` and `proteus/security` green, no force push, nobody bypasses, admins included) and gives the agents' own GitHub account write access. Worker branches are `proteus-work/<run>/<id>`, outside the pattern. Per run, right after `git push -u origin proteus/<run>`, check that it binds:

```
gh api "repos/{owner}/{repo}/rules/branches/proteus%2F<run>" --jq '[.[].type]'
```

`pull_request`, `required_status_checks` and `non_fast_forward` all listed → done. Otherwise protect the branch itself:

```
gh api -X PUT "repos/{owner}/{repo}/branches/proteus%2F<run>/protection" \
  --input - <<'EOF'
{"required_status_checks":{"strict":false,"contexts":["gates","proteus/verdict","proteus/security"]},
 "required_pull_request_reviews":null,
 "enforce_admins":true,"restrictions":null}
EOF
```

The PUT needs an admin's login. Under `identity=separate` it fails with 403 or 404, as it should: tell the human once to run `install.js --protect`, and continue with prompt-enforced gates until they do. Under `identity=shared` it succeeds, but that login can delete it: the guards stop a slip, not a determined script. A private repo on GitHub Free has neither protection nor rulesets, and `gates` never reports when Actions is disabled: either → write `protection: none` under `AGENTS.md ## Learned` once, tell the human once, continue with prompt-enforced gates; the verifier then runs the suite itself.

`strict` is off: the suite runs on `proteus/<run>` after each merge batch and bisects a red one. Required reviews are not set: one `gh` login serves every agent, and GitHub refuses `--approve` on your own PR. The verifier records its verdict as a commit status on the head it reviewed, `node <hooks>/proteus-signoff.js <pr> <sha> MERGE|BACK-TO-WORKER|CONTRACT-WRONG`: `proteus/verdict`, and with `--security` the security verifier's `proteus/security`, which replaces CI's red one. MERGE is success, the other two failure. The script refuses a head that moved since the review, so the verdict locks the merge whoever runs `gh pr merge`. Who may post it is weaker: the guards refuse `proteus-signoff.js` to the lead and to every agent but a verifier (`hooks.md`), and a hand-posted commit status or check run (`gh api …/statuses/…`, `…/check-runs`) to everyone. Without a verifier App that is a guard, not a boundary: a worker's script can post the same status under the shared login, and so can a workflow its PR edits. The owned check refuses a ticket that does not own the workflows, and `.github/**` is a security path.

The verifier App closes that (#81; setup in `docs/github.md`, recorded with `install.js --verifier-app <appId> <keyPath>`). `--protect` then pins `proteus/verdict` and `proteus/security` to the App (`integration_id`; `gates` stays CI's). `proteus-signoff.js` mints an installation token for the repo's owner, limited to that repo and `statuses: write`, and posts with it as `GH_TOKEN` in the one `gh` call's environment; the token is never written, printed or put on a command line. No token → it exits 1 with the reason and posts nothing, never under the agents' login. A status any other login posts on those contexts no longer counts. The App gets no approving review: the pinned statuses are the lock, and approving needs `pull_requests: write`. `--doctor` checks the key, a token for the repo's owner and the pinned ruleset; `--protect` warns when that owner has no installation recorded.

With the App, CI's own `proteus/security` no longer counts, so a verifier's `MERGE` without `--security` carries CI's success over, posting it as the App, when CI found no security path touched and the PR's files, listed through the API, match no glob of the base branch's security block. CI's failure is never carried over, and a `MERGE` before CI has posted is refused.

What the App leaves open: the agents run as the human's OS user, so the key is a file they could read. The hooks keep it out of reach (`hooks.md`), but not a process outside the hooks or a command that reaches it through a variable, a glob or an interpreter. Keep the key 0600 outside every repo. The verifier reads `gh pr checks <pr> --json name,state` instead of re-running the suite; it re-runs only what it needs to reproduce a finding, or the whole suite when the checks list is empty.

The guards hold every agent to this, ruleset or not: they refuse `gh pr merge --admin`, a push to `main` or to an existing `proteus/<run>` (the push that creates it passes), deleting either, any change to branch protection or a ruleset except the PUT above, and a hand-posted commit status or check run.

At close, if the PUT set the protection, the human deletes it before deleting the branch; the guards refuse it to agents, so the close PR's body ends with the command for them (`tracker.md`). The ruleset stays.

## 2. Path ownership hook

`next` runs this before `SPAWN worker` (a `RUN` line under a sandbox profile); by hand, from the repo root:

```
node <hooks>/proteus-worktree.js <wt> [--tier <tier> [--human]] <owned paths and globs…>
```

It writes the owned-paths file `<wt>/.claude/proteus-owned` (`.codex/proteus-owned` on Codex; one path or glob per line, each owning what it matches and everything below a folder it matches; re-running replaces the list), copies the worker hooks and settings into the worktree as a backup, and adds those files and `/.worktrees/` to `info/exclude`. No list file → allowed, so verifiers and bootstrap are unaffected.

The lead guard refuses a subagent's edit outside its worktree's owned paths, in another worker's worktree, or in the main checkout while a run is open; the scratch dir (`proteus-scratch.js --path`) is open to every agent, and to the lead only below a key's dir, judged on its real path. No glob covers the owned-paths file itself, in any spelling NTFS or a case-insensitive filesystem resolves to it. A subagent's worktree is its cwd's when that is a prepared worktree; else, on Claude Code, the one its brief names (`worktree <absolute path>`, `roles.md`), read from its transcript's first message. With no worktree in the brief (helpers, the scout, the guide), several (a contracts worker), or on Codex, its first edit in a prepared worktree binds it there, even another worker's, so the brief names each worker's worktree by absolute path. That binding moves only once the own worktree's changes are committed. Bindings are recorded per agent id in `<git-common-dir>/proteus-lead/agents/`.

Shell writes skip those hooks, so two more checks run `proteus-owned-check.js`, and both refuse the owned-paths file itself:

- A `pre-commit` hook installed in that worktree only (`git config --worktree core.hooksPath`, git 2.20+; existing hooks such as lefthook's commit-msg are forwarded, and a repo with none gets one that runs `commit-msg.js`) refuses a commit whose staged paths are outside the list.
- The `owned paths` step of `proteus-gates.yml` fails a PR from `proteus-work/<run>/<id>` that changes a path outside the lead's record `.proteus/owned/<id>` (one path or glob per line, `#` comments) as committed on the base `proteus/<run>`. The record and the check script come from the base, which takes commits only through a merged PR with `gates` green (§1), so the worker can change neither. The step refuses any PR that touches `.proteus/owned/` except the lead's docs PR from `proteus-work/<run>/lead-docs`, on the lead's list (`bootstrap.md`), and `next`'s add-only record PR (`stack.md`). A missing record fails the step. A PR body's `Owned:` line counts only on a PR into `main` (Quick and Direct; the human reads the diff) and, with a warning, on a run whose base has no `.proteus/owned/` at all (removed in the next minor release).

Not airtight: `git commit --no-verify` skips the hook, a worker that edits `proteus-gates.yml` can drop the step, and a worker's script can push the lead-docs branch, which the lead's `--match-head-commit` merge catches. The verifier's `gh pr diff <pr> --name-only` against the owned paths is the backstop: any file outside them is `BACK-TO-WORKER`.

Tier ceiling (`SKILL.md` rule 3). `--tier` writes `# tier <tier>[ human] <base sha>` as the list's first line; the base is `HEAD` at the first preparation and is kept on re-runs, so a Direct batch is measured whole. The same `pre-commit` runs `proteus-tier.js --staged`: everything since the base, by the `tiers` block of `teams/ROUTING.md` as of the base, against the declared tier. CI's `tier` step runs `proteus-tier.js --ci` on every `proteus-work/` PR: the tier is `direct` on a `proteus-work/direct/` branch, else the body's `Tier:` line, else `standard`. Rules come from the base so a change cannot loosen its own ceiling; `(human)` and the body line are the agent's to write, so they are a tripwire, not a lock. The Direct helper's PR targets `main`, which only the human merges.

## 3. lefthook + commit-msg check

Scaffold ticket: install lefthook with the stack's package manager, copy `teams/templates/lefthook.yml` to the root, fill the `EDIT` lines, and prove the hook: `lefthook run commit-msg <file>` fails on a bad message and passes a good one (quote both). Never `lefthook install`: it writes the shared `.git/hooks`, which guards keep from agents. A test runner, linter or watcher that walks into dot folders (vitest, jest, eslint, vite; README "Worker worktrees") gets `.worktrees/` in its ignores. Its pre-push test goes through `teams/templates/hooks/proteus-gates-cache.js`, so a tree the worker already passed is not tested again. lefthook and `proteus-gates.yml` run `node teams/templates/hooks/commit-msg.js`, so `teams/templates/` is committed. It rejects non-Conventional subjects, >72 chars, and any AI attribution trailer. CI runs it on every commit in the PR, so a worker that skipped hooks still fails.

## 4. Scanners and the security trigger

`teams/security/PROFILE.md` runs `semgrep --config p/owasp-top-ten --config p/secrets --json --quiet $(gh pr diff <pr> --name-only)` first and attaches findings, then reads. Missing semgrep → `pipx install semgrep` or note once and continue.

Which PRs get the security verifier is CI's call first (§1): a changed path in the `security` block, or a scanner finding, turns `proteus/security` red. The two jobs protect the token, not the verdict: a scanner a hostile head subverts can still forge a clean artifact. The `scan` job runs `proteus-scan.js` on the head, semgrep as an image pinned by digest and every download checked against a sha256:

- semgrep (`p/owasp-top-ten`, `p/secrets`) on the changed files;
- gitleaks on the PR's commits from a mirror clone with no working tree, so a secret a later commit deleted still counts; a base or head commit missing from the mirror fails the job;
- osv-scanner when a lockfile changed (`requirements-*.txt` and `requirements/*.txt` included), call analysis off so no `go` or `cargo` runs on the head;
- zizmor when a workflow under `.github/workflows/` or a composite action's `action.yml` changed (locally actionlint where zizmor is missing).

A symlink the PR turns into a regular file counts as changed. A tool with nothing to scan logs one skip line and passes; in CI a missing tool fails the job (`--require`). Nothing the PR writes quiets them: no ignore file, inline ignore or config of any of the four is honoured. `proteus-security.js --findings` reads their SARIF; any finding the base's `teams/baseline.json` does not record under the gate `security` turns `proteus/security` red. Head text in a log line is fenced by a random `::stop-commands::` token and a fixed prefix, so it never runs as a workflow command. A repo with findings it already carries records them once with the ratchet (§12), from a checkout of the default branch, and commits the file:

```
node teams/templates/hooks/proteus-scan.js --dir . --all --out <tmp dir>
node teams/templates/hooks/proteus-baseline.js security --record --match "^finding " -- node teams/templates/hooks/proteus-security.js --list <tmp dir>
```

A recorded finding stays quiet while its tool, rule and path stay the same, digits included (a CVE id is the rule, so another CVE in the same lockfile is new); fixing it and re-recording tightens the baseline. On a PR CI did not mark (`SKILL.md` principle 4), the security verifier's `--security` signoff replaces CI's success.

## 5. Cost

Step 8 runs `node <hooks>/proteus-close-report.js <run>` (flags in `--help`). From the tracker it prints, per ticket, the PRs, bounces (`BACK-TO-WORKER` verdicts), escalations (`RED` reports and `CONTRACT-WRONG` verdicts) and wall-clock; per team and difficulty, the bounce rate, escalation rate and median wall-clock; and the run's totals and cost, from pinned `ccusage` over the sessions the journal saw a human message in during the run. The lead tunes routing from the team rows: a team and difficulty that bounces or escalates on most tickets goes to `hard` (`top`) next run, or gets smaller tickets; one with no bounce on `hard` is offered at `standard`. Each change is one line to the human; approved, a difficulty rule goes in `AGENTS.md ## Learned`, a `teams/ROUTING.md` change through a ticket.

## 6. Skill pinning

`teams/link-skills.js` writes `teams/skills-lock.json` (source and sha256 over the skill's files, per linked skill) and warns `drift: <skill>` when a machine's copy differs from the committed hash. Commit the lock; a teammate whose install drifted re-runs `npx skills update <skill>` or accepts the new hash with `--relock`.

Drift blocks dispatch. Each session start re-hashes every skill linked under `teams/<team>/.claude/skills` and `.agents/skills` against the lock (`proteus-state` shows `skills-lock=drift:<skills>`), and the lead guard refuses a worker or verifier spawn while any differs; helpers still spawn. A drift is re-checked on every spawn, so the block lifts as soon as the copy matches or the lock is rewritten. Re-locking is the human's call, since it admits new third-party text into every worker.

## 7. Mutation testing per milestone

CI's `qa` job mutates the files each merge changed (§1), so every changed file is mutated once, off any agent's clock. Once per milestone, `teams/qa/PROFILE.md` reads the `mutation` step of every push run since the milestone's merge-base; without that step it mutates the files changed since the merge-base locally. Surviving mutants in a changed file → `WAVE-RED` finding `MUTANT <file:line> survives`, ticketed like any other red.

## 8. Dependency check on `NEEDS`

Worker comments `NEEDS dependency <ecosystem>/<name>@<version>`. Lead, before asking the human:

```
curl -s https://api.osv.dev/v1/query -d '{"package":{"name":"<name>","ecosystem":"<npm|PyPI|crates.io|Go>"},"version":"<version>"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=(JSON.parse(s).vulns||[]);console.log(v.length?v.map(x=>x.id+" "+(x.summary||"")).join("\n"):"osv: clean")})'
```

Result goes into the issue comment with the request. The human still decides; unattended mode parks it. Once it lands, CI's osv-scanner (§4) checks the lockfile, transitive updates included.

## 9. anti-slop lint rules (JS/TS)

Required, `teams/devops/required.txt`. The scaffold or stabilise worker reads `teams/devops/PROFILE.md`, runs the `install-anti-slop` skill, and the vendored oxlint plugin (`tools/oxlint/anti-slop/`) joins the lint gate: lefthook pre-commit, CI `gates`, and every worker's green. `CONVENTIONS.md` forbids new dependencies → ask the human about the dev-only `oxlint` and `@oxlint/plugins` before writing that ticket, or its worker stops on `NEEDS` mid-wave. The config is `.oxlintrc.json`, which needs no TypeScript loader. A rule that fights `CONVENTIONS.md` is disabled there with the convention quoted; the human's file wins. No JS/TS in the repo → write `anti-slop: n/a` under `## Learned` once. Updating the rules is a devops ticket, never a side effect.

## 10. Deep review per milestone, architecture scan at close

Required, `teams/qa/required.txt`. At every milestone the QA pass (`judge`) applies `thermo-nuclear-code-quality-review` to the milestone diff; its blockers are `WAVE-RED` tickets and the human gate stays shut until they merge. Per milestone, not per ticket. At close the same agent runs the scan phase of mattpocock `improve-codebase-architecture` and files at most five candidates on the last milestone's debt issue. Both are `disable-model-invocation`, read from their `SKILL.md`. Non-blocker findings go to the milestone's debt issue, where the human decides at close what becomes a run.

The same scan runs before the work too: the refactor checkpoint in `flow.md` step 1.

## 10b. Security pass per milestone and audit at close

A security verifier sees one ticket's diff, so an access path built across tickets passes each review.

- Milestone mode: the QA milestone pass (§10) also spawns `proteus-security-verifier` on `judge` with the word `milestone` and the milestone diff, `git diff <merge-base>..proteus/<run>`. It checks the flows across tickets: authorization on every new route or handler, every input that reaches file, network, database or shell I/O, and each of the milestone's gate (g) abuse cases (`flow.md` step 1).
- Close mode: at close the same agent runs with the word `close` over the whole repo at the tip of `proteus/<run>`, applying the audit skill the scout picked for `teams/security` (a line of `teams/security/skills.txt`), read from its `SKILL.md`.
- Close skip: `proteus-cli.js close` prints `close: skip` only when every milestone has a `milestone-passes` run-log line from the human's or the agents' login and origin's tip of `proteus/<run>` differs from the newest line's commit only by added owned records, lessons and ADRs. Neither close pass then runs, §10's scan included. Anything else, a failure too, prints `close: run`.
- Blockers become `WAVE-RED` tickets exactly as §10's do: numbered, mapped to the ticket that introduced them, fixed by tickets, never by the verifier. Non-blockers go to the milestone's debt issue.
- The human gate does not open over a security blocker. Like §10, `proteus-lead-guard.js` holds the gate and `proteus-verdict.js` counts no `ACCEPT` or `AUTO-ACCEPT` (`review.md`).
- No path the run touched matches the `security` block of `teams/ROUTING.md` → both modes are skipped, and the lead writes `security-pass: skipped (no security path)` on the run log.

## 10c. Local pentest

Static checks cannot prove an exploit, so a run that ships a reachable service gets attacked on localhost before the human sees it (#201).

- When: at the QA milestone pass (§10), when `AGENTS.md` `## Learned` records the project's service as `service: <port> <start command>`, and only under the sandbox (#188, `docs/install.md`, Sandboxed bypass).
- Who: the lead spawns a `judge` agent with the Pentest judge prompt (`roles.md`). It runs `proteus-run-tree.js <sha>` on the milestone tip, starts the service from `.worktrees/_run` on localhost, then runs an OWASP Top 10 pass: Strix through the skill the scout picked for `teams/security`, or a ZAP baseline (`zap-baseline.py -t http://localhost:<port>`). It stops the service when done.
- Scope: a target is `localhost`, `127.0.0.0/8` or `[::1]`, or exactly one origin (scheme, host, port) on the `## Learned` line `pentest-targets: <url>[, <url>...]`, which only the human writes. The host is judged as written with no DNS; userinfo, a backslash and any form the URL parser rewrites (`127.1`, decimal, hex, octal, IPv4-mapped) are out of scope. `node <hooks>/proteus-pentest.js scope <url>` exits 0 in scope and 1 with `out of scope: <url>`.
- Guard: the lead guard refuses a subagent's `strix`, `zap-baseline.py`, `zap.sh` or `zap-full-scan.py` run, wrapped or not, when a word holding `://` (before the scanner too) or a `-t`/`--target` value fails the same check (`lib.pentestDenial`; a bare value is judged as `http://<v>` unless it starts `./`, `../` or `/`), or when a word the shell builds (`$`, a backtick, `{}`) or `xargs` comes before the scanner.
- Residual: the argv guard is defence in depth. It does not see a scanner run from interpreter code, a script, or a renamed binary. The boundary is the sandbox (#188): its `strictAllowlist` network reaches only GitHub and the registries `## Learned` names, so a scan at one of those is the accepted residual.
- Skip: no `service:` line, the sandbox off, or a safety refusal of the pentest → no pentest; the lead writes `pentest: skipped (<reason>)` on the run log (`no service line`, `sandbox off`, `refused`), never rerun or reworded; the human decides at the next gate.
- Findings: the judge writes its report as JSONL, one `{title, severity, target, poc}` per line, and runs `node <hooks>/proteus-pentest.js findings <report.jsonl>`, which keeps only findings with a proof of concept and an in-scope target and prints one ticket body each, separated by `---` lines. Each becomes a `WAVE-RED` ticket filed as §10b's blockers are; the human gate does not open over one.

## 11. Hooks

`install.js --project` installs the hooks; every hook fails open. What each one refuses, how hooks call git, where they keep state, the human's verdict post and the harness adapters: `hooks.md`. The guarded paths, refused to every agent's shell write, are `.claude/`, `.codex/`, `.agents/`, `.git/` (except through git and the scratch dir), lefthook config, `.github/workflows/`, `.github/actions/`, `teams/templates/hooks/`, the policy's files and the user's `~/.claude`, `~/.codex`, `~/.agents`. After their own checks, which win, the guards apply the policy (`proteus-policy.js`): block refuses; ask opens the lead's dialog, else the agent files `NEEDS`; an invalid policy file stops edits and shell writes until fixed. Only `proteus-policy.js write`, human-approved, writes it.

## 12. Baseline ratchet

A gate that is red on `main` when Proteus arrives would block every ticket, and a worker cannot tell its red from the repo's. The stabilise ticket records it instead and runs the gate through the ratchet, which fails only on what is new:

```
node teams/templates/hooks/proteus-baseline.js <gate> --record [--mode lines|count] [--match <re>] [--ignore <re>] -- <command…>
node teams/templates/hooks/proteus-baseline.js <gate> -- <command…>
```

- The first line, once per red gate, writes `teams/baseline.json` (`gates.<gate>`: mode, match, findings or count, exit); commit it. The second is the gate line in `proteus-gates.yml`, `lefthook.yml` and the worker's green. One argument after `--` runs as a shell line; several run as argv.
- `lines` (default): every output line matching `match` is a finding, compared as a multiset after stripping ANSI codes, the checkout path, `ignore`, and with every number turned into `#` (line numbers and timings move without the finding changing). The gate `security` keeps its digits: a CVE id is the finding (§4). The default `match` catches `FAIL`, `FAILED`, `Error`, `error`, `warning`, `not ok`; set one per runner, e.g. `^FAILED ` for pytest, `^\s*FAIL ` for vitest and jest.
- `count`: the sum of the numbers `match` captures, e.g. `(\d+) (?:errors?|warnings?)` for a linter summary, must not grow.
- A command that exits 0 passes. A non-zero exit passes only when every finding is in the baseline; a non-zero exit with no finding the regex recognises fails (a crash or a changed output format is not "nothing new"), and so does any red run of a gate recorded green.
- `--record` on an existing entry only tightens: it refuses while a finding is not in the baseline. `--reset` re-records from scratch and is the human's call. A run that reports `fixed` prints the tighten hint; the lead puts `teams/baseline.json` in the owned paths of the ticket that fixes a recorded failure, and that worker re-records.
- A gate with no entry passes its own exit code through, so nothing is ratcheted by accident.
- In guest mode (`bootstrap.md`) the default file is `<guest dir>/teams/baseline.json`, outside git, found from any worktree of the repo; the lead records and tightens it.

Limits: a line-based finding is only as stable as the runner's output: a renamed test is a new finding, and a flaky test shows up as new when it fails. A count cannot tell one new failure from one fixed, so prefer `lines` with a runner-specific `match` and keep `count` for linters whose per-finding lines are too noisy. Output over 512 MB, or a command past `PROTEUS_BASELINE_TIMEOUT` (default one hour), fails.

## 13. A worker's shell

A worker's shell writes only its owned paths (§2) and its scratch dir, the rule its `Edit`/`Write` already follow (#48). `lib.workerDenial` applies it in the lead guard (an in-process worker, named `proteus-[<team>-]worker`) and in the worktree's own worker guard alike. Every other agent's shell keeps the rules in `hooks.md`.

- **Writes.** The command is tokenised as the shell does: quotes join words, it splits on `&& || ; | & ( )`, newlines and redirections, and heredoc bodies are skipped. Each word is judged as written, without backslash escapes, and as its value after the first `=`. Write targets are redirect targets (a `>` inside `$(( ))`, `(( ))` or `[[ ]]` is a comparison unless its operand is a literal path), `tee`, in-place editors (`sed -i`, `perl -i`, `ruby -i`, `gawk -i inplace`), `sort -o`, `curl -o`, `wget -O`, the dir `tar -x` or `unzip` extracts into, and the destinations of `cp`, `mv`, `install`, `ln`, `rsync`, `dd of=`, `truncate`, `touch` and `rm`, after a `cd` chain and through `sh -c`, `eval`, `busybox` and `find -exec`. `xargs` followed by a writer is refused outright. `git -C`, `--git-dir=` and `--work-tree=` are followed.
- **Links.** A link the command makes inside the worktree whose target is outside the owned paths and the scratch dir is refused (a symlink target resolved from the link's dir, a hard link's from the cwd; an owned glob `src/**` covers the dir `src`; `/dev/null`, `/dev/stdout`, `/dev/stderr` and `NUL` allowed). A target the shell builds when it runs (`$VAR`, `$(...)`, backticks) cannot be judged and is refused: name the path literally. Build output (`dist/`, `node_modules/`) must be in the ticket's owned paths or ignored by the build.
- **Always refused**, whatever the owned list says: the guarded paths (§11), so also `.claude/agents/`, `.claude/settings*.json` and the owned list itself, and the anchors `proteus-confine.js` uses: `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME` and the plugin root.
- **Inline code.** Shell scripts given with `-c` (in a flag cluster too), or fed a heredoc, a here-string, a pipe or `source` of stdin, are judged as command lines. For `python -c`, `node -e`/`-p`, `perl -e`, `ruby -e` and `awk` program text, inline or fed on stdin (only when the interpreter has no script operand, or is given `-` or `/dev/stdin`), every string literal and path-like word is judged: a guarded path is refused, and so is a literal resolving outside the worktree and its scratch dir. Strings with spaces, URLs and escape sequences are text; a worker's own scripts on disk run as before.
- **Known false positive.** Inline code that only *reads* outside the worktree is refused too, by design: the guard does not tell a read from a write inside code. Write the script into the worktree or the scratch dir and run it as a file.
- **Git.** `git checkout`, `git restore` and `git reset` pathspecs are judged like write targets (a word git resolves as a commit is not a path). A worker may not set, with `git config` at any scope or `git -c`, a key that makes git run a program: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.editor`, `core.pager`, `alias.*`, `filter.*`, `diff.*.textconv`, `credential.*`, `include.*`, `includeIf.*`.
- **No worktree.** A worker whose worktree cannot be found (no bound worktree with an owned list, and a cwd outside every prepared one) writes nothing and runs no inline script.
- **Force-push.** Refused as for every agent, unless the worktree's allow file lists one. The lead records a one-off authorisation for a worker's `NEEDS` with `node <hooks>/proteus-worktree.js <wt> --allow force-push`; the first force-push the guard lets through consumes it, one per call. No agent can grant one: an agent's `--allow` is refused.
- **Deadline.** Tokenising and scanning inline code get 50 ms per command; past that, on a tokeniser error, or with shells nested more than three deep, the command is refused. File-system and git lookups are not counted. A command with no write construct costs no more than a verifier's (`tests/workershell.test.js` measures it).

Residuals, for `proteus-shell-check.js` after the call and for the sandbox: what the tokeniser cannot see. Code built at runtime, a path assembled in inline code (`'/tm' + 'p'`), a script the worker writes and then runs (`make`, an npm script), a tool the list does not name, a link that already exists in the worktree or is made after the guard ran. Reads are not limited.

Under `install.js --sandbox` (`docs/install.md`, Sandboxed bypass, and its Known gaps) Bash and its children run in Claude Code's sandbox, which bounds these residuals for shell commands only. It is extra protection, not a boundary; the container runner (`docs/container.md`, #80) is the isolation layer for workers. The review session, where `proteus-verdict.js --post` needs its dialog, runs without the profile.
