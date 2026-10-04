# AGENTS.md

Proteus source repo. Read `CONTEXT.md` for terms and `CONVENTIONS.md` for rules before touching code.

## Agent skills

- Issue tracker: GitHub Issues on `Yousef-Baidas/proteus` via `gh`; PRs are not a request surface.
- Domain docs: single context, `CONTEXT.md` at the root, ADRs in `docs/adr/`. Read both before designing; add a term to `CONTEXT.md` when you name a new concept.
- Triage labels: none (the `triage` skill is not installed).

## Learned

- domain: code (Node CLI installer + hooks + markdown skills); zero dependencies.
- tracker: github (`Yousef-Baidas/proteus`); labels: created (profile labels added with the roster).
- gate: `npm ci && npm run lint && node tests/run.js` (exit code); CI `gates` in `.github/workflows/ci.yml` runs the same plus the commit-msg check.
- package manager: npm, dev-only (`oxlint`, `@oxlint/plugins`); nothing shipped needs `node_modules`.
- test layout: `tests/*.test.js`, plain Node, fake CLIs in `tests/`.
- hotspot files: `install.js`, `install.ps1`, `install.sh`, `templates/hooks/proteus-harness.js`, `templates/hooks/proteus-lib.js`, `tests/hooks.test.js`, `README.md`.
- self-host: `install.js --project` sets Proteus up on this checkout (#4, `tests/selfhost.test.js`); `teams/templates/` stays git-excluded, `templates/` is the source.
- Work to CONVENTIONS.md. Verifier fails the ticket on a deviation.
