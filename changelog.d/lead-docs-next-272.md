### Changed

- The lead docs are rewritten around `proteus-cli.js next` (#272, #79). `SKILL.md` opens with the loop and a
  table of every line kind `next`, `result` and `brief` print, saying what the lead does and which section to
  read. `flow.md`, `operations.md` and `harnesses.md` say in one sentence each step `next` now does itself, and
  keep the judgment. Resume and compaction come down to running `next`. The four files shrink from 56,110 to
  under 45,000 bytes, and `budget.test.js` caps them there.
