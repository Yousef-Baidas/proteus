# Routing

One row per deliverable type or path pattern → the one team that owns it. The lead routes every ticket by this table; a ticket with no row is a question for the human, and the answer becomes a row. Edit the patterns to this repo's layout at bootstrap. `security` and `qa` are not routed to; they verify.

| Deliverable or path | Team |
|---|---|
| UI components, pages, styles, client state, `src/app/**`, `src/components/**`, `apps/web/**` | frontend |
| API routes, handlers, data models, migrations, auth, jobs, `src/server/**`, `apps/server/**`, `packages/db/**` | backend |
| CI workflows, containers, deploy and environment config, `.github/**`, `Dockerfile`, `infra/**` | devops |
| tests for a path | the team that owns the path |
| docs for a path | the team that owns the path |
| root docs (`CLAUDE.md`, `AGENTS.md`), docs-diet tickets | devops |

## Tiers

The tier decides which pipeline steps a change runs (`SKILL.md` rule 3). One rule per line: `<glob> <tier> [lines=<n>] [files=<n>]`, tier `direct`, `quick`, `standard` or `full`. A changed path takes the first rule whose glob matches (owned-path globs; a leading `**/` also matches at the root), else `standard`; the change runs at the highest tier its paths take, and a rule whose paths together pass its `lines=` or `files=` limit costs one tier more. Match by path, not by extension: in a skill or docs-site repo the markdown is the product, and API specs, tested examples and `CONVENTIONS.md` are not typos. Edit the patterns to this repo's layout at bootstrap; delete the block and every change is `standard`.

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

## Security

A PR into the run branch that changes a path one of these globs matches needs the security verifier's signoff: CI (`.github/workflows/proteus-trust.yml`, from the base branch) posts the commit status `proteus/security` as failure naming the paths, and only the security verifier's `MERGE` (`proteus-signoff.js --security`) turns it green; the ruleset on `proteus/*` requires it. One glob per line, matched like the tiers block. Cover auth, input parsing, secrets, file and network I/O, money, personal data, anything published, and CI itself. Edit the patterns to this repo's layout at bootstrap; the lead may still add the security verifier to any ticket. Delete the block and CI checks nothing, the pipeline before the block existed.

```security
**/auth/**
**/*auth*.*
**/session*/**
**/login*.*
**/*token*.*
**/*secret*.*
**/*crypt*.*
**/.env*
**/*parse*.*
**/*upload*.*
**/payment*/**
**/billing/**
**/*payment*.*
**/migrations/**
**/user*/**
**/publish*.*
.github/**
Dockerfile
**/Dockerfile
infra/**
**/package.json
**/package-lock.json
**/pnpm-lock.yaml
**/yarn.lock
**/requirements*.txt
**/pyproject.toml
**/uv.lock
**/Cargo.toml
**/Cargo.lock
```
