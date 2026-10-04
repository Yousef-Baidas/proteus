# Changelog

Notable changes per release. A release is a signed `vX.Y.Z` tag (README, "Releases"); when tagging, move the
`Unreleased` notes under a new `## [X.Y.Z] - YYYY-MM-DD` heading. Updates print the sections between the
installed version and the new one.

## [Unreleased]

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
