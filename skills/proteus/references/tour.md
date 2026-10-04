# Tour

Read only when the human types `tour` (or `/proteus tour`, `$proteus tour` on Codex), or answers yes to the offer. Two modes: `new` walks the whole of Proteus, `whats-new` covers what changed since the human's last tour. `tour=whats-new:N` in `proteus-state`, or `tour whats-new` with a `toured` commit in `~/.claude/proteus.json`, picks the second; everything else is `new`. `tour off` or `skip tour`: run the done command below, say "Tour off; type `tour` any time.", and go back to the work order.

The checkout is `proteus-src` in `proteus-state`; with no state line (typed `/proteus` outside a Proteus repo), it is `home` in `~/.claude/proteus.json`.

## How to run it

- One stop per message. Each stop is at most six short lines in plain words, no file dumps, then one `AskUserQuestion` (Codex: the same three as a numbered line): `Next` (recommended), `Skip to the end`, `Stop here`. The free-text answer is the human's question.
- A question: answer it in at most six lines, from the reference that covers it (read that file now if it is not in context; never answer from memory). Then ask the same picker again. A question outside proteus: answer briefly, then continue.
- An open run keeps going: workers do not pause for the tour, and a worker report or a pinned question the run waits on comes first; resume the tour after it.
- Nothing here is an action. The tour runs no ticket, writes no file, and changes no setting; the human asking for one ends the tour and becomes the work order.
- End, whichever way (`Skip to the end`, `Stop here`, last stop): `node <proteus-src>/install.js --tour-done`, then one line: "Tour done; type `tour` any time to see it again." The offer then stays off until a new feature lands.

## new

1. **What it is.** You hand over work bigger than one agent should do alone. The lead (this session) only decides and writes briefs; workers on your model or cheaper ones deliver in their own git worktrees, never above it; a verifier gates every merge; you gate every milestone. Agents never chat; they share tickets and reports on GitHub.
2. **Your part.** Give a work order in plain words. Before any spec the lead needs six things: the outcome you will see, how you check it is done, what is out of scope, the areas touched, constraints, and no open question. Any blank → it asks you, one question at a time, as a picker. At bootstrap you also approve the team roster and answer a short conventions interview once; that file (`CONVENTIONS.md`) is yours.
3. **Reviews.** Each milestone ends in a `Review:` issue: what changed, steps to check it in under ten minutes, the likeliest mistakes, evidence. Review in a second terminal with `PROTEUS=0 claude` then `/proteus-review` (Codex: `PROTEUS=0 codex`, `$proteus-review`), or on GitHub by commenting `ACCEPT` or `CHANGES` plus one line per problem. Merging into `main` is always yours.
4. **While it runs.** Type `status` (where the run is), `questions` (answer waiting questions), `pause` and `resume`, `revision` (fast rounds of small tweaks). "Remember this" turns a correction into a lesson so it never recurs. The status line shows `proteus: N questions · M reviews` when something waits on you (Codex has none: the session opens with the count). Going to sleep? Say so; it continues only on the reply `UNATTENDED`.
5. **Where things live.** Tickets, milestones, the run log, verdicts: GitHub. The repo gets only deliverables, checks, `teams/`, `CONTEXT.md`, `CONVENTIONS.md`, `AGENTS.md`, ADRs and `docs/lessons/`. Temp files and worktrees are cleaned up per ticket.
6. **Staying current.** `node <proteus-src>/install.js --update` moves to the newest signed release and reinstalls; `--auto-update` does it at session start. With auto-update off, the status line says `proteus: update ready` when there is one. `--doctor` checks the install, `--doctor --fix` repairs it. Then: "Ready when you are: give me a small, real piece of work with two or three independent parts."

## whats-new

1. Spawn one `mid` subagent: "In `<proteus-src>`, read `git log --reverse --format='%h %s%n%b' <toured>..HEAD` and `git diff <toured>..HEAD -- README.md skills/`. Return at most eight lines, one per change a user of Proteus would notice (new command, new behaviour, something removed or renamed, a step that now asks them something), each in plain words with what they do differently. Nothing internal." `<toured>` is `toured` in `~/.claude/proteus.json`.
2. Stop one: "Proteus changed since your last tour:" and the lines. Stop two, only if the human picks a line to go into: that change in six lines, from the reference it touched. Then end.
