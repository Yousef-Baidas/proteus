### Added

- A verifier's reproduction is kept as a test (#344 step 5): a finding
  that rests on one names it, written as a test in the project's test
  style in scratch and listed under a `Tests:` line. On BACK-TO-WORKER
  the worker adds it to the suite with the fix, unchanged except for
  placement and naming, and names it in its report; it never weakens or
  deletes a reviewer's test. On a recheck `brief verifier` writes the
  earlier test list to `tests-<pr>[-security].md` in scratch and names
  it, and the verifier runs those tests before writing new attacks.
