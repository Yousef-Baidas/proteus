### Added

- An adaptability eval, `tests/adapt.test.js` (#170, #82): six fixture repos built at test time (a legacy app with a
  red suite, binary art, notebooks, a repo the human can only read, a docs site, a mature library with a one-line
  fix), each scored on the teams setup gives it, its `--doctor` rows, the tier and security signoff of planned
  changes, and its ceremony (the baseline ratchet, guest mode). It prints a score table and fails on any miss; an
  expectation no deterministic code decides is listed as a gap. `PROTEUS_ADAPT_MODEL=1` names what a model-backed
  run would score; that run is not built.
