### Changed

- Human gates move to planning and milestones (#368). No pull request into `proteus/<run>` waits for the human: the
  lead merges each once its checks and signoffs are green, and `proteus-merge.js` gives every merge its evidence
  (`Reviewed merge of PR #<n> at <sha12>: <checks> green.`) as the merge commit body, local mode included. The
  policy's `merge` and `ask` settings are retired: accepted and ignored, so the presets differ only in their rules.
- In local mode a security change into a run branch waits for the security verifier's `--security` signoff, not the
  human (#358); into the default branch it still waits for the human's `ACCEPT <sha12>`.
- Planning asks about scope, design choices, new dependencies, files Proteus may add to the repo and how the human
  will run the result. During the build the lead asks only before an irreversible, security-sensitive or
  outside-the-repo action, or when the plan is broken; a new design, scope or trade-off choice goes back to the
  human as a planning question. Every other call is a ruling, an implementation detail inside the human's decisions,
  logged as `RULING <what> — <why> — <cost if wrong>` on the run log and listed at the milestone review beside a
  "How to try it" note. The human's own verdicts go on the run log as `human verdict #<n>: accepted`.
