### Changed

- A skipped check no longer stops the run. A missing required skill, or a pentest the safety system refuses,
  is logged as `<check>: skipped (<reason>)` on the run log, comes first in the next review, holds an
  unattended gate, and is listed in the close report for the human to decide. A refused pentest is never
  rerun or reworded, and nothing installs a skill on its own.
