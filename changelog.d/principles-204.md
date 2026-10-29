### Changed

- One Principles block for every tier and team (#204): five lines in `roles.md` (the simplest thing that meets
  the contract; no option, abstraction, file or dependency without a caller in this run; one source of truth per
  fact or rule; delete before you add; leave the touched area no worse), mirrored word for word in every agent
  file and so in Codex's TOML roles. Ponytail runs full on Quick and mechanical tickets and lite on standard and
  hard; the "favour craft over the fewest lines" wording is gone. Every non-code rubric in `domains.md` gains
  "nothing the brief did not ask for", and `domains.md` says the block binds non-code teams too.
  `tests/principles.test.js` guards the mirror, the rubric line and the `stack.md` ponytail tiers.
