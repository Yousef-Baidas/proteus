### Fixed

- Verifiers and the guide keep their memory during a run again (#181). Claude Code writes a `memory: local`
  agent's notes to `.claude/agent-memory-local/<agent>/` in the lead's checkout, and the lead guard refused every
  subagent edit there while a run was open, so the notes were dropped. A subagent may now write its own dir
  (named after its agent type, a named spawn's `subagent_type` included) when that Proteus agent declares
  `memory: local`. The lead, another agent's dir, a path a link moves elsewhere and the rest of `.claude/` stay
  refused.
