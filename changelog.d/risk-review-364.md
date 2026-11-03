### Changed

- Review scales to risk (#364): every ticket body carries `Review: light` or `Review: full`, and a missing line
  counts as full. A light ticket gets one verifier; a full one also gets the security verifier, which `next` names
  as `security=full` on the `SPAWN verifier` line, and `proteus-merge.js` leaves its PR open until
  `proteus/security` carries the security verifier's MERGE, not CI's no-path success. CI's security-path and
  scanner checks still apply on both paths.
- At most two review rounds per PR: round 2 reads only the delta since the signed head and whether each round-1
  finding is fixed; a PR still failing goes to the lead, never round 3. Style (line width, import order, naming
  taste, formatting) is never a blocker, only a debt line; a `CONVENTIONS.md` rule blocks only when the project's
  own gate checks it.

### Added

- A security verifier's MERGE stays valid over a whitespace-only push: the verifier's MERGE on the new head
  carries it over as `proteus/security` when `git diff -w` from the signed head is empty (`proteus-signoff.js`).
  A failure or a later security verdict is never carried.
