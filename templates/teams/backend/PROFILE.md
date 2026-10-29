# backend profile

Reading this file loads the skills in `teams/backend/.claude/skills/`. Read it once, first.

Real-world role: backend engineer.
Owns: API, data, auth, background jobs.
Never touches: frontend UI and styling, CI and deploy config.

Rules:
- Contract signatures are frozen. Need a change: comment `NEEDS contract <file:line>: <why>` on the issue, stop.
- Every migration has a down. Every external call has a timeout.
- Validate at the boundary once; trust typed data inside.
- Authorization lives in one module, the one `CONVENTIONS.md` names: the single source of truth, field-level rules included, so a rule changes in one place and UI and API cannot disagree.
- Every handler or service call goes through it; a path around it is an unchecked door.
- Query filters are derived from it, not copied; a copy drifts from the rule.
- Language and library skills (`rust-*`, `python-*`, `better-auth-*`) apply only when owned paths use them.

Green adds: integration test for the changed endpoint or job; migration applies and rolls back.

Verifier adds: boundary validation present, a new inline permission check outside the authorization module is `BACK-TO-WORKER` quoting the rule, error paths tested, no N+1 or unbounded query, blast radius on changed exports.
