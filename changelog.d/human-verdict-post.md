### Security

- The human's verdicts go out under the human's own GitHub login: the review session runs `proteus-verdict.js <issue> --post --body-file <file> --sha <sha256>`, and the lead guard asks the human in a permission dialog first, showing the issue, the login and the body. Where no dialog can appear (plan, dontAsk and bypassPermissions modes, auto mode before Claude Code 2.1.211, `claude -p`, Codex) it denies and prints the command for the human's own terminal. Subagents, teammates and workers are denied, and `--post` refuses a body file whose hash changed since approval (#157).

- While the agents have a login of their own, the guards keep every agent off the human's: their gh config dir (resolved as gh does, `XDG_CONFIG_HOME` and `%AppData%` included), changes to `GH_CONFIG_DIR` or `GH_HOST`, `env -i`, `gh --hostname` and `gh auth login`, `logout`, `switch`, `token` and `refresh` (#157).
