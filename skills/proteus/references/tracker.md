# Tracker

Proteus keeps no state in the repo. Tickets, milestones, the run log, maps, worker reports, verdicts, debt, review briefs, and the review queue live in the tracker. The repo gets deliverables, checks, contracts, lessons, ADRs, and the three docs a human would want anyway: `CONTEXT.md`, `CONVENTIONS.md`, `AGENTS.md`. Nothing else. `teams/` is config, shared like lint config. Agent memory is `local` (git-ignored); hook state is under `.git/proteus/`, never committed.

The lead's task list (Claude Code's Agent Teams list; on Codex the agents it spawned) is a runtime mirror; if it and the tracker disagree, the tracker wins. A session that dies loses nothing.

Tracker today: **GitHub** via `gh`. Jira and others slot in by filling the second column; the operations do not change.

## Operations

| Operation | GitHub |
|---|---|
| preflight | `gh auth status` and `gh repo view --json nameWithOwner -q .nameWithOwner`; either fails → stop, tell the human |
| labels (once) | `gh label create proteus`, `proteus-log`, `proteus-review`, `proteus-debt`, `proteus-question`, `needs-human`, `needs-research`, `speculative`, `difficulty:standard|hard`, and `profile:<team>` for every team in `teams/ROUTING.md` (`--force`, ignore exists), then record `labels: created` and `labels: proteus` under `## Learned`; a team added later gets its label then, and a repo labelled before `speculative` existed gets it on first use. `labels: created` without `labels: proteus` means hivemind made the labels under its old names: create these, leave the old ones on the issues they already mark (a run opened before the rename keeps them until it closes), then add `labels: proteus` |
| run log | one per run: `gh issue create --title "Run: <run>" --label proteus-log --body "lead's decision log"`; one comment per step or wave, a line per decision that lives nowhere else (grilled decisions pre-spec, each milestone's `ACCEPTANCE` checks, `UNATTENDED` grant, allowed deviations, parked `NEEDS`, fork point, human hand edits, pause positions, revision mode start and end). The autostart prints its tail at startup and after a compaction. Closed at step 8 |
| debt | one per milestone, opened with the milestone: `gh issue create --title "Debt: <run>/<m>" --label proteus-debt --milestone "<run>/<m>" --body "verifier follow-ups; each line fixed, re-scoped, or dropped by the human at close"`. Each verifier adds one comment per ticket holding all its non-blocking findings, one line each: `#<ticket> <file:line or part> <what> — <why it can wait>`. Never a ticket per follow-up |
| map | `/wayfinder` writes its map as an issue labelled `wayfinder:map`; the repo gets no map file |
| milestone | `gh api repos/{owner}/{repo}/milestones -f title="<run>/<milestone>"` |
| ticket | `gh issue create --title "<id>: <intent line>" --label proteus,profile:<team>,difficulty:<d> --milestone "<run>/<m>" --body-file -` (body: intent, interface, the check as name + input + expected result, owned paths, depends-on; `needs-research` label when it rests on outside facts) |
| protect branch (per run) | after `git push -u origin proteus/<run>`: `gh api "repos/{owner}/{repo}/rules/branches/proteus%2F<run>"` shows the human's ruleset → done; else `gh api -X PUT "repos/{owner}/{repo}/branches/proteus%2F<run>/protection" --input -` with the JSON in `enforcement.md` §1. 403 or 404 → the human runs `install.js --protect`, or `protection: none` in `## Learned`; continue |
| quick ticket | the ticket above without `--milestone`; its PR from `proteus-work/quick/<n>` into `main` carries `Owned:` and `Tier: quick` lines; no debt or review issue; the human merges (`SKILL.md` rule 3) |
| direct batch | no issue: one PR from `proteus-work/direct/<batch>` into `main`, its body the digest (one line per change, then `Owned:`); while it is open, later Direct changes join it; the human merges |
| ticket url → worker | the issue number is the ticket id; the worker gets the number, not the body pasted |
| worker report | `gh issue comment <n> --body "DONE …"` / `NEEDS …` / `RED …` + diff and failing output |
| CI status | `gh pr checks <pr> --json name,state`; verifier reads it, re-runs only to reproduce a finding |
| verifier verdict | worker branch has a PR into `proteus/<run>`: `gh pr review <pr> --comment --body "MERGE"` or `--request-changes --body "BACK-TO-WORKER …"` (`--approve` is refused on your own PR); `CONTRACT-WRONG` → comment on the issue, close PR |
| merge | `git worktree remove <wt>` first, then `gh pr merge <pr> --merge --delete-branch` into `proteus/<run>`, full suite on `proteus/<run>`; `gh issue close <n>` |
| review brief | `gh issue create --title "Review: <run>/<milestone>" --label proteus-review,needs-human --milestone … --body-file <brief>` |
| evidence | text transcripts inline in the brief. Screenshots and recordings go on branch `proteus-evidence/<run>`: first milestone `git checkout --orphan`, later ones `git fetch origin proteus-evidence/<run> && git checkout FETCH_HEAD`; add files, commit, `git push origin HEAD:refs/heads/proteus-evidence/<run>`; link raw URLs; branch deleted at close |
| verdict | a comment on the review issue by the human's login whose first line is `ACCEPT` or `CHANGES`; the unattended grader comments `AUTO-ACCEPT` / `AUTO-HOLD`. Read only through `proteus-verdict.js` (under the table) |
| question | `gh issue create --title "Q: <run>: <one line>" --label proteus-question,needs-human --body-file -` (body: the question, numbered options, `Recommended: <n> because …`, parked tickets `#…`, what happens on each option). Answer: a comment by the human's login whose first line is `ANSWER <option or text>`, read with `node <hooks>/proteus-verdict.js <n>`; the lead acts, logs it on the run log, closes the issue. Never edited, never asked twice |
| revision | `gh issue create --title "Revision <run>/<m> r<k>" --label proteus --milestone …`; one comment per tweak, evidence, and human `ok` (`operations.md`) |
| wait for verdict | poll every 30 s with the command under the table |
| accept | remove `needs-human`, close the review issue, close the milestone |
| queue (unattended) | review issues still labelled `needs-human`; `/proteus-review` lists `gh issue list --label needs-human --state open` |
| learned | still `AGENTS.md ## Learned`; that file is for the next human too |
| close run | PR `proteus/<run>` → `main`, body links the milestones; if the run set the protection, the body ends with `gh api -X DELETE "repos/{owner}/{repo}/branches/proteus%2F<run>/protection"` for the human (the guards refuse it to agents); `git push origin --delete proteus-evidence/<run>` after merge |

Verdict poll, background shell; prints the first trusted verdict and exits (Codex runs it without `--wait`: `harnesses.md`):

```
node <hooks>/proteus-verdict.js <n> --wait
```

Trusted means the keyword alone on the first line (`ACCEPTED` is not `ACCEPT`), and the author: `ACCEPT`, `CHANGES` and `ANSWER` count only from the human's login, `AUTO-ACCEPT` and `AUTO-HOLD` from the human's or the agents'. The human's login is `"human"` in `~/.claude/proteus.json`, else the login `gh` is authenticated as. On a public repo anyone can comment; every other author is ignored. Never read a verdict with a raw `gh issue view`.

Every comment, issue and PR write goes through `node <hooks>/proteus-gh.js <gh args>` (`<hooks>` is `.claude/hooks` or `.codex/hooks`) instead of bare `gh`. GitHub's secondary limits allow about 80 content-creating requests a minute and 500 an hour ([docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)); the wrapper retries a refused write after `retry-after`, else after a minute doubling with jitter, up to 5 attempts and 10 minutes of waiting (`PROTEUS_GH_ATTEMPTS`, `PROTEUS_GH_BASE_S`, `PROTEUS_GH_MAX_WAIT_S`), and passes gh's output and exit code through. Batch to stay under the limits: lines in one comment, not one comment per event. Reads stay bare `gh`.

Read tracker output with `--json … -q` always. A raw `gh issue view` costs the lead more than the ticket did.

Every agent posts as the same GitHub account, so a comment is never edited or overwritten: no `gh … --edit-last`, no `gh api -X PATCH` on a comment. A correction is a new comment. The guards refuse `--edit-last`. While that account is also the human's, the verdict script cannot tell an agent's `ACCEPT` from the human's and says `identity=shared` on stderr. So the guards refuse an agent's `gh` comment, PR review or comments API call whose body opens with `ACCEPT`, `CHANGES` or `ANSWER` (inline, heredoc, or `--body-file` under the cwd). That stops a confused or injected agent, not a determined one: a script can still post. Agents posting under a login of their own closes it: after `install.js --agent-login`, every agent shell runs `gh` as that account (`identity=separate` in `proteus-state`) and the verdict script counts only the login recorded as `human`.

## Adding a tracker

Copy this file to `tracker-<name>.md`, fill the second column, and set `tracker: <name>` in `AGENTS.md ## Learned`. The lead reads the matching file at step 0.
