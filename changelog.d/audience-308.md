### Added

- An audience profile, `proteus-profile.js` (#308): per project and machine in `<git-common-dir>/proteus-lead/profile.json`,
  how familiar the human is with the kind of work the project does (`new`, `some`, `fluent`), whether they learn along
  the way, only when they ask, or not at all, and the terms they have shown they know (at most 300).
  `show`, `set`, `know`, `forget`, `terms` and `path` on the command line; a malformed file reads as unset. The
  autostart's state line says `audience=<familiarity>/<learning>` or `audience=unset`.
- Decision cards (`references/audience.md`): every decision that reaches the human states its effect on them and
  their users, the options as outcomes with a recommendation, the technical detail folded underneath, and how to
  answer, worded at the profile's level. The lead gauges the profile at bootstrap; the review guide's brief and the
  review session speak at that level.
