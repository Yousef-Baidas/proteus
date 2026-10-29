### Added

- Refactor checkpoint at step 1 (#195): on Standard and Full runs a `helper` scans the modules the work order
  touches with the architecture scan `enforcement.md` §10 runs at close, and reports at most three refactor
  candidates with their cost to the planned work. With candidates, the human picks refactor first (a prep
  milestone), defer to debt, or ignore; with none, nothing is asked. The answer goes on the run log as
  `refactor-checkpoint: <first|defer|ignore|none>`.
