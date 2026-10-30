### Fixed

- The contracts worker no longer pushes its red contract commit (#278): the repo's pre-push hook
  runs the suite, so the push failed once lefthook was installed. The worker and verifier read the
  commit locally from the shared object store, and it reaches origin with the first green push.
