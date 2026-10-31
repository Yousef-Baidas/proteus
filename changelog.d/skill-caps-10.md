### Changed

- `teams/link-skills.js` caps each team's `skills.txt` picks at 4 skills and 40960 bytes of combined
  `SKILL.md` text (#10), one exported `CAP` constant; `required.txt` does not count. A team over either cap
  prints `cap: <team> <n> skills, <bytes> bytes (max 4, 40960)`, links nothing and, under `--install`, runs no
  `npx skills add`; the other teams still link and the script exits 3. This replaces the old "eight per team".
