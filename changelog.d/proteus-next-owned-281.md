### Changed

- `proteus-cli.js next` opens one owned-path record PR per wave (#281, #79): every open ticket with an `Owned:`
  line and no `.proteus/owned/<n>` on `proteus/<run>` gets its record in one commit on
  `proteus-work/<run>/owned-<k>`, made from git objects alone (no worktree, index or checkout) and pushed as that
  one ref, and one PR with `Tier: full` that gets the usual `SPAWN verifier` line. While it is open no other
  record PR opens; a ticket waiting for its record prints `BLOCKED #<n> owned record pending PR#<m>` and gets no
  worktree. Records are add-only: a changed `Owned:` line prints `DECIDE #<n> owned line differs from record`.
  CI's `owned paths` step admits a record PR that only adds records, and the worker guard refuses a push to a
  record branch.
