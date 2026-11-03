### Added

- Acceptance checks from the requirement (#365): once the human approves the spec, the lead saves it as `spec.md` in
  the run's scratch dir and spawns the new `proteus-acceptance` agent on `judge` with only that file. It writes
  black-box checks, each quoting the requirement sentence it tests, into the run scratch's `proteus-holdout/`, outside
  the repo and every worktree. The QA verifier runs them at each milestone and at Close; a failing check becomes a
  `WAVE-RED` ticket quoting the sentence, not the check. The worker guard, and the lead guard for every subagent but
  a verifier and `proteus-acceptance`, refuse a Read or Edit of that dir and a shell command naming it.
- Every verifier checks the ticket against the requirement as well as the diff against the ticket: a ticket that drops
  or contradicts part of it is `CONTRACT-WRONG`, quoting the sentence. `proteus-cli.js brief verifier` names the saved
  spec in the spawn prompt (no spec saved is a `DECIDE`), and the lead guard refuses a verifier spawn
  whose prompt names no existing `<scratch>/<key>/spec.md`.
