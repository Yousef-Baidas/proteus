### Security

- `proteus-trust.yml` now scans every PR into a run branch by default (#199). Its `security` job checks out the
  head as data and runs `proteus-scan.js`: semgrep (OWASP and secrets) on the changed files, gitleaks on the
  PR's commits, osv-scanner when a lockfile changed, and zizmor when a workflow changed. semgrep runs as its
  image pinned by digest, every other tool is a download checked against a sha256, and a tool with nothing to
  scan logs one skip line. The PR's own ignore files, configs and inline suppressions are not read: gitleaks
  reads a mirror clone with no working tree, so a committed `.gitleaksignore` hides nothing, and osv-scanner
  runs with call analysis off, so no Go or Rust build runs on the head. `proteus-security.js --findings` takes
  their SARIF (a file or a directory), and a finding the base's `teams/baseline.json` does not record under
  `security` turns `proteus/security` red. That gate's baseline matches exactly, digits included, so a new CVE
  in a lockfile is not covered by an old one. A head path, rule id or scanner message prints between
  `::stop-commands::` markers with a random token, and a path or rule id as one inert line besides, so none
  runs as a workflow command, `##[cmd]` included. A base or head commit missing from gitleaks's mirror fails
  the scan instead of reading as clean. `--list` feeds the baseline ratchet so existing findings can be
  recorded once (`enforcement.md` §4).
  The commented-out semgrep steps are gone.
