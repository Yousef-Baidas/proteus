### Added

- Authored team skills (#10): `teams/<team>/skills/<name>/SKILL.md`, committed and never published, are linked
  and locked like found skills (`"source": "authored"`) and count toward the team's cap. One named like a listed
  skill prints `dup: <team> <name>`; each is run through `proteus-skill-scan.js` first, and a finding prints
  `scan: <team>/<name> FINDINGS <n>`. Either links nothing for the team (exit 3) until fixed, or for a finding
  until `--relock` records `"scan": "<sha256>"` for that content. The scout drafts one when nothing qualifies
  and research finds craft knowledge beyond the model's defaults.
- Commit pins (#10): a `skills.txt` line may end with `@<sha>`; `--install` runs `npx skills add
  <owner/repo>#<sha>`, and the lock keeps the sha beside the hash.
