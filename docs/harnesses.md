# Harness research (2026-09-29)

Where Proteus could run besides Claude Code, and what an adapter per harness would take. Sources: each harness's own docs and source at the versions below; per-feature tables with source links are in `docs/harnesses/{codex,gemini,local,pi}.md`. Anything marked unconfirmed there is unconfirmed here.

Versions read: Claude Code 2.1.282 docs, Codex CLI rust-v0.159.0, Gemini CLI v0.61.0 stable (main 0.63.0-nightly), Qwen Code v0.24.7, OpenCode v1.18.33, Goose v1.52.0, Pi v0.87.1 (earendil-works/pi), Crush v0.97.1, Aider v0.86.0, Cursor CLI and Amp docs as of the same date.

## What Proteus needs from a harness

| Need | Used for |
|------|----------|
| Blocking pre-tool hook with a reason to the model | lead guard (no edits by the lead, the model ladder, merge gates) |
| Session-start context injection | `proteus-state` line, tour offer, update notice |
| Stop / subagent-stop veto | journal, lessons, "report before you stop" |
| Subagents with a model chosen per spawn | the model ladder |
| Subagents in their own worktree, in parallel | workers |
| Agent definitions in files, with tool limits | workers and verifiers that never edit |
| Structured question tool | the six-blank intake, reviews, the tour |
| Scriptable status line | inbox counts, update notice |
| MCP | context-mode (optional; the fallback is a scratch file and `grep`) |
| Session model visible to hooks | the ladder's `top` |

## Matrix

Legend: yes / part / no. "part" is explained in the notes.

| Need | Claude Code | Codex | Qwen Code | OpenCode | Gemini CLI | Goose | Cursor CLI | Pi |
|------|------|------|------|------|------|------|------| ------ |
| Blocking pre-tool hook | yes | yes | yes | yes (plugin throws) | yes | yes | yes | yes (TS `tool_call`) |
| Session-start injection | yes | yes | yes | part (system transform) | yes | no | part (fire and forget) | yes (`before_agent_start`) |
| Stop veto | yes | yes | yes | no | part (per turn) | yes | yes | yes (`agent_before_settle`) |
| Subagent-stop hook | yes | yes | yes | no | no | no | yes | no (no native subagents) |
| Per-spawn model | yes | yes | unconfirmed (per file: yes) | per file | per file | per file / env | per file | yes (per process `--model`) |
| Worktree per subagent | yes | no | yes | no | no | no | part | no |
| Parallel / background | yes | yes | yes | yes | part | part (autonomous mode only) | yes | part (example extension) |
| Agent files | md | TOML | md | md | md | md | md (reads `.claude/agents`) | md (example extension) |
| Question tool | yes | part (Plan mode) | unconfirmed | yes | yes | no | unconfirmed | yes (`ctx.ui.select`) |
| Scriptable status line | yes | no (fixed items) | yes | no | no (fixed items) | no | unconfirmed | yes (`setStatus`, `setFooter`) |
| MCP | yes | yes | yes | yes | yes | yes | yes | part (unreleased `main` only) |
| Model in hook input | SessionStart, optional | every hook | SessionStart | chat hooks only | no (BeforeModel only) | unconfirmed | unconfirmed | yes (`ctx.model`) |
| Local models | no | yes (Responses API only) | yes | yes | no (Google only) | yes | unconfirmed | yes |
| Reads AGENTS.md | via CLAUDE.md | yes | yes | yes (and CLAUDE.md) | via `context.fileName` | yes | yes | yes (and CLAUDE.md) |

Aider (no hooks, subagents, MCP or AGENTS.md; slow releases), Crush (no real subagents) and Amp (TypeScript plugins only, built-in subagents only) are not targets.

## Notes that change the design

- **Codex** hooks match Claude Code almost field for field, and `spawn_agent` takes `model`. Its default `workspace-write` sandbox makes `.git` (worktree gitdirs included) read-only and turns the network off, so workers cannot commit or call `gh` without `danger-full-access` in a container or exec-policy rules for those prefixes. There is no worktree per subagent, so the lead creates worktrees itself. The question tool only works in Plan mode, and the status line cannot run a script.
- **Qwen Code** is a Gemini CLI fork that took Claude's hook shapes: PreToolUse with `permissionDecision`, Stop and SubagentStop with `decision: "block"`, SessionStart with `model`, `isolation: "worktree"` and `run_in_background` on subagents, a command status line, a co-author setting, and OpenAI-compatible providers. It is the cheapest adapter to write. The one open question is a per-call model on spawn.
- **OpenCode** is the local-model target. It reads `.claude/skills`, `CLAUDE.md` and AGENTS.md as-is, defines agents in markdown with `model` and permission globs, runs subagents in the background, and has a server plus a typed SDK that an external orchestrator can drive, one session per worktree. Hooks are JS plugins: `tool.execute.before` blocks by throwing. It has no stop veto and no subagent hooks, the model is not in tool hooks, and open issue #41422 reports hooks not firing under `opencode run`.
- **Pi** has the strongest hooks of all, in-process TypeScript: `tool_call` blocks with a reason and can rewrite arguments, `before_agent_start` injects context, `agent_before_settle` forces another turn, `session_before_compact` can replace the compaction (so the summariser model is choosable here, unlike Claude Code), and `ctx.ui` gives pickers and a status line. It has no subagents by design: a shipped example extension runs `pi` subprocesses with `model:` in markdown agent files, in parallel, without worktrees. There is no permission system (it runs without approvals by design; gates are extensions) and no attribution setting. MCP is only on unreleased `main`. It is 0.x, so an adapter pins the version. Every hook is a TypeScript rewrite of the shell hooks, which a normalised event format keeps to one thin bridge.
- **Gemini CLI** has good hooks, but a subagent's model is fixed in its file, subagents get no lifecycle hooks and no worktrees, and it runs Google models only. Workers would be separate `gemini -p` processes per worktree. Qwen Code covers the same users better.
- **Claude Code itself:** nothing selects the compaction model (no setting, env var or hook output), and PreCompact can only block. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides the model the guard approved.

## Codex adapter (in progress)

`templates/hooks/proteus-harness-codex.js`, written from the 0.159 source, covered by fixture tests, and smoke-tested live on codex-cli 0.159.0 (2026-09-29, ChatGPT login, `codex exec` in a throwaway repo). Hooks installed in `<repo>/.codex/hooks` select it by their location.

- Hooks: `.codex/hooks.json` with absolute paths (hooks get no project-dir variable and run from the turn's cwd through the login shell). Codex runs a new or changed hook only after the human trusts it in `/hooks`, and only in a trusted project. The trust hash covers the hook entry, not the script, so updating a script does not ask again.
- Edits are `apply_patch` patches that can touch several files; the event carries every path, and one unowned path denies the patch. `apply_patch` run through the shell counts as an edit.
- Subagents run under the lead's hooks with `agent_id` set, so the lead guard enforces owned paths as it does on Claude Code. Codex makes no worktrees; `proteus-worktree.js` already does, and the owned list lives in `.codex/proteus-owned`, which the sandbox keeps read-only for the worker.
- Agents become TOML roles in `$CODEX_HOME/agents` without a `model` key: a role's model overrides the one named on `spawn_agent`, which would defeat the ladder. Roles cannot limit tools, so verifiers are read-only by instruction only.
- `.codex/rules/proteus.rules` lets the git writes, `gh`, and the lead's own scripts run outside the sandbox, since workspace-write keeps a worktree's gitdir read-only and turns the network off. `reset`, `clean` and other rewrites still ask.
- No default ladder: a Codex lead runs single-model (every spawn on the lead's model) until `models.ladder` in `proteus.json` or a `models:` line names the rungs.
- Not enforceable on Codex: background shell calls (the hook sees no yield time), the failed-tool and teammate-idle hooks, the status line.
- Verified live: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop and SubagentStop fire under `codex exec`, and the tool hooks fire inside a subagent with its own `agent_id` and model (lead `gpt-6-astra`, subagent `gpt-6-luna` from `spawn_agent`'s `model`). The guard denied the lead's `apply_patch` and a spawn off the ladder, the autostart context reached the model, the TOML roles loaded as spawnable agent types, and the transcript readers read a real rollout. `git commit` in workspace-write succeeded with the rules file and did not without it.
- Found live: multi-agent v2 names its tools with a namespace prefix and no separator (`collaborationspawn_agent`, `collaborationwait_agent`), serialises no `Agent` alias for them, and sends the spawn `message` encrypted. The adapter treats any name ending in `spawn_agent` as a spawn and the guard's matcher is a regex for the same; only the `model` argument is read. `view_image` takes `path`; patches name absolute paths.
- Not yet run live: the TUI (hook trust in `/hooks`), a worker in a linked worktree, and `apply_patch` through the shell.
- Installer: `install.js --harness codex` links the skills into `~/.agents/skills`, writes the TOML roles, installs the lead hooks and rules, excludes them from git, and prints the one-time steps (trust the project, approve the hooks in `/hooks`, add context-mode). `--doctor --harness codex` checks the same.
- Worker worktrees live in `../<repo>-proteus/`, outside the project, so workspace-write rejects a worker's `apply_patch` there ("writing outside of the project"). `--project` adds that folder to `writable_roots` under `[sandbox_workspace_write]` in the project's `.codex/config.toml` and creates the folder, since bwrap drops a writable root that does not exist. The merge is textual. It refuses a shape it cannot edit safely (dotted keys, an inline table, multi-line strings, a non-string array), and a `.codex` or `config.toml` that is a link, which it never writes through, and says what to add by hand. The file is git-excluded only when the installer created it. The doctor checks the entry. Verified live on 0.159 (the worker then edits and commits). Repos set up before the rename (#5) listed `<repo>-hive`: `--project` and the session start add `<repo>-proteus`, and drop `<repo>-hive` once no worktree of a pre-rename run is registered there.
- The adapter's `skipHooks` keeps the Claude-only files (the status line, the worker's `worktree-settings.local.json`, `commit-msg.js`) out of `.codex/hooks`. The installer removes copies left by an older install, and the doctor flags any that remain.
- The commit-msg gate in `lefthook.yml` and `proteus-gates.yml` runs `teams/templates/hooks/commit-msg.js`. That copy is committed with `teams/` and refreshed by `--project`, so a clean clone has it on either CLI. Existing Claude repos whose gates name `.claude/hooks/commit-msg.js` keep working because that file is committed there. The doctor flags a gate that names a file git does not track.
- Team skills: `link-skills.js` links each skill into both `teams/<p>/.claude/skills` and `teams/<p>/.agents/skills`, and `--project` appends the new ignore pattern to an older `teams/.gitignore`. Codex loads `.agents/skills` only between the repo root and the session cwd, and a spawned worker keeps the lead's cwd. A Codex worker therefore never loads its team's skills on its own: it lists `teams/<p>/.agents/skills/` and reads each fitting `SKILL.md`. `npx skills add` puts the canonical copy in `~/.agents/skills`, which Codex loads for every session, so `--confine` cannot hide team skills from a Codex lead.
- Context-mode is optional. The doctor accepts it as an MCP server (`[mcp_servers.context-mode]`) or as a plugin. For a plugin it needs an enabled `[plugins."context-mode@<marketplace>"]` entry, a cached version under `$CODEX_HOME/plugins/cache/<marketplace>/context-mode/`, and `[features] plugins` left on. Unverified: the marketplace context-mode actually ships under, since any `context-mode@*` matches.
- Still to do: skill prose that names Codex's tools, including how a Codex worker reads its team skills.

## Local models, honestly

The only benchmarks found are from late 2025. Qwen3-32B scores 40% on the Aider polyglot and 48.7 overall on BFCL function calling (47.9 multi-turn), and smaller models are lower. That is well under hosted models. Local models fit as `mid` workers under a hosted lead, which OpenCode's per-agent `model` allows, sooner than as a lead. An all-local run should be sold as possible, not as equal.

## Recommended shape

1. **Split core from adapter.** Done for the hooks (2026-09-29): `templates/hooks/proteus-harness.js` documents the Proteus event and the adapter contract, `proteus-harness-claude.js` is the reference adapter, `proteus-lib.js` holds only what every CLI shares, and all 232 existing tests pass unchanged. Still Claude-specific: `install.js`, `worktree-settings.local.json`, the agent files, and the skill prose that names `Agent`, `Edit` and `Bash`; these move per adapter. The core is everything already portable: the skill prose and references, GitHub tracker state, CI and lefthook gates, `teams/`, AGENTS.md, and the model ladder (already configurable through `models.ladder`). Hook scripts take a normalised event (`{event, session, cwd, model, transcript, tool, input}`) and return a normalised verdict (`allow`, `deny + reason`, `context`, `continue + reason`). Each adapter maps the harness's hook JSON to that and back, installs agent files in the harness's format, and names its spawn call.
2. **Two spawn modes.** In-harness subagents where the harness allows a model per spawn and parallel runs (Claude Code, Codex, probably Qwen). Otherwise one headless process per worker in its own worktree (`codex exec --cd`, `opencode run --dir --model`, `gemini -p`), with the model on the command line. No per-spawn model at all means single-model mode: the ladder collapses to the lead's model.
3. **Graceful gaps.** No question tool: plain numbered questions. No scriptable status line: the inbox line goes into session-start context instead. No stop veto: the journal writes on the last tool call instead.
4. **Order.** Core split with Claude Code as the reference adapter and the current tests passing unchanged; then Codex (best hook parity, per-spawn model); then Qwen Code (close to free once Codex exists); then Pi or OpenCode for local models (both need a JS/TS bridge and process-per-worker; Pi has the better hooks and UI, OpenCode the native subagents and a stable MCP); Gemini CLI only on demand.
5. **Verify before building each adapter:** install the CLI, confirm hooks fire in headless and in subagents, and confirm per-spawn model with a two-agent smoke test. Do not ship an adapter on docs alone.
