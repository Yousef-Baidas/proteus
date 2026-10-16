### Security

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

### Fixed

- `install.js --doctor` checked whether `gh` was logged in after deciding to skip the ruleset and collaborator
  rows, so those rows never ran. They run now, and the ruleset row warns when it does not require the new
  statuses.

### Changed

- Verifiers watch CI with `gh pr checks <pr> --watch` without `--fail-fast` and skip `proteus/verdict` and
  `proteus/security` there: a red `proteus/security` is a signoff still owed, not a failed check.
- The lead-docs PR needs a verifier's signoff like any PR into the run branch.
