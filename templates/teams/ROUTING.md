# Routing

One row per deliverable type or path pattern → the one team that owns it. The lead routes every ticket by this table; a ticket with no row is a question for the human, and the answer becomes a row. Edit the patterns to this repo's layout at bootstrap. `security` and `qa` are never routed to; they verify.

| Deliverable or path | Team |
|---|---|
| UI components, pages, styles, client state, `src/app/**`, `src/components/**`, `apps/web/**` | frontend |
| API routes, handlers, data models, migrations, auth, jobs, `src/server/**`, `apps/server/**`, `packages/db/**` | backend |
| CI workflows, containers, deploy and environment config, `.github/**`, `Dockerfile`, `infra/**` | devops |
| tests for a path | the team that owns the path |
| docs for a path | the team that owns the path |
| root docs (`CLAUDE.md`, `AGENTS.md`), docs-diet tickets | devops |

## Tiers

The tier decides which pipeline steps a change runs (`SKILL.md` rule 3). One rule per line: `<glob> <tier> [lines=<n>] [files=<n>]`, tier `direct`, `quick`, `standard` or `full`. A changed path takes the first rule whose glob matches (owned-path globs; a leading `**/` also matches at the root), else `standard`; the change runs at the highest tier its paths take, and a rule whose paths together pass its `lines=` or `files=` limit costs one tier more. Match by path, never by extension: in a skill or docs-site repo the markdown is the product, and API specs, tested examples and `CONVENTIONS.md` are not typos. Edit the patterns to this repo's layout at bootstrap; delete the block and every change is `standard`.

```tiers
CONVENTIONS.md          full
teams/**                full
.github/**              full
**/migrations/**        full
**/auth/**              full
**/package-lock.json    full
**/pnpm-lock.yaml       full
**/yarn.lock            full
**/uv.lock              full
**/Cargo.lock           full
docs/api/**             standard
docs/**                 direct  lines=60 files=6
README.md               direct  lines=30 files=1
CHANGELOG.md            direct  lines=30 files=1
# small single-team code changes, once CI's gates cover them:
# src/**                quick   lines=80 files=3
```
