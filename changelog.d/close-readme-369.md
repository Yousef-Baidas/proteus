### Added

- Close writes an owner README (#369): before the final pass a worker writes or updates the project's `README.md`
  with how to install, start, use and check the result, and the close QA pass follows it literally on a clean
  checkout; a missing README or a step that fails as written is `WAVE-RED`, so close cannot finish without one.
  The information gate asks how the human will run the result, and `docs-diet.md` always allows a README.
