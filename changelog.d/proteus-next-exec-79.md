### Changed

- `proteus-cli.js next` now runs the steps that run outside the sandbox and prints the rest as `RUN <command>` lines
  (#79). It prepares a ready ticket's worktree with its owned list and `Tier:` (a `RUN` line under
  `install.js --sandbox`; a failure is `BLOCKED #<n> prep:`) and names it on the `SPAWN worker` line. It starts the
  merge batch through `proteus-merge.js`'s own code with the `gate:` command from `AGENTS.md` `## Learned`, printing
  `MERGED` per PR and the batch's run-tree and suite as one `RUN` line until the result is in; with no gate command
  it merges nothing and prints `DECIDE suite`.

### Added

- `proteus-cli.js result pass|fail --at <sha>` reports the batch's suite result to `proteus-merge.js --result`. A
  bisect step is the next `RUN` line. A pass prints `STOP` for the merged tickets' workers and verifiers, checked
  against gh, and the watchdog's `--forget` for them as a `RUN` line. A worker's spawn record now carries its ticket.
