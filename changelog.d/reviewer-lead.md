### Added

- The verifier now works as its own lead (#344): it writes a risk list
  of 3 to 6 items with a USD cap each under a `Risks:` line in its
  verdict review, delegates fact-gathering through `proteus-delegate.js`
  on the lowest rung that can do it, and alone decides every finding
  and the verdict. Authorization, permissions, private data, secrets
  and data loss are never delegated. On a recheck `brief verifier`
  writes the earlier risk list to `risks-<pr>[-security].md` in scratch
  and names it, for the new verifier to reuse.
