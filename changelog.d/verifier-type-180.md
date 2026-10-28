### Fixed

- A verifier the lead spawns with a `name` can run `proteus-signoff.js` again (#180). Claude Code reports a named
  spawn's name as its `agent_type`, so the guards read `verify-74` and refused it as no verifier. The lead
  guard now records each spawn's name and `subagent_type` under `<git-common-dir>/proteus/spawns/`, and
  `lib.agentTypeOf` maps a recorded name back to its type; an unrecorded value is used as it is.
