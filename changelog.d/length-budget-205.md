### Changed

- Proteus's own skill text has a byte budget (#205): `tests/budget.test.js` holds `SKILL.md` to 12 KB, each
  reference to 32 KB, each agent to 10 KB and all of them to 280 KB, measured with LF line endings.
  `enforcement.md` went from 78 KB to 32 KB: what each hook refuses, hook git, the lead's state and the human's
  verdict post moved to the new `references/hooks.md`, and text said twice, said in `docs/install.md` or
  `docs/github.md`, or said by a hook's own refusal was cut. The total went from 304 KB to 279 KB. No rule changed.
