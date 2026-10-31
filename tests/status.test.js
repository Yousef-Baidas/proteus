// Status tests: node tests/status.test.js (needs git). proteus-status.js --json (#311, the run panel mod's data) prints
// one JSON object and nothing else: no open run and an unreachable tracker are states of their own, the text line's
// facts are fields, and the open questions and pending milestone reviews carry number, title and url. The text line
// stays as it was. gh is the shared fake answering exact argument lists (FAKE_GH_SKILLS). No network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ST = path.join(ROOT, "templates", "hooks", "proteus-status.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("status");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

const FAKES = path.join(W, "gh.json");
const status = (args, fakes, env = {}) => {
  fs.writeFileSync(FAKES, JSON.stringify(fakes));
  return lib.run(ST, "", { cwd: REPO, args, env: { FAKE_GH_SKILLS: FAKES, ...env } });
};
const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

// no run branch yet
let r = status(["--json"], {});
let j = json(r);
ok("no run: --json prints one object, state no-run, exit 0", r.code === 0 && j && j.state === "no-run" && j.version === 1 && r.out.trim().split("\n").length === 1, r.out + r.err);
r = status([], {});
ok("no run: the text line is unchanged", r.code === 0 && r.out.trim() === "no open run (no proteus/<run> branch)", r.out);

g(REPO, "branch", "proteus/r1");
// the tracker unreachable
r = status(["--json"], {}, { FAKE_GH: "fail" });
j = json(r);
ok("unreachable: --json is a state with the run, never a throw", r.code === 0 && j && j.state === "unreachable" && j.run === "r1" && !r.err, r.out + r.err);
r = status([], {}, { FAKE_GH: "fail" });
ok("unreachable: the text line is unchanged", r.out.trim() === "run r1 · tracker unreachable (gh issue list failed)", r.out);

const day = 86400000, t0 = Date.parse("2026-01-01T00:00:00Z");
const at = (d) => new Date(t0 + d * day).toISOString();
const ms1 = { number: 1, title: "r1/core" };
const ISSUES = [
  { number: 1, state: "CLOSED", createdAt: at(0), closedAt: at(1), milestone: ms1, labels: [{ name: "proteus" }] },
  { number: 2, state: "CLOSED", createdAt: at(0), closedAt: at(3), milestone: ms1, labels: [{ name: "proteus" }] },
  { number: 3, state: "OPEN", createdAt: at(0), closedAt: null, milestone: ms1, labels: [{ name: "proteus" }] },
];
const PRS = [
  { number: 7, headRefName: "proteus-work/r1/3", title: "A change", url: "https://host/o/r/pull/7", reviews: [], comments: [{ body: "MERGE looks right" }] },
  { number: 8, headRefName: "proteus-work/r1/4", title: "Another", url: "https://host/o/r/pull/8", reviews: [], comments: [] },
];
const BASE = {
  "issue list --label proteus --state all --json number,state,createdAt,closedAt,milestone,labels --limit 500": ISSUES,
  "pr list --base proteus/r1 --state open --json number,headRefName,reviews,comments --limit 100": PRS,
  "pr list --base proteus/r1 --state open --json number,headRefName,reviews,comments,title,url --limit 100": PRS,
  "issue list --state open --label proteus-question --json number,title,url --limit 100": [{ number: 21, title: "Q: r1: which way", url: "https://host/o/r/issues/21" }],
  "issue list --state open --label proteus-review --label needs-human --json number,title,url --limit 100": [{ number: 22, title: "Review: r1/core", url: "https://host/o/r/issues/22" }],
};

r = status([], BASE);
const LINE = "run r1 · policy balanced · milestone r1/core 2/3 closed · 2 PRs open (1 verdict) · eta ~1d0h (median 2d0h/ticket)";
ok("ok: the text line is unchanged", r.code === 0 && r.out.trim() === LINE, r.out + r.err);

r = status(["--json"], BASE);
j = json(r);
ok("ok: --json prints one object and nothing else", r.code === 0 && j && r.out.trim().split("\n").length === 1 && !r.err, r.out + r.err);
ok("ok: the line's facts are fields", j && j.state === "ok" && j.run === "r1" && j.policy === "balanced" &&
  JSON.stringify(j.milestone) === JSON.stringify({ title: "r1/core", closed: 2, total: 3 }) &&
  j.prs.open === 2 && j.prs.verdict === 1 && j.eta.medianMs === 2 * day && j.eta.ms === day && j.line === LINE, r.out);
ok("ok: each open PR carries number, title, url and whether it has a verdict",
  j && JSON.stringify(j.prs.items) === JSON.stringify([{ number: 7, title: "A change", url: "https://host/o/r/pull/7", verdict: true }, { number: 8, title: "Another", url: "https://host/o/r/pull/8", verdict: false }]), r.out);
ok("ok: open questions and pending milestone reviews carry number, title and url",
  j && JSON.stringify(j.waiting) === JSON.stringify({ questions: [{ number: 21, title: "Q: r1: which way", url: "https://host/o/r/issues/21" }], reviews: [{ number: 22, title: "Review: r1/core", url: "https://host/o/r/issues/22" }] }), r.out);
r = status(["r1", "--json"], BASE);
ok("ok: a run argument and --json combine in either order", json(r) && json(r).run === "r1" && json(r).state === "ok", r.out + r.err);

// a failed read of what waits on the human is the tracker unreachable, never an empty list
const noReviews = { ...BASE };
delete noReviews["issue list --state open --label proteus-review --label needs-human --json number,title,url --limit 100"];
r = status(["--json"], noReviews);
j = json(r);
ok("waiting unreadable: state unreachable, not an empty list", r.code === 0 && j && j.state === "unreachable" && j.run === "r1" && !("waiting" in j), r.out + r.err);

lib.summary();
