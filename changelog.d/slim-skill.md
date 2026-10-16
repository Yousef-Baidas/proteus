### Changed

- `SKILL.md` is a short core: what Proteus is for, seven rules each with its reason, and the flow in outline.
  Each step's detail moved to the new `references/flow.md`, read when the run reaches the step. The body is
  ~3,550 tokens instead of ~7,750 (haiku 5.5), so the autostart injection on every start and compaction halves
  too.
- Hook refusals carry the rule the prose no longer repeats: the lead guard names the files the lead may write
  and how a fix goes out, the context refusal says to log the position before `/handoff`, the tier ceiling
  says to close the branch and keep the work whole, and `commit-msg.js` points to `references/commits.md`.
- `proteus-worktree.js`, `proteus-tier.js`, `proteus-scratch.js`, `proteus-close-report.js` and
  `proteus-status.js` explain their flags with `--help`; a usage error points to it.
- Agent files no longer repeat their own rule blocks in the opening paragraph, and the lead pre-dispatch check
  in `roles.md` no longer restates what the guard enforces.

### Fixed

- `proteus-status.js --help` no longer reads `--help` as a run name.
