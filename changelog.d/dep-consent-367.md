### Added

- Dependency consent at merge (#367). Whatever the policy, a pull request whose diff adds or upgrades a dependency
  in a manifest or lockfile, known by file name across ecosystems, is held until the human's verdict on it carries
  a `DEPENDENCY <name>` line for each one, or their `ACCEPT <sha12>` for its head. Lockfile churn passes once a
  dependency is approved. The approval is the human's verdict as before: their own login's comment, or in local
  mode the record only their approved post writes.
