### Added

- An `intake <urls|file>` command (#197): the lead spawns one helper per video, in parallel, and each posts one
  note on the tracker issue `Intake: <date>`: title, channel, length and URL, a 3 to 5 line summary, findings
  with a timestamp and the owner's theme numbers, and quotes where the wording matters. The helper uses the
  scout's video skill, else `yt-dlp` plus captions. `proteus-intake.js` opens the issue and renders and posts
  each note: a transcript's text stays data (one line per field, after the template's own text, mentions and
  HTML defused), a note that does not fit the template is refused, and a source already noted is not posted
  again. Nothing is stored in the repo.
