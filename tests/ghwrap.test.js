// proteus-gh.js tests: node tests/ghwrap.test.js. gh writes retried on a secondary rate limit, passed through otherwise.
// The fake gh (tests/fakegh.js, FAKE_GH_LIMIT) fails the first N calls; waits are scaled to milliseconds.
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("ghwrap");
const GH = path.join(SRC, "proteus-gh.js");
let k = 0;
const gh = (limit, env = {}, args = ["issue", "comment", "5", "--body", "x"], input = "") => {
  const f = path.join(W, `n${++k}`);
  const r = lib.run(GH, input, { cwd: W, args, env: { FAKE_GH_LIMIT: String(limit), FAKE_GH_LIMIT_FILE: f, PROTEUS_GH_BASE_S: "0.01", ...env } });
  return { ...r, calls: parseInt(fs.readFileSync(f, "utf8"), 10) };
};

let r = gh(0);
ok("no limit: one call, gh's output and exit 0", r.calls === 1 && r.code === 0 && /issuecomment-1/.test(r.out) && !/rate limited/.test(r.err), r.err);
r = gh(2);
ok("secondary limit twice: retried, then succeeds", r.calls === 3 && r.code === 0 && /issuecomment-1/.test(r.out) && !/secondary rate limit/.test(r.out) && /retry 2\/4/.test(r.err), r.err);
r = gh(9, { PROTEUS_GH_ATTEMPTS: "3" });
ok("attempts capped: exit 1, gh's message passed through", r.calls === 3 && r.code === 1 && /secondary rate limit/.test(r.err), r.err);
r = gh(1, { FAKE_GH_LIMIT_MSG: "gh: HTTP 403: Resource not accessible" });
ok("a plain 403 is not retried", r.calls === 1 && r.code === 1 && /not accessible/.test(r.err), r.err);
r = gh(1, { FAKE_GH_LIMIT_MSG: "gh: slow down (HTTP 429)" });
ok("429 is retried", r.calls === 2 && r.code === 0, r.err);
r = gh(1, { FAKE_GH_LIMIT_MSG: "secondary rate limit\nretry-after: 1" });
ok("retry-after is honored", r.calls === 2 && r.code === 0 && /in 1\.\d+s/.test(r.err), r.err);
r = gh(1, { FAKE_GH_LIMIT_MSG: "secondary rate limit\nretry-after: 900", PROTEUS_GH_MAX_WAIT_S: "5" });
ok("a wait past the total cap ends the retries without sleeping", r.calls === 1 && r.code === 1 && r.ms < 3000, r.err);
r = gh(1, {}, ["issue", "comment", "5", "--body-file", "-"], "hello body");
ok("piped body survives a retry", r.calls === 2 && r.code === 0, r.err);

// the guards treat the wrapper as gh
const hl = require(path.join(SRC, "proteus-lib.js"));
const wd = (c) => hl.workerDenial({ tool: "shell", command: c, cwd: W });
const P = "node .claude/hooks/proteus-gh.js";
ok("guards: wrapper gets the --admin, edit-last and verdict rules",
  /--admin/.test(wd(`${P} pr merge 4 --admin`) || "") &&
  /edit-last/.test(wd(`${P} issue comment 4 --${"edit"}-last`) || "") &&
  /human's words/.test(wd(`${P} issue comment 4 --body "ACCEPT"`) || "") &&
  wd(`${P} issue comment 4 --body "DONE #4"`) === null);

lib.summary();
