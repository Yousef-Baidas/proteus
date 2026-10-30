### Fixed

- The hooks' gh calls (`lib.gh`, `lib.ghTry`) and `proteus-intake.js` now give gh `GH_REPO` from `remote.origin.url`
  in the project's pinned `<common>/config`, so gh no longer names the repo with its own unpinned `git remote -v`,
  which a planted `<common>/commondir` can aim at another repo (#231 D4). `proteus-intake.js` reads through
  `lib.ghTry` instead of its own `gh` spawn.
- The Codex adapter's `exportEnv` runs git only on the project's own repo, never on a repo the hook event's root
  names (#231 D11).
- New tests pin the lead's bare `git push` refusal in a clone outside the project (D9), `proteus-worktree.js`
  writing no `info/exclude` into a dir a worktree's `.git` file names (D10), and route 8 of `tests/safegit.test.js`
  checking that no `config.worktree` was written in the outside repo (D12).
