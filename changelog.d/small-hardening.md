### Fixed

- Codex `writable_roots` are compared case-insensitively on macOS and Windows, so a root listed as
  `/Users/Me/x` is not added again as `/users/me/x`. A `[[sandbox_workspace_write]]` array of tables is
  refused with a message, like the other forms the installer does not edit, instead of being missed.
- State migration no longer moves a FIFO, socket or device from the legacy folder, and no longer merges a
  `*.jsonl` log over 8 MB; both are reported as failed and left where they are.
- The compaction recall no longer reads a `journal.jsonl` that is a link or not a regular file.
- `link-skills.js --confine` prints how many global links it removed, and says there was nothing to remove
  instead of "confined" when it removed none.
- An owned path with no wildcard, such as `src/auth`, covers the files below it, not only a path ending in `/`.
- `tests/run.js` names a test file that crashes, counts it in the failed total, and no longer loses the
  summary line of a file that prints more than 1 MiB.
