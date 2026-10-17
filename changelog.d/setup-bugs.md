### Fixed

- Setup from the plugin recognises a 1.x copy of any version ever shipped on `main`, tagged or not, from `scripts/known-blobs.json`; the plugin has no git history to ask (#154).
- One `--plugin-setup` run removes every 1.x leftover, including the `package.json` and exclude lines a removal frees, so `--doctor` finds nothing after it (#154).
- A `.base` is written beside every team file `.upstream`; when git tracks no copy and the three-way merge is clean, setup merges it in place and prints one line (#154).
- A tracked 1.x copy someone edited is named with its last author and left alone; setup and `--doctor` no longer advise deleting it (#154).
- A refreshed `teams/` file that git tracks and the repo edited is never overwritten: the shipped text goes beside it as `.upstream`, with a `.base` (#154).
- The plugin's gate accepts `enabledPlugins["proteus@proteus"]` from `.claude/settings.local.json` as well as `.claude/settings.json`, the local file winning; `--doctor` applies the same rule (#154).
- Setup runs the release check once when the plugin is installed; a failed fetch is one line, not an error (#154).
