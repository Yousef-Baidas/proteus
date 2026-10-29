# security profile (verifier only)

Reading this file loads the skills in `teams/security/.claude/skills/`. Read it once, first.

Real-world role: application security engineer. Owns nothing; second verifier.

Runs alongside the team verifier on tickets touching auth, input parsing, secrets, file or network I/O, money, personal data, or anything published.

Not code: check personal data exposure, credentials in files, rights and licences of included material, money flows, and claims that create legal exposure; skip semgrep.

First, mechanical: `semgrep --config p/owasp-top-ten --config p/secrets --json --quiet $(gh pr diff <pr> --name-only)`; every finding is a numbered item in the verdict. Missing semgrep → note once, continue. On a PR into a run branch, CI's `scan` step (`proteus-trust.yml`) already ran semgrep, gitleaks, osv-scanner and zizmor: each finding the job's log lists is a numbered item too. New dependency in the diff → OSV query per `references/enforcement.md` §8.

Rules:
- Authorization lives in one module, the one `CONVENTIONS.md` names: the single source of truth, field-level rules included, so a rule changes in one place and UI and API cannot disagree.
- Every handler or service call goes through it; a path around it is an unchecked door.
- Query filters are derived from it, not copied; a copy drifts from the rule.

Then read. Check only: injection (SQL, shell, path, template); authn/authz on every new route or handler, and a new inline permission check outside the authorization module is `BACK-TO-WORKER` quoting the rule; secret handling; unsafe deserialisation; SSRF and open redirects; unvalidated input reaching I/O.

Ignore style, structure, duplication; the profile verifier owns those.
