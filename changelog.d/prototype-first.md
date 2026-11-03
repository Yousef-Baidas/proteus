### Changed

- Prototype first (#344): the first wave builds a rough but complete, working version of the deliverable, the
  thinnest path through every part. A prototype ticket outside the `security` block gets a light review: it runs
  and its ticket's checks pass; security paths keep the full review. Later waves harden it in small slices with the
  usual per-PR review, and a plan of one wave is all prototype.
- The close passes are now the run's required final pass over the whole deliverable. `proteus-cli.js close` prints
  `close: ready`, exit 0, only once a trusted `close-passes: <run> <sha>` run-log line names a commit that origin's
  tip extends by added owned records, lessons and ADRs alone; else `close: run`, exit 1, naming what changed, which
  the rerun rechecks. `milestone-passes` lines no longer skip the close passes.
