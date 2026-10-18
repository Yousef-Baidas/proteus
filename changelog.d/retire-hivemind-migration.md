### Removed

- The hivemind migration (#134): the takeover of hivemind's global and repo pieces, `--migrate-all` and
  `-MigrateAll`, the move of `.git/hive/` into `.git/proteus/`, the legacy `hive/<run>` names and `hive*` labels a
  run opened under hivemind finished under, the `hivemind` stub skill, and the doctor's hivemind checks. An install
  from before the rename upgrades through a 1.x release first, then to 2.x.
