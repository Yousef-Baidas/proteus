### Fixed

- Test runs no longer leave `proteus-test-*` dirs in the temp dir (#317). `tests/lib.js` removes a process's temp
  root when it exits, after a failure too, and its new `tempdir()` is how a test makes any other temp dir.
  `node tests/run.js` gives its children a temp dir of their own, fails the run if a `proteus-test-*` entry is left
  in it, naming the entry and the test file where it can tell, and removes that dir on any ending it can catch.
