# Changelog

Notable changes per release. A release is a signed `vX.Y.Z` tag (README, "Releases"). PRs add their entries as
fragments in `changelog.d/`, not here; when tagging, run `node scripts/changelog.js --release X.Y.Z` to fold them
(and any `Unreleased` notes) under a new `## [X.Y.Z] - YYYY-MM-DD` heading. Updates print the sections between the
installed version and the new one.

## [Unreleased]

## [1.2.1] - 2026-10-17

### Changed

- The guards match agent names through one helper, `lib.agentName`, which also accepts the
  `proteus:` namespace a Claude Code plugin gives its agents (#136): `proteus:proteus-verifier`
  signs off, `proteus:proteus-worker` spawns are lock-checked and beat, `proteus:proteus-scout`
  writes `teams/*/skills.txt`. Any other namespace (`evil:proteus-verifier`) counts as no
  Proteus agent. Bare names behave as before.
- The hooks no longer assume they sit in `<repo>/.claude/hooks`, as prep for shipping Proteus as a plugin
  (#136). The inbox, the status line and `proteus-worktree.js` find the session's repo from the cwd or
  `CLAUDE_PROJECT_DIR` (its git root), and only then from their own folder; the Codex adapter falls back to
  the cwd's git root outside `<root>/.codex/hooks`. Harness detection reads Claude Code's
  `CLAUDE_PROJECT_DIR` (and `CLAUDE_PLUGIN_ROOT` alone as Codex) when the hooks' folder names no CLI.
  The Claude adapter also looks for the skill in `$CLAUDE_PLUGIN_ROOT/skills/proteus`.

### Fixed

- `CLAUDE_CONFIG_DIR` is honoured: `proteus.json`, the user's `settings.json`, skills, agents and the
  context-mode check are read and written there, by the hooks and by `install.js`, instead of always
  `~/.claude`. The guards protect it like `~/.claude`, and a custom `CODEX_HOME` too.
- `proteus-shell-check.js` no longer keeps a finished subagent's shell calls in flight (#140). A subagent's
  stop that `proteus-stall.js` lets through drops its flight markers and snapshots, and a call older than
  the watchdog's idle window (40 minutes) no longer overlaps the lead's calls, so a killed or crashed
  subagent cannot inflate every later notice.
- The lead's notice lists each changed path once, with the agents whose calls overlapped, and stops at
  about 4 KB with "and N more". It names `install.js`, `proteus-shell-check.js` or the session-start sync as
  the likely cause when the lead's own run wrote guarded paths.
- The session-start sync is a lead window, so an agent's shell call in flight across a compact gets a notice
  instead of a block for the hook and settings copies the sync rewrote.

## [1.2.0] - 2026-10-17

Upgrading from 1.1.0:

- Run `node install.js --project` in each repo (or let the session-start sync do it). It now also copies
  `teams/proteus-confine.js`, which `teams/link-skills.js` needs; commit it with the rest of `teams/`. Worker
  worktrees now live under `.worktrees/` in the repo, not in `../<repo>-proteus/`; a run opened before the
  upgrade keeps its old worktrees until they merge.
- The verdict is now a commit status. Re-run `node install.js --protect` (as an admin of the repo, once no run
  is open) so the `proteus/*` ruleset requires `proteus/verdict` and `proteus/security`; until then
  `--doctor` warns that a PR merges without the verifier's signoff.
- Optional: a GitHub App for the verifiers, so the agents' shared login cannot post those statuses. Create it
  with only "Commit statuses: write", then run `node install.js --verifier-app <appId> <keyPath>` in the repo
  (once per repo owner), and `--protect` again so the ruleset counts only the App's statuses.
- `PROTEUS_KEEP_SKIPPED` is gone; setting it does nothing, and the hook files a harness skips are always removed.
- A run branch cut before this release keeps the PR body's `Owned:` line check until its close PR merges.

### Added

- `lead-edits:` line in `AGENTS.md` (#113): globs relative to the repo root that the lead may edit directly,
  such as `.vscode/* .editorconfig .gitignore`, on Claude Code and Codex, and in guest mode for the repo's own
  files. `.claude/`, `.codex/`, `.agents/`, `.git/`, `teams/`, lefthook config, `.github/workflows/`,
  `.github/actions/`, links and paths that resolve outside the repo or onto that list stay refused.
- Auto mode denial rule for the lead, workers and verifiers: a denied call or spawn is never retried,
  reworded, split or routed elsewhere. The lead tells the human in one line and waits; a worker stops with
  `BLOCKED #<n> classifier <tag>: <action>`, and the stall watchdog's re-spawn skips it.
- `install.js` and `--doctor` on Claude Code suggest an `autoMode.environment` entry describing Proteus when
  `~/.claude/settings.json` has none, and point to `/auto-mode-setup`; they never write it (README, Auto mode).
- `proteus-gates-cache.js` warns on stderr when it runs a command in a folder that holds worker
  worktrees.
- The lead may write `.proteus/owned/<id>`. The run branch's first commit records every ticket known then; a later
  ticket is recorded through the lead-docs PR, merged with `--match-head-commit` (`stack.md`).
- `proteus-worktree.js` warns when the paths it is given differ from the branch's record.

### Changed

- The lead explores freely before the human approves the spec: it may add spikes, `/prototype`,
  `/research`, competing designs from helpers or a devil's-advocate pass, and propose a bolder direction
  or scope. That output stays in scratch and is thrown away. After approval the pipeline is as strict as
  before: skipping a step still needs the human's word, a `/research` finding or a settled default, and
  a run-log line.
- Workers apply ponytail's minimal style only on Quick and mechanical tickets. On `standard` and `hard`
  tickets the worker chooses the design inside its contract and owned paths and favours clarity and good
  craft over the fewest lines. The verifier's spec pass counts unrequested behaviour as extra, not
  helpers, structure or tests inside the owned paths.
- Worker and verifier briefs are now the ticket alone: the standing rules (long jobs, report once, scratch,
  worktree, commits, `NEEDS`, retries, review steps) moved from the `roles.md` templates into the agent
  files, and so into Codex's TOML roles. The worker brief went from 604 to 152 words, and no brief talks
  about hooks refusing or bypassing anything, which auto mode's classifier read as evasion.
- Worker worktrees move into the project: `.worktrees/<id>/` instead of `../<repo>-proteus/<id>/`, with
  `.worktrees/direct-<batch>` and `.worktrees/quick-<n>` for the Direct and Quick tiers.
  `proteus-worktree.js` adds `/.worktrees/` to `.git/info/exclude` once and never touches `.gitignore`.
  A run opened before keeps its worktrees beside the repo until they merge, and they still resume and
  merge.
- The lead runs the full suite and the bisect in `.worktrees/_run`, a detached checkout of the run branch
  with no worktree nested in it, so test runners that walk dot folders (vitest, jest, eslint) do not run
  the workers' copies. README "Worker worktrees" lists which tools walk into `.worktrees/` and how to
  exclude it.
- Codex: `--project` and the session start no longer add `../<repo>-proteus` to `writable_roots`. They
  keep it, like `../<repo>-hive`, only while git has a worktree registered there, drop it after, and no
  longer create `.codex/config.toml` when there is nothing to list.
- The Codex `writable_roots` editing is one function, `writableRoots` in `proteus-harness-codex.js`,
  tested on its own.
- `SKILL.md` is a short core: what Proteus is for, seven rules each with its reason, and the flow in outline.
  Each step's detail moved to the new `references/flow.md`, read when the run reaches the step. The body is
  ~3,650 tokens instead of ~7,750 (haiku 5.5), so the autostart injection on every start and compaction halves
  too.
- Hook refusals carry the rule the prose no longer repeats: the lead guard names the files the lead may write
  and how a fix goes out, the context refusal says to log the position before `/handoff`, the tier ceiling
  says to close the branch and keep the work whole, and `commit-msg.js` points to `references/commits.md`.
- `proteus-worktree.js`, `proteus-tier.js`, `proteus-scratch.js`, `proteus-close-report.js` and
  `proteus-status.js` explain their flags with `--help`; a usage error points to it.
- Agent files no longer repeat their own rule blocks in the opening paragraph, and the lead pre-dispatch check
  in `roles.md` no longer restates what the guard enforces.
- Verifiers watch CI with `gh pr checks <pr> --watch` without `--fail-fast` and skip `proteus/verdict` and
  `proteus/security` there: a red `proteus/security` is a signoff still owed, not a failed check.
- The lead-docs PR needs a verifier's signoff like any PR into the run branch.
- README: the Verifier App steps follow GitHub's current settings layout (the private key under Credentials >
  Key pairs, the App ID on the General tab, Install App with "Only select repositories"), and the Codex
  `writable_roots` text says a new repo gets no entry: `../<repo>-proteus/` stays only while an older run
  still has worktrees there.
- `install.js`, `teams/link-skills.js` and `install-lead-hooks.js` share one write and delete guard,
  `proteus-confine.js` (in `templates/hooks/`; `--project` copies it beside `teams/link-skills.js`). A path is
  removed or written only under a root its caller owns with no link between the root and the path, and only
  when it is the kind expected: a link, a regular file, or (for `install.js`) a directory.
  `install.js` now also refuses a link below one of its roots (it followed one that stayed inside), a FIFO,
  socket or device, and a file `--project` cannot copy stops the run with the path to move.
- `install-lead-hooks.js`, refusing a linked `.claude` or `.claude/hooks`, names the link and says to replace
  it with a real directory and re-run.

### Deprecated

- On a run branch whose base has no `.proteus/owned/` (a run cut before this release), the step still reads the
  PR body's `Owned:` line and prints a warning, until that run's close PR merges. This fallback is removed in the
  next minor release. PRs into `main` (Quick, Direct) keep the body's line, since the human merges them.

### Removed

- `PROTEUS_KEEP_SKIPPED`: `install-lead-hooks.js` always removes the hook files its CLI skips, through the
  shared guard, and `install.js` no longer removes them first.

### Fixed

- Auto-update no longer skips silently: a checkout with local changes, or a merge git refuses, now prints
  one line saying the update to the new release did not happen (#113).
- The Proteus skill's description was invalid YAML (an unquoted value containing `: `), so Claude Code
  dropped the skill's whole frontmatter, including `disable-model-invocation`, without any warning. The
  description is now a block scalar. A test now checks the frontmatter of every shipped markdown file.
- Codex `writable_roots`: a `["sandbox_workspace_write"]` header written with quotes is read as the
  table instead of getting a second `[sandbox_workspace_write]` table appended, which Codex rejects, and a
  table that sets `writable_roots` twice is refused instead of edited. On Windows a root listed with `/`
  separators counts as the same folder as one with `\`. The `[[sandbox_workspace_write]]` refusal now
  says to make it a single table.
- The guards' `--edit-last` rule no longer refuses a command that only mentions the flag. It used to match the
  text anywhere, so a heredoc editing a doc that quotes it, an `echo` or a `grep` was refused. Now only a `gh`
  call (or `proteus-gh.js`) that carries the flag is refused, read with the shell parser past `env`, `timeout`
  and the other wrappers, and inside `sh -c`, `eval`, `$( )` and backticks. A line that also runs a shell or
  `eval` has its quoted words and heredoc bodies judged as commands too, so `bash <<EOF` and `… | sh` stay caught.
- State migration merges a `*.jsonl` log past 8 MB instead of leaving it behind: the merged log keeps its
  newest 8 MB, with a first line marking that older lines were dropped. Each side is read only from its end.
- State migration names what it refused to move: a FIFO, a socket or a device, instead of `ENOTREG`.
- The compaction recall opens `journal.jsonl` without following a link (also one swapped in after the
  check, where the OS has `O_NOFOLLOW`), never blocks on a FIFO, and skips a state folder that is a link.
- `proteus-gates-cache.js --help` no longer runs `--help` as a shell command, `proteus-skillpath.js --help` no
  longer looks for a skill named `--help`, and `proteus-inbox.js --help` no longer lists the inbox. Each prints
  its usage and exits 0 without side effects, and the usage errors of the first two point to `--help`.
- `proteus-status.js --help` no longer reads `--help` as a run name.
- Codex `writable_roots` are compared case-insensitively on macOS and Windows, so a root listed as
  `/Users/Me/x` is not added again as `/users/me/x`. A `[[sandbox_workspace_write]]` array of tables is
  refused with a message, like the other forms the installer does not edit, instead of being missed.
- State migration no longer moves a FIFO, socket or device from the legacy folder, and no longer merges a
  `*.jsonl` log over 8 MB; both are reported as failed and left where they are.
- The compaction recall no longer reads a `journal.jsonl` that is a link or not a regular file.
- `link-skills.js --confine` prints how many global links it removed, and says there was nothing to remove
  instead of "confined" when it removed none.
- An owned path with no wildcard, such as `src/auth`, covers the files below it, not only a path ending in `/`.
- `tests/run.js` names a test file that crashes, counts it in the failed total, and no longer loses the
  summary line of a file that prints more than 1 MiB.
- `install.js --doctor` checked whether `gh` was logged in after deciding to skip the ruleset and collaborator
  rows, so those rows never ran. They run now, and the ruleset row warns when it does not require the new
  statuses.
- The verifier App now keeps one installation per repo owner (`verifierApp.installations` in
  `~/.claude/proteus.json`). An installation belongs to one account or org, so before, repos under a second
  owner (your account and an org) got a token request against the first owner's installation, which GitHub
  refuses with HTTP 422 and every signoff there failed with no hint. `--verifier-app` run in a repo of another
  owner adds that owner and keeps the rest; a signoff picks the repo owner's installation and, when there is
  none, fails naming `--verifier-app`; `--doctor` checks the current repo's owner and `--protect` warns when it
  has none. An older config's lone `installationId` keeps working and moves into the map on the next
  `--verifier-app`.
- A state migration that leaves a FIFO, socket or device behind no longer says the next `--project`
  retries it; its reason already says to delete or move it by hand.

### Security

- On Claude Code the lead guard binds a subagent to the prepared worktree its brief names (#85), read from the
  first message of the subagent's transcript (`agent_transcript_path`, else
  `<session>/subagents/agent-<id>.jsonl`), through a new adapter method, `briefText`. Before, a subagent
  outside a prepared cwd was bound by its first edit, so one whose first edit landed in a sibling's worktree was
  bound there and not refused. Now that edit is refused, and so is an edit in any other linked worktree of the
  repo, with a message naming the brief's worktree. A brief that names no worktree (helpers, the scout, the
  guide) or several (a contracts worker) keeps the first-edit binding.
- Codex keeps the cwd and first-edit binding: multi-agent v2 stores the spawn message encrypted in the
  subagent's rollout, so its `briefText` is empty.
- A subagent's shell is judged more deeply before it runs (#48). `lib.agentShellDenial` now also judges the
  command `xargs` and `find -exec`/`-execdir`/`-ok` run. It refuses `git checkout`/`restore` of a guarded path
  from another commit, and `git apply`, `git am`, `patch` and `git stash pop`/`apply` that would write one.
  It refuses `rm -r`, `mv`, `cp -r` and `rsync` of a dir that holds one, and a force-push set up through git
  config, `push.default`, an alias or a `gh api` ref update. Git Bash drive paths (`/c/...`) and Codex's shell
  `workdir` are read. `git checkout -- <file>` in the agent's own worktree, `find -print` and `xargs grep`
  still pass.
- New `proteus-shell-check.js` (`PostToolUse` on `Bash`) catches what the command line hides: an interpreter
  write (`python -c`, `node -e`, a build script), a path in a variable or a glob. The guards fingerprint the
  guarded paths before each subagent shell call, with the other workers' idle worktrees' `git status`, and
  compare after it. A change git does not explain blocks the agent with the paths named until it puts them
  back, and is recorded in `<git-common-dir>/proteus/tamper/`. Meanwhile `proteus-signoff.js` refuses MERGE
  on that branch. The hash cache in `<git-common-dir>/proteus/guard-hash.json` holds only the current
  fingerprint's paths, at most 8000. Pre and Post together add about 70 ms to a subagent shell call.
- The git config files are compared by key, not by hash: `user.*`, `color.*`, line endings, the file mode
  bit and the agent's own branch's upstream pass, and any other key an agent sets (`core.hooksPath`,
  `alias.*`, `remote.*`, `include*`, ...) is named in the block.
- What changes while one of the lead's own shell calls overlaps an agent's is not pinned on the agent: the
  lead is shown a notice with the paths (`proteus-shell-check.js --list`, `--clear <n>`), and its call
  re-baselines the agents' snapshots and open records.
- CI's `owned paths` step no longer trusts the PR body on a run branch (#86). A worker's PR from
  `proteus-work/<run>/<id>` is checked against `.proteus/owned/<id>` as committed on the base `proteus/<run>`,
  which the lead writes and which changes only through a merged PR with `gates` green. The step reads the base's
  copy, never the PR's, runs the base's `proteus-owned-check.js` from a detached worktree of the base, refuses any
  PR that touches `.proteus/owned/` except the lead's docs PR, and fails when the ticket has no record. Editing the
  PR body's `Owned:` line no longer widens what CI lets through.
- The worker guard refuses a push to the lead's docs branch `proteus-work/<run>/lead-docs`, whose PR may change
  the records, and the pre-commit owned check refuses a staged record whatever the worktree's list covers.
- The verifier's verdict is now a commit status the run branch requires (#81). `proteus-signoff.js <pr> <sha>
  <WORD>` posts `proteus/verdict` on the PR head the verifier reviewed (success on `MERGE`, failure otherwise) and
  refuses a head that moved since. `install.js --protect` and the per-run protection in `enforcement.md` §1
  require `gates`, `proteus/verdict` and `proteus/security`, so no tool merges a PR without the verdict, and a
  push after the review needs a new one. `enforcement.md` no longer calls `MERGE` a record.
- Security triggers come from the `security` block of `teams/ROUTING.md` (path globs) instead of the lead's
  judgement alone. The new `proteus-trust.yml` workflow runs on `pull_request_target` from the base branch, never
  the PR's code, and posts `proteus/security`: success when no changed path matches, failure naming the paths
  until the security verifier signs off with `--security`. Semgrep findings in changed files can trigger it too
  (opt-in steps in the workflow, `--findings`).
- The guards refuse a commit status or check run posted by hand to everyone, `proteus-signoff.js` to the lead
  and to any agent that is not a verifier, and `--security` to any verifier but the security verifier. The
  agents still share one login, so a worker's own script could post a status; a verifier identity of its own is
  #69.
- The verifiers can sign off as a GitHub App of their own (#81). `install.js --verifier-app <appId> <keyPath>`
  records an App that has only "Commit statuses: write" and its private key; `proteus-signoff.js` then posts
  `proteus/verdict` and `proteus/security` with a short-lived installation token of the App (in the `gh`
  call's environment only, never on disk or a command line), and `--protect` pins those two statuses to the
  App's id, so a status posted with the agents' shared login no longer counts. A signoff whose token does not
  mint fails with the reason; it never falls back to the agents' login. With the App, a verifier's `MERGE`
  also carries CI's no-security-path `proteus/security` over as the App's, after checking the PR's files
  against the base's security block itself. `--doctor` checks the key, a token and the pinned ruleset.
- The guards refuse every agent, the lead included, reading, editing or naming the App's key, and any agent
  shell that sets `GH_TOKEN` or `GITHUB_TOKEN`; `proteus-shell-check.js` fingerprints the key. A worker's
  session refuses `proteus-signoff.js` whatever the agent is called, and the lead guard refuses it from an
  unnamed subagent whose brief names a worktree. The worker guard now also sees `Read` and edit tools.
- Both guards refuse more from a subagent's shell (#48). A force-push to any branch, the worker's own included
  (`--force`, `-f`, `--force-with-lease`, a `+refspec`). `git -C`, `--git-dir`, `--work-tree` or `GIT_DIR`
  aimed anywhere but the agent's own worktree. A write to `.claude/`, `.codex/`, `.agents/`, `.git/` (scratch
  excepted), lefthook config, `.github/workflows/`, `.github/actions/`, `teams/templates/hooks/` or the user's
  `~/.claude`, `~/.codex` and `~/.agents` by `sed -i`, `perl -i`, `ruby -i`, a redirect, `tee`, `cp`, `mv`,
  `ln`, `install`, `dd of=`, `truncate`, `touch` or `rm`. Paths resolve after a leading `cd` chain, through
  wrappers, `sh -c` and `eval`, and match case-insensitively with either path separator. Writes to owned
  paths, a plain push of the worker's branch, and git in its own worktree still pass.

## [1.1.0] - 2026-10-04

### Added

- Agent patches: a project changes a shipped agent by writing only the change in
  `.claude/proteus-agents.json` (`tools` add/remove, `model`, `effort`, `append`). `--project`, `--update`
  and the session-start sync regenerate the agent from the shipped file plus the patch, so later releases
  still reach it; `--doctor` names the fields a hand-made copy changes (#97).
- When a release changes a shipped `ROUTING.md`, `PROFILE.md` or `skills.txt` that the repo has edited,
  `--project` writes the new text beside it as `<file>.upstream` (and the old shipped text as `<file>.base`)
  and prints the `git merge-file` line; `teams/.proteus-base.json` records where each copy came from, and
  `--doctor` lists merges still pending (#97).

### Fixed

- The branch guard skips a wrapper's own options before the command, so `rtk -v git push`,
  `env -i git push`, `sudo -u x git push`, `timeout 10 git push`, `nice -n 5 git push`, `nohup`, `stdbuf`,
  `time` and `xargs` no longer hide a push to the default branch (#23).
- The installer and the session-start sync never write or delete through a link the repo planted: a
  linked `teams/` dir or file, `.claude`, `.claude/agents`, `.codex`, a skills lock file, a generated
  agent, `.proteus-base.json` or an `.upstream`/`.base` file is refused with its path. Before, a committed
  `.claude -> ~/.claude` could delete global agents and skill links (#22).
- `--doctor --fix` fetches a missing team skill, as its remedy line says; `--update` refreshes a
  self-hosted checkout as a project; `--project` from a subdirectory sets up the repo root; the self-host
  exclude is written before the copy (#22).

### Changed

- CI: `ci.yml` and the shipped gates template get a read-only token, check out without persisted
  credentials, pin `actions/checkout` and `actions/setup-node` to commit SHAs, and pass refs to scripts
  through `env:`, never `${{ }}` inside `run:`; `ci.yml` installs with `npm ci --ignore-scripts`. The
  vendored anti-slop rules record their upstream and licence (#22).
- The lead commits its own docs on local `main` until `proteus/<run>` exists, then through a lead-docs PR
  into it; Quick and Direct branches are cut from `origin/main` (#24).

## [1.0.1] - 2026-10-04

### Added

- A repo that requires an AI attribution trailer adds the line `attribution: allow` to its
  `CONVENTIONS.md`; `commit-msg.js` then accepts it. `"attribution": "keep"` in `proteus.json` stops
  the installer from rewriting the `attribution` setting (#94).

### Fixed

- README: the Windows PowerShell steps that trust the release key work on Windows PowerShell 5.1, which
  passed the key list down the pipeline as one object and left the key empty (#92).
- Agents may write under their scratch dir (`proteus-scratch.js --path`); both edit guards refused it (#27).
- No owned-paths glob covers the owned-path list itself, in any spelling Windows or macOS resolves to it,
  and CI fails a PR that changes it, so a worker cannot widen its own ownership (#74).
- Hooks and `teams/link-skills.js` run in a repo whose `package.json` sets `"type": "module"`: a
  `package.json` of `{"type": "commonjs"}` ships beside them. Before, every hook threw on `require`
  and the guards failed open (#77).
- A worker worktree in a repo with no commit-msg hook (no lefthook yet, or a guest repo) gets one
  that runs `commit-msg.js`, so a message CI would reject fails at commit, not on the PR (#28).

### Changed

- Verifiers run the standards and spec passes themselves instead of `/code-review`, which their tools
  cannot run (#60, #75). Worker and verifier briefs end with their report template, and the lead resends
  a brief once when a report misses a field (#29).
- Claude Code workers start each shell call with `cd <worktree> && ` and push their branch by name; Codex
  workers set `workdir` (#58). Role prompts take an optional safety slot from a team profile (#61).
- Only review issues (`proteus-review`) hold dispatch, not open questions (#26). The lead runs
  `install.js --doctor --fix` when team skills are unlinked (#30), and asks before adding the lint
  dependency to a repo that forbids new ones (#25).

## [1.0.0] - 2026-10-04

First signed release. Proteus was called hivemind; `install.js --update` in a hivemind checkout migrates
its state and open runs.

### Added

- Change tiers: Direct, Quick, Standard and Full, set per path by a `tiers` block in `teams/ROUTING.md`.
  `proteus-tier.js` classifies a change before work starts; the worktree pre-commit hook and a CI `tier`
  step fail one that outgrows its tier. Quick and Direct PRs go into `main` for the human to merge.
- Model tiers `judge`, `build` and `helper`, set in `proteus.json` (`top` and `mid` stay valid).
- A separate agent identity: agents can post under a GitHub login of their own, and review verdicts and
  answers count only from the human's login.
- Guest mode (`install.js --project --guest`) keeps `teams/` and the lead's docs outside a repo you do
  not own.
- CI runs `gates` and a `qa` job (e2e, smoke, rebuild, mutation) on every push to a run branch; the QA
  verifier reads those runs instead of repeating them. Tested on Linux, macOS and Windows.
- `proteus-baseline.js` ratchets gates that were already red, so only new findings fail.
- `proteus-gates-cache.js` runs a gate once per clean tree and command; `proteus-watchdog.js` replaces
  the stall timer; `proteus-close-report.js` prints cost, wall-clock, bounces and escalations per ticket.

### Changed

### Changed

- Updates move the Proteus checkout only to a signed release tag that `git verify-tag` accepts, by
  fast-forward, and show this changelog for the versions in between. `--update` and auto-update no longer
  follow the tip of `main`; an unsigned or untrusted tag is skipped with the reason.
- The cost report pins `ccusage@20.0.26` and `@ccusage/codex@19.0.0` instead of `@latest`.
- Dispatch follows the dependency graph instead of waves; contracts workers run in parallel per team,
  verifiers start on `DONE`, and merges go in batches with one suite run each (a red batch is bisected).
- Each contract lands inside its ticket's PR, and ticket branches no longer have to be up to date to merge.
- context-mode is optional: agents use its tools when listed, otherwise a scratch file and grep.
- Rule wording is plain and states each rule once with its reason; `SKILL.md` is ~11% shorter
  (~5,400 tokens for the body, measured).

### Fixed

- The lead guard refuses admin merges, pushes to `main` and branch-protection changes.
- On Windows, gate and `ccusage` arguments reach the program intact instead of through a `cmd.exe`
  line where a quote could expose `>` or `&`.
- The installer guards every delete, keeps custom team rosters, and compares roots case-insensitively.
