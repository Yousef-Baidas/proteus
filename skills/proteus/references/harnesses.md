# Harnesses

The skill is written in Claude Code's names. On Codex CLI (`spawn_agent`, hooks in `.codex/hooks`) read this once per session and translate; the pipeline, rules and tracker do not change. `proteus-harness.js` holds the adapter contract, `docs/harnesses.md` the details.

## `next`'s lines

| Line | Claude Code | Codex CLI |
|---|---|---|
| `SPAWN` | the `brief:` in `Bash`, then `Agent` with `subagent_type`, `model`, the `PROMPT` | the `brief:` via `exec_command`, then `spawn_agent` with `agent_type`, `model`, the `PROMPT` as `message` (v2: `collaborationspawn_agent`) |
| `STOP` | `TaskStop` | `close_agent` |
| `NUDGE` | `SendMessage` | `send_message` |
| `RUN` | `Bash`, sandboxed | `exec_command` with `workdir`, inside the sandbox |
| `WAIT` | `run_in_background`; its exit wakes you, then `next` | `wait_agent` with `timeout_ms: 1200000` (returns early on a report); then `next` |

Running agents (`status`, `pause`): your task list; on Codex the agents spawned and not closed. On Codex the guard sees only shell, patch, image and spawn calls, so an agent that only reads looks idle to the watchdog.

## Names

| Thing | Claude Code | Codex CLI |
|---|---|---|
| Invoke a skill | `/proteus`, `/proteus-review`, `/<skill>` | `$proteus`, `$proteus-review`, `$<skill>` |
| Skills folders | `~/.claude/skills`, `.claude/skills`, plugin caches (`proteus-skillpath.js <skill>` finds one) | `~/.agents/skills`, `.agents/skills`; no Skill tool: read the `SKILL.md` and follow it. Team skills: `teams/<team>/.agents/skills/` (`teams.md`) |
| Project instructions | `CLAUDE.md` (and `AGENTS.md`) | `AGENTS.md` only; `docs-diet.md`'s `CLAUDE.md` rules apply to it |
| `<hooks>`: hooks and lead scripts | the dir the autostart's `proteus-state` line names as `hooks=<dir>`, copied literally: the realpath of the dir holding the running `proteus-lib.js` (the plugin's hooks dir under a plugin install, else `.claude/hooks`), recorded in `<git-common-dir>/proteus-lead/hooks-root`. `proteus-signoff.js`, `proteus-verdict.js`, `proteus-merge.js` and `proteus-gh.js` refuse to run from any other dir and name this one. `teams/templates/hooks` is CI's copy: no agent runs a script from it, nor from a plugin cache | the same, else `.codex/hooks` |
| Owned-paths file | `<wt>/.claude/proteus-owned` | `<wt>/.codex/proteus-owned` (the guard refuses a worker's `apply_patch` on it; the sandbox does not) |
| Worktree folder `.worktrees/` | writable | writable; an older run's `../<repo>-proteus/` stays in `writable_roots` until its worktrees go |
| Agents' GitHub login | `GH_CONFIG_DIR` from the autostart's `CLAUDE_ENV_FILE`, this session | `[shell_environment_policy.set]` in `.codex/config.toml`, from the next session, every session in the trusted project, `PROTEUS=0` ones too |
| Lead hook registration | `.claude/settings.local.json`; under the plugin its own hooks, live where `.claude/settings.json` enables `proteus@proteus` (`/proteus:setup`) | `.codex/hooks.json` plus `.codex/rules/proteus.rules`; the human trusts the project and approves the hooks in `/hooks` once |
| Plain session, no lead hooks | `PROTEUS=0 claude` | `PROTEUS=0 codex` |
| Agent definitions | `.claude/agents/*.md`; a project patch in `.claude/proteus-agents.json` | TOML roles in `$CODEX_HOME/agents`, no model or tool limits (verifiers read-only by instruction only); `.codex/proteus-agents.json` may `append` to a role |
| Worker tool surface | `disallowedTools` drop `Agent` and the plan, question, cron, wakeup, trigger, notify, watcher and worktree-switch tools; MCP servers stay | no tool limits |
| Worker's directory | named in the brief; each shell call starts `cd <worktree> && ` (`roles.md`) | named in the brief, nothing else sets it: every shell call sets `workdir` to the worktree's absolute path, every patch names absolute paths under it |
| `git`, `gh`, lead scripts | run as usual | the sandbox has no network and keeps a worktree's gitdir read-only; `.codex/rules/proteus.rules` lets a command out only when every segment matches a rule (`git <subcommand>` for the writing ones, `gh`, `node <root>/.codex/hooks/<script>` by the main checkout's absolute path, as the rules file spells it; a relative path stays sandboxed). Plain words joined by `&&`, `\|\|`, `;`, `\|` are checked one by one; `$(…)`, `$var`, a redirect, or one unmatched segment (`cd`, `tail`, `sleep`) keeps the whole command sandboxed. So set the directory with `workdir`, never `cd <dir> && git …` or `git -C` (they fail on `index.lock`), and do not pipe `gh` into a filter: use its `-q` |
| Wait for a review verdict | the background poll in `tracker.md` | no `--wait`: one `node <root>/.codex/hooks/proteus-verdict.js <n>`; no verdict → end the turn with the review url and "type `reviewed` here once the verdict is posted". Unattended: `wait_agent` on the guide's `AUTO-` verdict |
| Edit a file | `Edit`, `Write` | `apply_patch`; one unowned path denies the whole patch (lead's hooks, subagents included) |
| Read a file or image | `Read` | the shell, `view_image`; the guard refuses `view_image` like `Read` of an image |
| Shell | `Bash`, `run_in_background` | `exec_command` returns after `yield_time_ms` (at most 30 s) with a session id; `write_stdin` with empty input polls it. A command left running past the turn is the background shell the long-jobs rule forbids |
| Ask the human (the run cannot move) | `AskUserQuestion`, pinned picker | plain numbered questions in chat, one to four, numbered options, recommendation first and marked; wait for the reply |
| Notify | `PushNotification` | none; the chat line and the question or review issue are the notice |
| Status line | `proteus: N questions · M reviews` | `inbox=<q>q/<r>r` in `proteus-state` |
| Gate cache | `proteus-gates-cache.js` stores a pass in `<git-common-dir>/proteus/gates/` | read-only inside the sandbox; passes recorded outside still count. Not in `proteus.rules`: it runs any command |
| Auto mode classifier | denials per `SKILL.md`; `install.js --doctor` suggests an `autoMode.environment` entry (docs/install.md) | none |
| Hooks that cannot fire | – | failed-tool and teammate-idle; the long-jobs rule is prompt-only |
| Model ladder | default `haiku < sonnet < opus < fable`, floor Sonnet, Fable once per project (Mythos counts as Fable) | none: `models=unknown`, every spawn names your own model, until `models.ladder` in `~/.claude/proteus.json` or a `models:` line in `AGENTS.md` names the rungs |
| Effort per role tier | not per spawn: the judge agents (verifiers, scout) carry `effort: high` in their frontmatter, the rest run at the session's effort | `spawn_agent` takes `reasoning_effort`: `judge` high, `build` medium, `helper` low on your own model (`models=…,judge:<model>@high,…`) |
| Container workers | `flow.md` §4 | none yet: `isolation=container-unready` |
| Goal-loop schedule | `/schedule` | none: the human runs each round |
| Cost at close | `npx ccusage@20.0.26 session --json` | `npx @ccusage/codex@19.0.0 session --json` |
| AI commit trailer | off via `attribution` in `~/.claude/settings.json` (`commits.md`) | no setting (a ChatGPT account option may add one); the commit-msg hook is the gate |
| Review from the phone | `/remote-control` | none; the GitHub app |
