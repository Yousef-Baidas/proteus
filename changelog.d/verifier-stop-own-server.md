### Fixed

- A verifier or QA agent stops a server it started by its own PID, without asking, and never by name,
  pattern or port. A pattern kill was refused by the safety check and held a review on a human reply for
  about ten minutes.
