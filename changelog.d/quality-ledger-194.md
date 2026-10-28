### Added

- The review brief has a **Quality** section (#194): at most eight lines of numbers, each linked, counted from
  CI, the tracker and git: gates green, mutation survivors on the milestone's files, deep-review blockers raised
  and fixed, security verdicts with semgrep and OSV findings, bounces and escalations per ticket, baseline
  ratchet movement and open debt. A source the guide could not read is red, and the unattended grader answers
  any red line with `AUTO-HOLD`. `tests/fixtures/review-issue.md` shows a brief with it.
