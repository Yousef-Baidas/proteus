### Added

- A lead command, `add team <role>` (#10): the scout runs in single-team mode for that one team, under the same
  rules as a full roster (sources, `Owns`, checks, skill search, scan, caps, zero skills valid), and proposes a
  narrowed `Owns` for any existing team it overlaps. On approval, one ticket creates the team's `PROFILE.md` (and
  `CRAFT.md` if needed), its `ROUTING.md` rows, the `profile:<team>` label, its worker and verifier agent files,
  `skills.txt` and any authored skills, and the narrowed `Owns`. Prompt-only: no script creates labels or agent
  files for a roster today.
