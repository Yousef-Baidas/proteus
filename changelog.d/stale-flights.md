### Fixed

- `proteus-shell-check.js` no longer keeps a finished subagent's shell calls in flight (#140). A subagent's
  stop that `proteus-stall.js` lets through drops its flight markers and snapshots, and a call older than
  the watchdog's idle window (40 minutes) no longer overlaps the lead's calls, so a killed or crashed
  subagent cannot inflate every later notice.
- The lead's notice lists each changed path once, with the agents whose calls overlapped, and stops at
  about 4 KB with "and N more". It names `install.js`, `proteus-shell-check.js` or the session-start sync as
  the likely cause when the lead's own run wrote guarded paths.
- The session-start sync is a lead window, so an agent's shell call in flight across a compact gets a notice
  instead of a block for the hook and settings copies the sync rewrote.
