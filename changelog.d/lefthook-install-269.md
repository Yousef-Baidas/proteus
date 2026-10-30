### Changed

- No agent runs `lefthook install` (#269). The scaffold worker proves the commit-msg hook with
  `lefthook run commit-msg <file>` on a bad and a good message, and the lead tells the human once to run
  `lefthook install` in the main checkout.
