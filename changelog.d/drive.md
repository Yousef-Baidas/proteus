### Added

- `proteus-cli.js drive [run] [--json]` (#344): the lead's loop in one call. It runs `next` in a loop and does
  the mechanical lines itself in the caller's shell and sandbox: each `RUN` line (a suite run, then
  `result pass|fail --at <sha>` from its exit code), the watchdog's `WAIT`, and records `SWEPT`, `NOTE` and
  `MERGED`. It returns, exit 0, when a line needs the lead (`SPAWN`, `ASK`, `DECIDE`, `STOP`, `NUDGE`,
  `MERGE`, or only `BLOCKED`), printing what it did as `DID` lines first. A failed non-suite `RUN` stops it
  with `BLOCKED RUN exited <code>: <command>`; a round cap (`PROTEUS_DRIVE_MAX`, default 50), a no-progress
  check and a repeated-`RUN` check stop it with a `NOTE drive:` line. `RUN` and `WAIT` actions in `next
  --json` now carry their steps as `argv`, and a suite `RUN` also `suite`, `at` and `gate`. The skill has the
  lead run `drive` in the background instead of calling `next` and running `RUN` lines by hand.
