### Changed

- Owned-path globs own everything below a folder they match, wherever the wildcard sits (#96): `src/*` now owns
  `src/a/b.js` and `packages/*/src` owns `packages/x/src/y.js`, in the edit hooks, pre-commit and the CI owned-paths
  step alike.
- One `samePath`, in `proteus-confine.js` (#96). Every caller now resolves both paths first, so a trailing or doubled
  separator no longer makes two paths differ, and folds case on macOS as well as Windows; a missing path is never
  the same as another.
- Each `EDIT` hint in `proteus-gates.yml` names the `AGENTS.md ## Learned` field or `teams/qa/PROFILE.md` step its
  command comes from (#96).

### Fixed

- Lead and worker hooks for Claude Code are registered as `node "<absolute path>"` instead of
  `node "$CLAUDE_PROJECT_DIR/..."`, which only bash expands, so they also run under cmd.exe and PowerShell on
  Windows (#96). The installer rewrites the old form in place; a moved checkout re-runs `install.js --project`.
