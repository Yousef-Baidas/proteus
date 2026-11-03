### Added

- `proteus-helper`, an agent type for small jobs that return data (digests, sorting, deduplicating, routine record
  updates, file search). It is the only spawn that may use one rung under the model floor, Haiku by default; the lead
  guard still refuses Haiku for workers, verifiers and every other type, and a custom `floor` applies to them as
  before. Delegated calls (`proteus-delegate.js`) may use any ladder rung. Codex is unchanged.
