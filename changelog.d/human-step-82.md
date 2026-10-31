### Added

- A human-operated step (#82): a ticket labelled `step:human` (a GUI tool, live infrastructure, a signature) is
  never spawned to a worker. `next` prints `ASK human #<n> <url>` for it while it is ready with no PR, and no
  `SPAWN worker`, so no contracts worker runs; the human commits the evidence under its owned paths and opens the
  PR, which gets `SPAWN verifier` and merges like any other. `brief worker` on it prints
  `DECIDE #<n> human step: no worker brief` and exits 1.
