### Added

- `proteus-skill-find.js <term> [--json]` (#10): the scout's skill search. It queries skills.sh, the installed
  skills, GitHub code search and the anthropics marketplaces, keeps a candidate only if it was pushed within 365
  days and is trusted (anthropics/* or installed) or has 50+ stars or 100+ installs, merges one skill found twice,
  and ranks trusted first, then max(installs, stars), then recency, with each repo's default-branch sha. A failed
  source prints `SKIP`, an empty result `NONE <term>`. The scout's step 3 runs it per term, picks by fit, and
  keeps to 4 skills and 40 KB per team (`link-skills.js` enforces the caps).
