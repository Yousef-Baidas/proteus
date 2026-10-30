### Added

- A hook holds the human review gate (#254). The lead guard refuses a `gh issue create` labelled `proteus-review`,
  from the lead or any subagent, while the milestone it names has an open ticket (a `WAVE-RED` blocker or an unmerged
  one) or the tracker cannot say; `proteus-verdict.js` does not count `ACCEPT` or `AUTO-ACCEPT` on a review issue
  then, says why on stderr, and keeps waiting under `--wait`. `CHANGES` still counts. The open-ticket count is
  `proteus-lib.js` `milestoneOpen`, which `proteus-status.js` now uses too; `proteus-ready.js` uses the shared
  `runTickets` filter.
