### Added

- The lead guard and the worker guard apply the policy (#307) to each shell call and each edit, after their own
  checks, which still win: a block rule refuses with `policy <id>: <why>`; an ask rule opens the permission dialog
  for the lead's own call on Claude Code, and elsewhere (a subagent, a worker, Codex, a mode with no dialog)
  refuses so the agent files `NEEDS`. An invalid policy file refuses edits and shell writes until it is fixed,
  naming the file and its first error. `teams/policy.json`, `teams/POLICY.md` and the user's
  `proteus-policy.json` are refused to every edit and agent shell write, and the shell-check fingerprints them.
  `proteus-policy.js write` is a permission ask showing the rendered draft for the lead on Claude Code, a refusal
  with the command for the human's terminal where no dialog can appear, and always refused to a subagent or worker.
