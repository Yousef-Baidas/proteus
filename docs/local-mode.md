# Local mode

Proteus normally keeps a project on a code host: the host holds the code, the tracker and the pull requests, runs the checks, and keeps separate accounts apart. Local mode does without a host. A stand-in for the `gh` command, a bare git repo as `origin`, a tracker and a check runner all live on this machine, inside the repo's git folder. The agents work as usual: the same commands, the same flow.

## Choosing it

Run `/proteus:setup`. It asks once whether the project goes on a code host or stays on this machine, and where a remote exists it recommends the host. If you pick this machine it shows the warning below and asks you to confirm.

Without the plugin:

```bash
node <proteus>/install.js --project --local
```

`--plugin-setup --dry-run --local` prints the warning and changes nothing. Setup makes the stand-in, then, when the repo has commits, pushes the default branch into the new origin. With no commits it prints that step for later, and `--doctor` names it until it is done. A repo whose `origin` points elsewhere is refused, and nothing is written.

Run setup yourself, in your own terminal. Local mode is switched on in a place the sandbox cannot write, so setup run inside the sandbox stops and says so.

## What you give up

This is the warning setup prints, word for word:

> - Everything stays on this machine, inside this repo's git folder. If the machine or that folder is lost, the history and the tracker are lost too; there is no copy anywhere else.
> - There are no hosted checks and no separate accounts. Local hooks and the safety policy are the only enforcement.
> - Agents can reach these records, so they are a working log, not proof.
> - Your approvals are protected from agents only where the sandbox is on.

Setup then says which case applies to this repo right now.

**Back up the repo's git folder yourself.** Nothing else keeps a copy.

The commands that set up a host (`--agent-login`, `--protect`, `--verifier-app`) refuse in local mode and change nothing: there is no host to set up.

## What you see

- The session's state line adds `mode=local`, and `approvals=unprotected` when the repo has no sandbox profile.
- `proteus-status.js` ends its line with `mode local`, and its `--json` carries `"mode": "local"`.
- `install.js --doctor` replaces the host rows with rows for local mode: the origin and its hooks, the `gh` launchers, the first push, the gate commands in `## Learned`, the sandbox, and whether agents' shells find the stand-in. Codex has no way to put the launchers first on agents' PATH, so there the row warns: Proteus's own `gh` calls reach the stand-in, a bare `gh` in an agent's shell does not, until you add the launcher folder to PATH yourself.

Each session start rewrites the launchers and the origin's hooks when the Proteus hooks folder has moved. If that fails you get a notice, and the session carries on.

## Why approvals need the sandbox

Your approvals are stored where the sandbox cannot write. Without the sandbox, an agent's shell runs as you and can write there too, so nothing tells its approval from yours. `install.js --sandbox` writes the profile, before or after `--local`, in either order. With local mode on, the profile lets agents use the tracker and push to the origin, and stops them replacing the launchers, the origin's hooks or its config.

## Local checks

A check runs the default branch's gate commands from `## Learned` on the branch's code. It starts when a pull request is opened or its branch is pushed.

A fresh project has no gate line yet, so its first pull request sets it and changes nothing else: only `AGENTS.md` at the repo root, as a plain file, with the gate line in `## Learned`. That check passes and says no command was run. It is the one case where a branch names gates, and only while the default branch has none: any other file in the diff, a rename, a mode change or a link fails it. Once a gate line reaches the default branch this path is closed, and any other pull request that passed this way stops counting until `--rerun` checks it normally. A person still merges it, under the same rules as any other pull request.

Gate commands run the branch's code, so on a repo with a sandbox profile they run only inside the sandbox. A push or `pr create` from outside it, such as your own terminal, runs nothing and posts a failure naming the rerun. From a sandboxed session:

```bash
gh pr checks <number> --rerun
```

`--rerun` belongs to the stand-in. It starts a check for the current head even if one finished, and it is the only way to repeat one. A repo with no profile runs gates as whoever pushed, which is the protection the warning says is off.

## Moving to a host

`install.js --export <owner/repo>` (`-Export` in `install.ps1`) moves a local-mode repo to a repo on a code host. Nothing starts it for you: no hook, session, agent or setup step runs it, and in the sandbox it stops and says you run it yourself.

Without `--yes` it changes nothing and prints the plan: the target, its visibility, the counts of what would go, and this warning.

Moving this project to a code host means:
- All history and all records go to the host.
- The records were written by agents and are not checked for secrets.
- Everything posts under your account, with the original author and time in the text.
- Human approvals do not carry over.

With `--yes` it carries out that plan. It refuses, with nothing written, when the repo is not in local mode, a run is open, a local check is pending, there is no real `gh` or you are not signed in, you lack write permission on the target, or the target is missing or not empty. It never creates the target, so make it on the host first; that way you choose its visibility. A public target also needs `--public`.

The steps, in order:

1. Push every branch and tag from the bare origin, without force.
2. Create the labels the records use.
3. Post the issues in number order. Closed ones close after their comments.
4. Post the pull requests. An open one whose head and base exist, with something to merge, becomes a real pull request. Merged, closed and unrecreatable ones become closed issues holding the record: title, base, head, final commit and state.
5. Point `origin` at the target, then remove the local-mode marker.

Every exported body and comment opens with a header line naming the original number, author and time. Verdict readers look only at the first line, so no exported text reads as your verdict. Mentions and closing keywords get an invisible character, so exported text notifies no one and closes nothing. The verdict record, auto verdicts and check statuses stay behind. A review goes as a comment with its state in the header, and an issue's milestone as a line of text.

Numbers can differ on the host, and text inside bodies is not rewritten. The map from local to host numbers is `<git-common-dir>/proteus-lead/local-export.json`, written after each step; its path is printed at the end.

A failure, a rate limit included, stops at that item and says which, with local mode still on. Run the same command to resume: the map keeps anything from posting twice, a different target is refused, and so is anything on the target the map does not list. A failure between the last two steps also leaves local mode on, and a rerun finishes it.

The store and the bare origin stay on disk as an archive. The `gh` launchers, still on the path of a running session, now run the real `gh`. Afterwards export prints what is left for you: the host setup commands, a check of the host's default branch, and a fresh verdict on each open pull request.
