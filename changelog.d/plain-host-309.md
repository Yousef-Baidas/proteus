### Added

- Plain words for the code host (#309, `references/audience.md`): below `fluent`, the host's words for its objects
  and actions are replaced with what happens in the human's project, taught only under `learning=along` or on request;
  a command the human must run stays exact, after a plain sentence saying what it does. The review session follows it.
- Approvals in chat: on a pull request the policy holds, the lead posts the human's decision itself through
  `proteus-verdict.js --post`, whose permission dialog shows the exact text; the human never opens the host. A pending
  milestone review is announced in plain words, then the exact command for the second session.
- A guided setup walkthrough, `docs/setup-walkthrough.md`: the agents' account, `--agent-login`, `--protect` and the
  verifier App, each with what it is for, what to do and the `--doctor` row that shows it worked. `/proteus:setup`
  asks whether the human has used GitHub before and, if not, walks it one step at a time.
