### Security

- `proteus-trust.yml` splits into two jobs (#233). `scan`, with `contents: read` and no secret, checks out the
  head and runs the scanners, then uploads their reports as an artifact; `post`, the one job with
  `statuses: write`, checks out only the base, reads the artifact as data (regular files, at most 64 of
  64 MiB each, parsed as JSON) and posts `proteus/security`. A scanner subverted by a hostile file can no
  longer outlive its step and read the posting step's token, as it could when both shared a VM.
  Update `.github/workflows/proteus-trust.yml` from the template.
- Every log line that holds head text (a path, a SARIF uri, a rule id, scanner stderr) opens with a fixed
  `proteus-scan: ` or `proteus-security: ` prefix and shows control characters as `?`, so a path starting
  with `::` cannot start a workflow command. `proteus-security.js` prints all its fenced output on stdout,
  so its `::stop-commands::` fences cannot interleave across streams.
- `proteus-scan.js` also scans a symlink the PR turns into a regular file, `requirements-*.txt` and
  `requirements/*.txt` (osv-scanner), and composite actions' `action.yml` (zizmor).
