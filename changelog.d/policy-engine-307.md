### Added

- A policy engine, `proteus-policy.js` (#307): it merges a preset (`templates/policy/presets.json`: `hands-off`,
  `balanced` by default, `careful`), the user's `proteus-policy.json` beside `proteus.json` and the project's
  `teams/policy.json`, rules by `id`; validates each file in plain words and treats an invalid one as absent;
  evaluates a shell call or an edit to the most restrictive matching rule (block, then ask, then allow); and
  renders `teams/POLICY.md`. `show`, `check`, `render` and `write` (which writes nothing for an invalid draft) on
  the command line. No guard calls it yet.
