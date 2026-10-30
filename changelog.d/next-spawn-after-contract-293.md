### Fixed

- `next` keeps printing `SPAWN worker #<n>` after the contracts worker commits the ticket's contract (#293).
  A branch whose only commits past its base are `test(<scope>): contract for #<n>` commits, with no open PR and no
  spawn record for the ticket, still counts as the lead's to spawn; any other commit counts as work in progress.
  `brief` and `next` share the contract-commit match.
