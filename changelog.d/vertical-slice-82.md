### Added

- Slice tickets and cross-cutting changes (#82). A change whose contract between two teams would outweigh it can
  be one Quick or Standard ticket labelled `profile:<owner>` plus `slice:<team>[,<team>]`: its owned paths may
  fall in any named team's `Owns`, and the worker and verifier briefs name each slice team's `PROFILE.md`.
  `next` prints `DECIDE #<n> slice: tier <t> too large` for a slice label on a hard or full ticket. A
  cross-cutting change (rename, dependency bump, license header) is one `difficulty:mechanical` ticket owned by
  the mechanism's team, with an exact file list.
