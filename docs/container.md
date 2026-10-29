# Container runner

`proteus-container.js` runs one Claude Code worker session in a container that never sees the host's `.git` (#80).
Inside, the worker can run with `bypassPermissions`: nothing it writes outside the owned paths comes back, and no git config, hooks or agent config dirs (`.claude`, `.codex`, `.agents`).

## What it isolates

- In: the host bundles the worktree's branch (`git bundle`). The container gets that bundle and the prompt, read-only, plus an empty `/out`. It gets no other host path: no `.git`, no worktree, no `~/.claude`.
- Inside: every capability dropped, `no-new-privileges`, a read-only root, tmpfs `/tmp`, `/work` and home, the image's `node` user (`--userns keep-id` on podman), and pids, memory and cpu caps.
- Credential: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, passed by name (`-e NAME`), so the value is never in argv. No GitHub token: `GH_TOKEN` and `GITHUB_TOKEN` are dropped before the runtime starts. The host pushes.
- Out: the entrypoint commits leftovers as `wip: uncommitted worker changes` and bundles the branch to `/out`. The host reads only that bundle, with its pinned git (no hooks, fsmonitor or user config). It verifies the bundle and fetches one fixed refspec, with no tags, into `refs/proteus-container/<id>`.
- The import is refused when the result does not descend from the old tip, or changes a path outside the worktree's `.claude/proteus-owned`. A `.git*` path such as `.gitattributes`, or a `.claude`, `.codex` or `.agents` dir, at any depth and even inside an owned path, also needs an owned entry that names it (`src/.claude/**`; `.github/` does not cover `.github/x/.gitattributes`). The owned list is read once, before the run; a missing or unreadable one is refused.
- Otherwise `update-ref` moves the branch. A clean worktree's files follow with `read-tree -m -u`. A dirty one is left alone, and the command is printed.
- The clone's config and hooks never leave the container: a bundle carries commits only.

## Setup

```bash
node .claude/hooks/proteus-container.js build      # node:22-slim + git + Claude Code, user node
node .claude/hooks/proteus-container.js doctor     # runtime, rootless, image, credential
export CLAUDE_CODE_OAUTH_TOKEN=...                 # or ANTHROPIC_API_KEY
node .claude/hooks/proteus-container.js run --worktree .worktrees/<id> --prompt-file <file>
```

- The runtime is podman when found (rootless), else docker; `--runtime` picks one.
- Options: `--image`, `--memory 4g`, `--cpus 2`, `--pids 512`, `--network <name>`, `--timeout <min>` (default 60; the container is killed then).
- A project that needs a toolchain builds its own image `FROM proteus-worker` and passes `--image`.
- Without a runtime, run the worker without the container, in its worktree as usual.
- `result.json` (Claude's JSON output) and `status.json` stay in `<git-common-dir>/proteus/scratch/container-<id>/out`. The bundles are removed.
- Exit 0: imported, or nothing to import. Exit 1: refused or failed, with the reason on stderr. Exit 2: usage.

## Using it in a run

- Opt in with a line in `AGENTS.md`: `isolation: container`. The lead then runs each worker through `proteus-container.js run` instead of the Agent tool; verifiers stay Agent spawns.
- Credential: `claude setup-token` prints a long-lived token; export it as `CLAUDE_CODE_OAUTH_TOKEN` in the shell that starts the lead.
- At session start the autostart runs `node .claude/hooks/proteus-container.js doctor` (the `--sandbox` bin copy when there is one). `proteus-state` then shows `isolation=container`, or `isolation=container-unready` with the failed row, and the lead dispatches no worker until it passes.

## Residuals

- No egress allowlist: the network is open unless `--network` is given.
- Docker rootful means a container escape is root on the host. Prefer podman or rootless Docker; `doctor` warns.
- The credential is visible to the agent inside the container.
- A bundle-size or pack bomb is bounded only by the timeout.
- Not yet: the lead integration, the verifier in the same container, and a concurrency cap come in later PRs.
