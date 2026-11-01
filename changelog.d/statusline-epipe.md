### Fixed

- The user's own status line no longer vanishes at random when its command exits without reading stdin. The
  failed write to the command's stdin no longer discards its output.
