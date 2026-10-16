### Fixed

- State migration merges a `*.jsonl` log past 8 MB instead of leaving it behind: the merged log keeps its
  newest 8 MB, with a first line marking that older lines were dropped. Each side is read only from its end.
- State migration names what it refused to move: a FIFO, a socket or a device, instead of `ENOTREG`.
- The compaction recall opens `journal.jsonl` without following a link (also one swapped in after the
  check, where the OS has `O_NOFOLLOW`), never blocks on a FIFO, and skips a state folder that is a link.
