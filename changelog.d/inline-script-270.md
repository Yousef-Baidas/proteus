### Fixed

- A worker's interpreter run on a script file (`node $S/scripts/install.mjs`, `python3 -m mod`) is no longer
  refused for a guarded path named elsewhere on the line (#270): only an interpreter with no script operand, or
  one given `-` or `/dev/stdin`, has the line's heredocs and other words judged as its code. `-e`/`-c` code,
  piped code and heredoc code are judged as before.
