# Proteus

Proteus is a Claude Code skill that ships a large project with a team of agents.
It works for software, video or audio editing, 3D, writing, research, and business plans.
A lead plans and decides. Workers build in parallel. A verifier checks every ticket before it merges.
You approve each milestone, and you merge the finished work.
Tickets, reviews and the run log live on GitHub, so nothing is lost when a session ends.

## What a run looks like

1. Open Claude Code in your repo and say what you want.
2. The lead asks questions until the goal is clear.
3. It writes a spec and splits it into tickets, grouped into milestones.
4. Workers build the tickets in parallel, each in its own git worktree.
5. A verifier checks each ticket. Only then does it merge.
6. At each milestone you get a short review brief. Reply `ACCEPT` or `CHANGES`.
7. When the run is done, you merge it into `main`.

New to it? Type `tour` in the lead session for a short walkthrough.

## Prerequisites

- [Claude Code](https://code.claude.com/docs/en/overview), installed and logged in.
- Node.js 22.5 or newer.
- The [GitHub CLI](https://cli.github.com/), logged in (`gh auth login`).
- A repo with a GitHub remote.
- The mattpocock-skills plugin. Inside Claude Code:

  ```
  /plugin install mattpocock-skills@claude-plugins-official
  ```

- Agent teams turned on: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` ([how](docs/install.md#agent-teams)).

## Install

Install the plugin, pinned to a release:

```bash
claude plugin marketplace add Yousef-Baidas/proteus#v2.1.0
claude plugin install proteus@proteus
```

Then open Claude Code in your repo and run:

```
/proteus:setup
```

Commit `.claude/settings.json` and `teams/`.
Start a new session. It begins as the lead.

## Moving from 1.x

1. Install the plugin as shown above.
2. In each repo, run `/proteus:setup --dry-run` to see what it will remove.
3. Run `/proteus:setup`. It removes the old copies you did not edit.
4. Delete or move what it names as edited or tracked.
5. Once every repo is moved, run the `--remove-user-install` command setup prints.

Details: [docs/migrating.md](docs/migrating.md).

## Updating

To move to a newer release, here `v2.0.1`:

```bash
claude plugin marketplace remove proteus --scope user && claude plugin marketplace add Yousef-Baidas/proteus#v2.0.1 && claude plugin install proteus@proteus && claude plugin update proteus@proteus
```

Each session start tells you when you are not on a verified release.
Details: [docs/updating.md](docs/updating.md).

## Codex CLI, or Claude Code without the plugin

Use the installer:

```bash
git clone https://github.com/Yousef-Baidas/proteus.git ~/proteus
node ~/proteus/install.js              # skills + agents for every repo, and the optional context-mode plugin
cd /path/to/your/repo
node ~/proteus/install.js --project    # teams/, ROUTING.md, the lead's hooks and status line
```

For Codex, add `--harness codex` to both `install.js` commands.
Update with `node ~/proteus/install.js --update`.
Check the setup with `node ~/proteus/install.js --doctor`.
Details: [docs/install.md](docs/install.md).

## Optional extras

- [context-mode](https://github.com/mksglu/context-mode): keeps large output out of the agents' context.
- [caveman](https://github.com/JuliusBrussee/caveman): terse agent output.
- [ponytail](https://github.com/DietrichGebert/ponytail): minimal code on small tickets.
- [rtk](https://github.com/rtk-ai/rtk): compressed shell output.
- A Claude Code LSP plugin: `/plugin install <language>-lsp@claude-plugins-official`.
- [graphify](https://github.com/safishamsi/graphify): orientation while planning.
- A separate GitHub login for the agents: `install.js --agent-login` ([docs/github.md](docs/github.md)).
- Run-branch protection: `install.js --protect` ([docs/github.md](docs/github.md)).
- A verifier GitHub App, so only verifiers can sign off: `install.js --verifier-app` ([docs/github.md](docs/github.md)).
- An auto mode entry, so Claude Code's classifier knows Proteus ([docs/install.md](docs/install.md#auto-mode-claude-code)).
- Auto-update for installer users: `install.js --auto-update` ([docs/updating.md](docs/updating.md)).

## Learn more

- [How Proteus works](docs/how-it-works.md): teams, models, questions, reviews, commands, layout.
- [Installing](docs/install.md): prerequisites, installer, guest mode, agent patches, Windows, Codex, auto mode, uninstall.
- [GitHub](docs/github.md): agent login, verifier App, CI and the other enforcement.
- [Updating](docs/updating.md): pins, the release check, signed tags, auto-update.
- [Migrating](docs/migrating.md): from 1.x and from hivemind.
- [Costs](docs/costs.md): context tokens and how they were measured.
- [Harnesses](docs/harnesses.md): other coding CLIs.

## License

MIT
