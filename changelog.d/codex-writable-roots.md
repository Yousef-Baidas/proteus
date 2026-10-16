### Fixed

- Codex `writable_roots`: a `["sandbox_workspace_write"]` header written with quotes is read as the
  table instead of getting a second `[sandbox_workspace_write]` table appended, which Codex rejects, and a
  table that sets `writable_roots` twice is refused instead of edited. On Windows a root listed with `/`
  separators counts as the same folder as one with `\`. The `[[sandbox_workspace_write]]` refusal now
  says to make it a single table.

### Changed

- The Codex `writable_roots` editing is one function, `writableRoots` in `proteus-harness-codex.js`,
  tested on its own.
