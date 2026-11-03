### Added

- Dependency consent, enforced by a hook (#367). New dependencies are decided in planning (#368), and the one
  exception to "no pull request waits for the human" is a pull request whose diff adds or upgrades a dependency
  planning did not approve. In every mode, local and hosted, into the run branch or not, it is held until the
  human's verdict on it has a `DEPENDENCY <name>` line for each one, or their `ACCEPT <sha12>` for its head. The
  lead asks it as a planning question, and only that pull request is parked. Manifests and lockfiles are known by
  file name across ecosystems, and lockfile churn passes once a dependency is approved. The approval is the human's
  verdict as before: their own login's comment, or in local mode the record that only their approved post writes.
  A diff gh cannot give holds the pull request too, with one line saying the dependency check could not read it.
