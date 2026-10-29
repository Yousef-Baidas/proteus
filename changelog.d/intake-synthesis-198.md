### Added

- `intake` synthesis (#198): after the notes, one `judge` drafter reads them, `gh issue list --state all` and the
  repo, then posts draft issues and a coverage table on the intake issue. Each finding maps to exactly one of
  `issue <k>`, `shipped <file>`, `candidate` or `rejected <reason>`. Nothing is filed until the human replies
  `ACCEPT` or edits the list; then the lead files the issues with the `intake` label and posts a dispatch order.
- `proteus-intake-coverage.js <notes-file> <draft-file>` checks the coverage table against the notes and names
  every finding left unmapped, mapped twice, or cited by a drafted issue its row does not name. It reads only the
  two files.

### Changed

- An intake note's finding lines now start with an id `<h>-F<k>` (6 hex of sha256 of the source URL, then the
  finding's position), which the coverage table cites. A note posted before this change has to be
  deleted and posted again with `--post`.
