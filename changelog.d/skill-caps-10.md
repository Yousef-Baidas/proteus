### Changed

- `teams/link-skills.js` caps each team's `skills.txt` picks at 4 skills and 40960 bytes of combined
  `SKILL.md` text (#10), one exported `CAP` constant; `required.txt` does not count. A team over either cap
  prints `cap: <team> <n> skills, <bytes> bytes (max 4, 40960)`, links nothing and, under `--install`, runs no
  `npx skills add`; the other teams still link and the script exits 3. This replaces the old "eight per team".
- The shipped `skills.txt` starting sets fit the cap: backend drops `sql-code-review` (security keeps it),
  `email-and-password-best-practices`, `organization-best-practices`, `rust-best-practices`, `rust-async-patterns`
  and `m15-anti-pattern`; frontend keeps its first 4; qa drops `playwright-best-practices` (26 KB) and
  `rust-testing`.
