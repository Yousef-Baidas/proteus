### Changed

- Local mode counts a human verdict only from the verdict record in `proteus-lead`, written after the permission dialog or from the human's own terminal; no store comment ever counts, and the stand-in's `pr merge` refuses what the policy holds (#310). The record stops a sandboxed agent, not an unsandboxed one: it is a working log, not proof.
