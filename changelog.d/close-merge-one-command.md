### Fixed

- In local mode the lead posts the human's head-bound `ACCEPT <sha12>` on the close PR before giving them the
  merge command, so one command finishes the merge. The first attempt used to be refused for want of that
  record, and the human had to run the command twice.
