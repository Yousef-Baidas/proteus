### Added

- The backend and security team profiles carry three authorization rules (#203): authorization lives in one
  module, the single source of truth with field-level rules included; every handler or service call goes
  through it; query filters are derived from it, not copied. Their verifiers send a new inline permission
  check outside that module back to the worker, quoting the rule, and the conventions interview asks where
  the module is so `CONVENTIONS.md` names it.
