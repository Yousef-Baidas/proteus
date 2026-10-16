### Fixed

- The guards' `--edit-last` rule no longer refuses a command that only mentions the flag. It used to match the
  text anywhere, so a heredoc editing a doc that quotes it, an `echo` or a `grep` was refused. Now only a `gh`
  call (or `proteus-gh.js`) that carries the flag is refused, read with the shell parser past `env`, `timeout`
  and the other wrappers, and inside `sh -c`, `eval`, `$( )` and backticks. A line that also runs a shell or
  `eval` has its quoted words and heredoc bodies judged as commands too, so `bash <<EOF` and `… | sh` stay caught.
