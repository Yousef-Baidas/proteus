### Security

- `proteus-trust.yml` now scans every PR into a run branch by default (#199). Its `security` job checks out the
  head as data and runs `proteus-scan.js`: semgrep (OWASP and secrets) on the changed files, gitleaks on the
  PR's commits, osv-scanner when a lockfile changed, and zizmor when a workflow changed. Each tool is pinned to
  a version and each download to a checksum, and a tool with nothing to scan logs one skip line. The PR's own
  ignore files, configs and inline suppressions are not read. `proteus-security.js --findings` takes their SARIF
  (a file or a directory), and a finding the base's `teams/baseline.json` does not record under `security` turns
  `proteus/security` red. `--list` feeds the baseline ratchet so existing findings can be recorded once
  (`enforcement.md` §4). The commented-out semgrep steps are gone.
