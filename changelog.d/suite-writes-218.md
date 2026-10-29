### Fixed

- `node tests/run.js` now fails a run that changed the checkout it runs from (#218). Before the first test file
  it records `git status --porcelain` and the blob hash of every tracked file; after the last it compares them and
  lists each changed path under a `FAIL the run changed the checkout` line, counted once in the failed total. A
  worker that ran the suite and then committed with `git add -A` could ship test output in `AGENTS.md` or
  `CONTEXT.md`. Outside a git repo the check is skipped.
