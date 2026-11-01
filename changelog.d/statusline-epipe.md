### Fixed

- The user's own status line no longer vanishes at random when its command exits without reading stdin. The
  write to the command's stdin fails with EPIPE in that case, and that failure no longer discards its output.
