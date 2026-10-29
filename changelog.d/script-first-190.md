### Added

- A script-first rule (#190): a deterministic procedure the lead or a worker has run twice becomes a ticket for
  a program in the project's `scripts/` (or `teams/<team>/bin/` for team tooling) with `--help` and an exit
  code, and later briefs call it. Only the ambiguous step stays with a model, writing a file the program reads,
  and the verifier rejects a brief or skill that is a program in English. The rule is in `roles.md` and word
  for word in every agent file; `flow.md` names the trigger, the second occurrence, logged on the run log as
  `script-ticket: <procedure> #<n>`.
