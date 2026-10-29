### Added

- `proteus-ready.js <run>` prints the tickets ready to dispatch, with team and difficulty, then the blocked ones
  with the reason (#192): a ticket waits until every `depends-on` ticket has merged and none of its owned paths
  overlaps a ticket in flight. While a milestone is under review, the rest are marked speculative and must miss
  its paths. `flow.md` step 4 uses it.
