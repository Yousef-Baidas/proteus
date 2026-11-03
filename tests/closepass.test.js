// proteus-cli.js close tests: node tests/closepass.test.js (needs git). A real origin repo with a run branch, the fake gh
// (FAKE_GH_NEXT) answering the tracker. close is ready, exit 0, only when the final pass recorded a trusted close-passes
// line for the run and the tip differs from the newest line's commit by added lead records alone; every other case, a
// failure, milestone-passes lines alone and no line at all included, runs the passes, exit 1 (#344 step 7).
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-cli.js");
const W = lib.workdir("closepass");
const TMPD = path.join(W, "tmp");
fs.mkdirSync(TMPD);
fs.writeFileSync(path.join(lib.HOME, ".claude", "proteus.json"), JSON.stringify({ human: "human" }));

const ORIGIN = path.join(W, "origin.git");
const ROOT = path.join(W, "repo");
g(W, "init", "-q", "--bare", "-b", "main", ORIGIN);
g(W, "init", "-q", "-b", "main", ROOT);
g(ROOT, "remote", "add", "origin", ORIGIN);
const put = (files) => {
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(ROOT, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
};
const commit = () => { g(ROOT, "add", "-A"); g(ROOT, "commit", "-q", "-m", "x"); return g(ROOT, "rev-parse", "HEAD"); };
put({ "src/a.js": "a\n", ".proteus/owned/1": "src/a.js\n" });
commit();
g(ROOT, "checkout", "-q", "-b", "proteus/r1");
put({ "src/a.js": "b\n" });
const OLD = commit();
put({ "src/a.js": "c\n" });
const SHA = commit();
const push = () => g(ROOT, "push", "-q", "-f", "origin", "HEAD:proteus/r1");
push();

const state = path.join(W, "gh.json");
const ticket = (n, m) => ({ number: n, title: `ticket ${n}`, state: "CLOSED", milestone: { title: m }, labels: [{ name: "proteus" }], body: "" });
const ISSUES = [ticket(1, "r1/core"), ticket(2, "r1/ui")];
const line = (sha, login = "human", run = "r1") => ({ author: { login }, body: `close-passes: ${run} ${sha}` });
const LINES = [line(SHA)];
const log = (comments) => [{ number: 9, title: "Run: r1", comments }];
const close = ({ issues = ISSUES, logs = log(LINES), env = {} } = {}) => {
  fs.writeFileSync(state, JSON.stringify({ issues, logs }));
  return lib.run(SCRIPT, "", { cwd: ROOT, args: ["close"], env: { FAKE_GH_NEXT: state, FAKE_GH_LOGIN: "agent", TMPDIR: TMPD, TEMP: TMPD, TMP: TMPD, ...env } });
};
const ready = (r) => r.code === 0 && /^close: ready /m.test(r.out);
const runs = (r, why) => r.code === 1 && /^close: run /m.test(r.out) && why.test(r.out);
// a case on a tip of its own, undone after
const onTip = (files, f) => {
  put(files);
  commit();
  push();
  const r = f();
  g(ROOT, "reset", "-q", "--hard", SHA);
  g(ROOT, "clean", "-qfd");
  push();
  return r;
};

let r = close();
ok("close: the tip the final pass approved is ready", ready(r), r.code + r.out + r.err);
ok("close: ready names the approved commit", r.out.includes(SHA.slice(0, 12)), r.out);
r = close({ logs: log([line(OLD), ...LINES]) });
ok("close: the newest line is the approved commit", ready(r), r.code + r.out + r.err);
r = close({ logs: log([...LINES, line(OLD)]) });
ok("close: a pass before the fix tickets reruns, naming what they changed", runs(r, /src[\\/]a\.js changed since/), r.code + r.out + r.err);
r = close({ logs: log([{ author: { login: "agent" }, body: `done\nclose-passes: r1 ${SHA}` }]) });
ok("close: the agents' login counts, and a line inside a longer comment", ready(r), r.code + r.out + r.err);

// the final pass is required: milestone passes over the same tree, or no line at all, never make close ready
const mline = (m) => ({ author: { login: "human" }, body: `milestone-passes: ${m} ${SHA}` });
r = close({ logs: log([mline("r1/core"), mline("r1/ui")]) });
ok("close: milestone-passes lines alone do not stand in for the final pass", runs(r, /final pass has not run/), r.code + r.out + r.err);
r = close({ logs: log([{ author: { login: "human" }, body: "started" }]) });
ok("close: a run log with no close-passes line runs the passes", runs(r, /no close-passes line/), r.code + r.out + r.err);
r = close({ logs: log([line(SHA, "human", "r2")]) });
ok("close: another run's close-passes line does not count", runs(r, /no close-passes line/), r.code + r.out + r.err);
r = close({ issues: [] });
ok("close: ready reads the run log, not the tickets", ready(r), r.code + r.out + r.err);

r = onTip({ ".proteus/owned/7": "src/b.js\n", "docs/lessons/l.md": "l\n", "docs/adr/0001-x.md": "x\n" }, () => close());
ok("close: added owned records, lessons and ADRs stay ready", ready(r), r.code + r.out + r.err);

r = onTip({ "src/a.js": "d\n" }, () => close());
ok("close: a changed deliverable runs the passes and names it", runs(r, /src[\\/]a\.js/), r.code + r.out + r.err);
r = onTip({ ".proteus/owned/1": "src/z.js\n" }, () => close());
ok("close: a changed record runs the passes", runs(r, /\.proteus[\\/]owned[\\/]1/), r.code + r.out + r.err);
r = onTip({ "teams/ROUTING.md": "x\n" }, () => close());
ok("close: an added file outside the records runs the passes", runs(r, /teams[\\/]ROUTING\.md/), r.code + r.out + r.err);
r = onTip({ "AGENTS.md": "lead-edits: src/**\n" }, () => close());
ok("close: an added lead doc that is no record runs the passes", runs(r, /AGENTS\.md/), r.code + r.out + r.err);
r = onTip({ "docs/lessons/nested/l.md": "l\n" }, () => close());
ok("close: a path below the record folders runs the passes", runs(r, /nested/), r.code + r.out + r.err);
if (process.platform !== "win32") {
  fs.mkdirSync(path.join(ROOT, "docs", "lessons"), { recursive: true });
  fs.symlinkSync("../../src/a.js", path.join(ROOT, "docs", "lessons", "l.md"));
  r = onTip({}, () => close());
  ok("close: a link at a record path runs the passes", runs(r, /l\.md/), r.code + r.out + r.err);
}

r = close({ logs: log([line(SHA, "passer-by")]) });
ok("close: a line from another login does not count", runs(r, /no close-passes line/), r.code + r.out + r.err);
r = close({ logs: log(LINES.map((c) => ({ ...c, author: { login: "" } }))), env: { FAKE_GH_LOGIN: "" } });
ok("close: no author and no login is not trusted", runs(r, /no close-passes line/), r.code + r.out + r.err);
r = close({ logs: log([{ author: { login: "human" }, body: `close-passes: r1 ${SHA.slice(0, 12)}` }]) });
ok("close: a short sha does not count", runs(r, /no close-passes line/), r.code + r.out + r.err);
r = close({ logs: [] });
ok("close: no run log runs the passes", runs(r, /run log/), r.code + r.out + r.err);
r = close({ logs: [{ number: 9, title: "Run: r2", comments: LINES }] });
ok("close: another run's log runs the passes", runs(r, /run log/), r.code + r.out + r.err);
r = close({ logs: { error: "down" } });
ok("close: an unreadable tracker runs the passes", runs(r, /tracker/), r.code + r.out + r.err);

const orphan = g(ROOT, "commit-tree", `${SHA}^{tree}`, "-m", "same tree, no history");
r = close({ logs: log([line(orphan)]) });
ok("close: a commit outside the run branch runs the passes", runs(r, /not on/), r.code + r.out + r.err);
r = close({ logs: log([line("f".repeat(40))]) });
ok("close: an unknown commit runs the passes", runs(r, /not on/), r.code + r.out + r.err);

g(ROOT, "remote", "set-url", "origin", path.join(W, "gone.git"));
r = close();
ok("close: an unreachable origin runs the passes", runs(r, /origin/), r.code + r.out + r.err);
g(ROOT, "remote", "set-url", "origin", ORIGIN);

r = lib.run(SCRIPT, "", { cwd: ROOT, args: ["close", "--nope"], env: { FAKE_GH_NEXT: state } });
ok("close: a bad argument is a usage error", r.code === 2, r.code + r.err);

lib.summary();
