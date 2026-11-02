### Added

- A verifier returning to a PR after fix commits now rechecks only the
  delta from the head it signed, and `brief verifier` falls back to a
  full review on any doubt. The signoff still binds to the new head.
