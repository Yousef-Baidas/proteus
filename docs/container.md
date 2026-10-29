# Container runner

`proteus-container.js` runs one Claude Code worker session in a container that never sees the host's `.git` (#80).
Inside, the worker can run with `bypassPermissions`: nothing it writes outside the owned paths comes back, and no git config, hooks or agent config dirs (`.claude`, `.codex`, `.agents`).

## What it isolates

- In: the host bundles the worktree's branch (`git bundle`). The container gets that bundle and the prompt, read-only, plus an empty `/out`. It gets no other host path: no `.git`, no worktree, no `~/.claude`.
- Inside: every capability dropped, `no-new-privileges`, a read-only root, tmpfs `/tmp`, `/work` and home, the image's `node` user (`--userns keep-id` on podman), and pids, memory and cpu caps.
- Credential: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token` prints one) or `ANTHROPIC_API_KEY`, from the lead's env, passed by name (`-e NAME`), so the value is never in argv. No GitHub token: `GH_TOKEN` and `GITHUB_TOKEN` are dropped before the runtime starts. The host pushes.
- Out: the entrypoint commits leftovers as `wip: uncommitted worker changes` and bundles the branch to `/out`. The host reads only that bundle, with its pinned git (no hooks, fsmonitor or user config). It verifies the bundle and fetches one fixed refspec, with no tags, into `refs/proteus-container/<id>`.
- The import is refused when the result does not descend from the old tip, or changes a path outside the worktree's `.claude/proteus-owned`. A `.git*` path such as `.gitattributes`, or a `.claude`, `.codex` or `.agents` dir, at any depth and even inside an owned path, also needs an owned entry that names it (`src/.claude/**`; `.github/` does not cover `.github/x/.gitattributes`). The owned list is read once, before the run; a missing or unreadable one is refused.
- Otherwise `update-ref` moves the branch. A clean worktree's files follow with `read-tree -m -u`. A dirty one is left alone, and the command is printed.
- The clone's config and hooks never leave the container: a bundle carries commits only.
- Commit checks: the host copies the worktree's pre-commit (owned check, tier check) and commit-msg hooks, the scripts they call and the owned list into the read-only `/in/hooks`. The clone's `core.hooksPath` points there, and its `.claude/proteus-owned` copy is in `.git/info/exclude`, so it is never committed.

## Model, agent and publish

- `--model <id>` is passed as `claude -p --model <id>`.
- `--agent <name>` reads `<name>.md` from the project's `.claude/agents`, then `~/.claude/agents`, then the plugin's `agents`. Its body is passed with `--append-system-prompt`, its `disallowedTools` with `--disallowedTools`; its `model:` is ignored. An unknown name dies before the container starts.
- `--ticket <n> --base <branch>` (with `--model`) turns on publish. The session gets `PROTEUS_REPORT=/out/report.md` and a line telling the worker to write its report there, first line `<STATUS> #<n> ...`, since it has no GitHub access.
- After a clean import the host reads the report: a regular file, not a link, at most 64 KiB, UTF-8. A report that fails, or whose first line is not `DONE`, `BLOCKED`, `RED`, `NEEDS` or `CONTRACT-UNCLEAR` `#<n>`, is replaced by `RED #<n> container: no valid report` and a quoted excerpt.
- New commits are pushed with `git push origin refs/heads/<branch>:refs/heads/<branch>`. On `DONE` with no open PR for the branch, it opens one into `--base`, titled from the ticket. The body's `Owned:` and `Tier:` lines come from the owned list read before the run, never from the report; the report's own such lines are escaped. The report is posted on the ticket through `proteus-gh.js`.
- The last stdout line is `<STATUS> #<n> sent` (exit 0) or `RED #<n> container: <reason>` (exit 1).

## Setup

```bash
node .claude/hooks/proteus-container.js build      # node:22-slim + git + Claude Code, user node
node .claude/hooks/proteus-container.js doctor     # runtime, rootless, image, credential
export CLAUDE_CODE_OAUTH_TOKEN=...                 # or ANTHROPIC_API_KEY
node .claude/hooks/proteus-container.js run --worktree .worktrees/<id> --prompt-file <file>
```

- The runtime is podman when found (rootless), else docker; `--runtime` picks one.
- Options: `--model`, `--agent`, `--ticket` with `--base`, `--image`, `--memory 4g`, `--cpus 2`, `--pids 512`, `--network <name>`, `--timeout <min>` (default 60; the container is killed then).
- A project that needs a toolchain builds its own image `FROM proteus-worker` and passes `--image`.
- Without a runtime, run the worker without the container, in its worktree as usual.
- `result.json` (Claude's JSON output) and `status.json` stay in `<git-common-dir>/proteus/scratch/container-<id>/out`. The bundles are removed.
- Exit 0: imported, or nothing to import (and published, with `--ticket`). Exit 1: refused or failed, with the reason on stderr. Exit 2: usage.

## Using it in a run

- Opt in with a line in `AGENTS.md`: `isolation: container`. The lead then runs each worker through `proteus-container.js run` instead of the Agent tool; verifiers stay Agent spawns.
- Credential: `claude setup-token` prints a long-lived token; export it as `CLAUDE_CODE_OAUTH_TOKEN` in the shell that starts the lead.
- At session start the autostart runs `node .claude/hooks/proteus-container.js doctor` (the `--sandbox` bin copy when there is one). `proteus-state` then shows `isolation=container`, or `isolation=container-unready` with the failed row, and the lead dispatches no worker until it passes.

## Residuals

- No egress allowlist: the network is open unless `--network` is given.
- Docker rootful means a container escape is root on the host. Prefer podman or rootless Docker; `doctor` warns.
- The credential is visible to the agent inside the container.
- A bundle-size or pack bomb is bounded only by the timeout.
