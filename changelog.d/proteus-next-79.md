### Added

- `proteus.js next [run] [--json]` prints the lead's due actions, one line each, from the tracker and the lead's
  local state: `ASK` for an open needs-human issue, `STOP` and `NUDGE` for stalled agents, `MERGE` for a PR
  `proteus-merge.js` would pick (with its head, verdict and who posted it), `SPAWN verifier` for a PR with no verdict
  and no verifier spawned for its head, `SPAWN worker` for a ready ticket, `BLOCKED` with the reason, then `WAIT`
  with the watchdog command when nothing else is due (#79). Read-only: it executes none of them. The lead
  guard records the `PR#<n>` and `head=<sha12>` of a verifier spawn's prompt, so `next` lists each head once.
