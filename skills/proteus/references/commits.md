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
- Always include a body for: breaking changes, security fixes, data migrations, reverts

## Never

- `Co-Authored-By`, `Generated with`, `Assisted-by`, session links, or any AI attribution. Not as a trailer, not in the body. If the harness offers to append one, leave it out. The commit-msg hook checks the trailer block (the last paragraph): an AI `Co-Authored-By`, `Assisted-by`, `Generated-by` or `Signed-off-by`, a `Generated with [` line, or a robot emoji. A human's name in those trailers, and body prose that mentions the words, pass.
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
