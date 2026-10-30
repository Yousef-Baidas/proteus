### Fixed

- Milestone QA now converges (#280): the first pass's `WAVE-RED` findings are the milestone's QA list, the rerun is
  a `recheck` of that list plus the suite and CI that may not widen its sample, findings outside it go to the debt
  issue, and at most one fix cycle runs before the review gate opens with the open items first. The same holds for
  non-blocker security findings; a security blocker still blocks.
