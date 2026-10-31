### Added

- A hand-off to the `teach` skill for learning the project in depth (#84), `proteus-learn.js`: on the human's request
  the lead prepares a `learn/` workspace kept out of git through `info/exclude`, seeds its mission, resources and
  glossary once from the project's own documents, and tells the human how to start the skill. `path`, `prepare`,
  `seed`, `status` and `seen` on the command line. The autostart's state line says `learn=<new>` when the workspace
  has records the lead has not read, and the lead reads them as data to update the audience profile. The skill stays
  optional and comes from another plugin. See `docs/learning.md`.
