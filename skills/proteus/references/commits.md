# Commits

Every Proteus agent commits the same way. Terse, exact, professional. The diff says what; the message says why.

## Subject

- `<type>(<scope>): <imperative summary>` — scope optional
- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`, `revert`
- Imperative: "add", "fix", "remove". Not "added", "adds", "adding"
- 50 chars target, 72 hard cap. No trailing period
- Match the repo's capitalisation convention after the colon

## Body

- Omit when the subject is self-explanatory
- Include only for: non-obvious why, breaking changes, migration notes, linked issues
- Wrap at 72. Bullets use `-`
- Issue refs last: `Closes #42`, `Refs #17`
- A body is required for: breaking changes, security fixes, data migrations, reverts

## Leave out

- `Co-Authored-By`, `Generated with`, `Assisted-by`, session links, or any AI attribution. Not as a trailer, not in the body. If the harness offers to append one, leave it out, unless the repo's `CONVENTIONS.md` has the line `attribution: allow` (see Enforcement). The commit-msg hook checks the trailer block (the last paragraph): an AI `Co-Authored-By`, `Assisted-by`, `Generated-by` or `Signed-off-by`, a `Generated with [` line, or a robot emoji. A human's name in those trailers, and body prose that mentions the words, pass.
- "This commit", "I", "we", "now", "currently"
- Emoji, unless the repo convention requires it
- Restating the file name when the scope already names it

## Examples

```
feat(api): add GET /users/:id/profile

Mobile client needs profile data without the full user payload.

Closes #128
```

```
fix(auth): use <= on token expiry check
```

```
feat(api)!: rename /v1/orders to /v1/checkout

BREAKING CHANGE: clients on /v1/orders must migrate before 2026-06-01.
Old route returns 410 after that date.
```

## Enforcement

Claude Code: set this once in `~/.claude/settings.json` so the harness stops offering the trailer at all (Codex has no such setting; the commit-msg hook is the gate):

```json
{
  "attribution": { "commit": "", "pr": "", "sessionUrl": false }
}
```

A repo whose own rules require the trailer opts in with the line `attribution: allow` in its `CONVENTIONS.md`: the hook then lets AI trailers through, in local commits and in CI. Its agents still need Claude Code to add the trailer there, so set `attribution` in that repo's `.claude/settings.json` (project settings override `~/.claude/settings.json`). To keep your own machine-wide attribution setting, put `"attribution": "keep"` in `~/.claude/proteus.json`; install, update and `--doctor` then leave it alone.
