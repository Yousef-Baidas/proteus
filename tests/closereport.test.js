// Close report tests: node tests/closereport.test.js (needs git). proteus-close-report.js reads a run's tickets and PRs
// from tests/fakegh.js (FAKE_GH_RUN), cost from a fake npx or a saved ccusage report, and the lead's journal. No network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CR = path.join(ROOT, "templates", "hooks", "proteus-close-report.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("closereport");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "branch", "proteus/r9");

const iso = (h) => new Date(Date.UTC(2026, 8, 1) + h * 3600e3).toISOString();
const ms = { number: 4, title: "r9/core" };
const lab = (...n) => n.map((name) => ({ name }));
const RUN = path.join(W, "run.json");
fs.writeFileSync(RUN, JSON.stringify({
  logs: [{ number: 7, title: "Run: r9", createdAt: iso(-1) }, { number: 6, title: "Run: r8", createdAt: iso(-50) }],
  issues: [
    { number: 11, title: "11: api | routes", state: "CLOSED", createdAt: iso(0), closedAt: iso(2), milestone: ms, labels: lab("proteus", "profile:backend", "difficulty:standard"), comments: [{ body: "DONE #11" }] },
    { number: 12, title: "12: auth", state: "CLOSED", createdAt: iso(0), closedAt: iso(3), milestone: ms, labels: lab("proteus", "profile:backend", "difficulty:hard"), comments: [{ body: "RED #12 still failing" }, { body: "DONE #12" }] },
    { number: 13, title: "13: page", state: "CLOSED", createdAt: iso(1), closedAt: iso(2), milestone: ms, labels: lab("proteus", "profile:frontend", "difficulty:standard"), comments: [] },
    { number: 14, title: "14: menu", state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: lab("proteus", "profile:frontend", "difficulty:standard"), comments: [] },
    { number: 15, title: "Revision r9/core r1", state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: lab("proteus"), comments: [] },
    { number: 16, title: "Review: r9/core", state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: lab("proteus-review"), comments: [] },
    { number: 17, title: "17: other run", state: "CLOSED", createdAt: iso(0), closedAt: iso(1), milestone: { number: 2, title: "r8/x" }, labels: lab("proteus"), comments: [{ body: "RED" }] },
  ],
  prs: [
    { number: 50, headRefName: "proteus-work/r9/11", body: "", reviews: [{ body: "BACK-TO-WORKER 1. a.js:3 wrong" }, { body: "MERGE" }], comments: [] },
    { number: 51, headRefName: "proteus-work/r9/12", body: "", reviews: [{ body: "**BACK-TO-WORKER** 1. b.js" }], comments: [] },
    { number: 52, headRefName: "proteus-work/r9/12", body: "", reviews: [{ body: "MERGE" }], comments: [{ body: "not a BACK-TO-WORKER at the start" }] },
    { number: 53, headRefName: "feature-x", body: "Closes #13\n\nOwned: src/", reviews: [{ body: "MERGE" }], comments: [] },
  ],
}));

// the lead's journal: two sessions inside the run's window, one before it
const JOURNAL = path.join(REPO, ".git", "proteus-lead", "journal.jsonl");
fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
fs.writeFileSync(JOURNAL, [
  { ts: iso(-30), session_id: "s0", prompt: "an older run" },
  { ts: iso(-0.5), session_id: "s1", prompt: "build r9" },
  { ts: iso(1), session_id: "s1", prompt: "ok" },
  { ts: iso(2.5), session_id: "s2", prompt: "resume" },
].map((e) => JSON.stringify(e)).join("\n") + "\n");
const COST = path.join(W, "cost.json");
fs.writeFileSync(COST, JSON.stringify({ session: [{ period: "s1", totalCost: 1.5 }, { period: "s2", totalCost: 2.5 }, { period: "s0", totalCost: 100 }], totals: { totalCost: 104 } }));

const report = (args, env = {}) => lib.run(CR, "", { cwd: REPO, args, env: { FAKE_GH_RUN: RUN, ...env } });

let r = report(["--cost-json", COST]);
const line = (re) => r.out.split("\n").find((l) => re.test(l)) || "";
ok("report: titled with the run found from the open proteus/<run> branch", r.code === 0 && r.out.startsWith("## Close report: r9\n"), r.out + r.err);
ok("tickets: only the run's tickets, revisions, reviews and other runs left out",
  ["#11", "#12", "#13", "#14"].every((n) => line(new RegExp(`^\\| ${n} \\|`))) && !/\| #1[567] \|/.test(r.out), r.out);
ok("ticket row: a BACK-TO-WORKER review is a bounce, MERGE is not; wall-clock created to closed; a | in the title is escaped",
  line(/^\| #11 /) === "| #11 | 11: api / routes | backend | standard | 1 | 1 | 0 | 2h |", line(/^\| #11 /));
ok("ticket row: two PRs by head branch, a bold BACK-TO-WORKER counts, a mention mid-comment does not, a RED report is an escalation",
  line(/^\| #12 /) === "| #12 | 12: auth | backend | hard | 2 | 1 | 1 | 3h |", line(/^\| #12 /));
ok("ticket row: a PR found by Closes #n in its body", line(/^\| #13 /) === "| #13 | 13: page | frontend | standard | 1 | 0 | 0 | 1h |", line(/^\| #13 /));
ok("ticket row: an open ticket is marked open", /^\| #14 .*\| 0 \| 0 \| 0 \| \S+ \(open\) \|$/.test(line(/^\| #14 /)), line(/^\| #14 /));
ok("team rows: per team and difficulty, rates over tickets, median wall-clock over closed ones",
  line(/^\| backend \| hard /) === "| backend | hard | 1 | 100% | 100% | 3h |" && line(/^\| backend \| standard /) === "| backend | standard | 1 | 100% | 0% | 2h |" &&
  line(/^\| frontend \| standard /) === "| frontend | standard | 2 | 0% | 0% | 1h |", r.out);
ok("summary: rates, totals, median wall-clock, cost over the journal's sessions in the window, average per closed ticket",
  line(/^Run: /) === "Run: 4 tickets, 3 closed · bounce rate 50% (2 bounces) · escalation rate 25% (1 escalation) · median wall-clock 2h · cost $4.00 over 2 sessions, $1.33 per closed ticket (average; ccusage does not split by ticket)", line(/^Run: /));
ok("re-scout: no routing miss, 4 tickets, no team of 3+ tickets: no SUGGEST line", !/SUGGEST/.test(r.out), r.out);

fs.writeFileSync(COST, JSON.stringify({ sessions: [{ sessionId: "s2", totalCost: 0.5 }] }));
r = report(["r9", "--cost-json", COST]);
ok("cost: an older ccusage shape (sessions[].sessionId) reads too; the run named explicitly", r.code === 0 && /cost \$0\.50 over 1 session, \$0\.17 per closed ticket/.test(r.out), line(/^Run: /));

// ccusage itself: a fake npx on PATH records its arguments and prints a report. On win32 it is an npx.cmd shim, as
// the real one is there (a fakeCli node.exe copy would take -y as a node option)
const NPXLOG = path.join(W, "npx.log");
const NPX = `require("fs").appendFileSync(${JSON.stringify(NPXLOG)}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ session: [{ period: "s1", totalCost: 3 }] }));`;
if (process.platform === "win32") {
  fs.writeFileSync(path.join(W, "npx.js"), NPX);
  fs.writeFileSync(path.join(lib.BIN, "npx.cmd"), `@"${process.execPath}" "${path.join(W, "npx.js")}" %*\r\n`);
} else lib.fakeCli(lib.BIN, "npx", NPX);
r = report([]);
ok("cost: runs the pinned ccusage through npx by default", r.code === 0 && /cost \$3\.00 over 1 session/.test(r.out) && fs.readFileSync(NPXLOG, "utf8").trim() === "-y ccusage@20.0.26 session --json", r.out + r.err);
r = report([], { PROTEUS_HARNESS: "codex" });
ok("cost: on Codex, the pinned @ccusage/codex", fs.readFileSync(NPXLOG, "utf8").trim().split("\n").pop() === "-y @ccusage/codex@19.0.0 session --json", fs.readFileSync(NPXLOG, "utf8"));

r = report(["--no-cost"]);
ok("cost: --no-cost skips it", r.code === 0 && /· cost not read \(--no-cost\)$/m.test(r.out), line(/^Run: /));
r = report(["--cost-json", path.join(W, "missing.json")]);
ok("cost: an unreadable report is n/a, the rest still prints", r.code === 0 && /cost n\/a \(cannot read /.test(r.out) && /\| #11 /.test(r.out), r.out);
fs.renameSync(JOURNAL, JOURNAL + ".off");
r = report(["--cost-json", COST]);
ok("cost: no journal entry in the window is n/a, not the whole report", r.code === 0 && /cost n\/a \(no journal entry inside the run's window\)/.test(r.out), line(/^Run: /));
fs.renameSync(JOURNAL + ".off", JOURNAL);

// re-scout signals (#82): a run of tickets given as [team or null, bounces]; each ticket has one PR
const signals = (spec) => {
  const f = path.join(W, "signals.json");
  fs.writeFileSync(f, JSON.stringify({ logs: [], issues: spec.map(([team], k) => ({ number: 100 + k, title: `t${k}`, state: "CLOSED", createdAt: iso(0), closedAt: iso(1), milestone: ms, labels: lab("proteus", ...(team ? [`profile:${team}`] : [])), comments: [] })),
    prs: spec.map(([, b], k) => ({ number: 200 + k, headRefName: `proteus-work/r9/${100 + k}`, body: "", reviews: Array.from({ length: b }, () => ({ body: "BACK-TO-WORKER 1. x" })), comments: [] })) }));
  return report(["--no-cost"], { FAKE_GH_RUN: f }).out.split("\n").filter((l) => l.startsWith("SUGGEST re-scout: "));
};
const runOf = (...groups) => groups.flatMap(([team, n, b = 0]) => Array.from({ length: n }, (_, k) => [team, k < b ? 1 : 0]));
let s = signals(runOf(["backend", 2], ["frontend", 2], [null, 1]));
ok("re-scout: a ticket with no profile: label is a routing miss, named with the count", s.length === 1 && s[0] === "SUGGEST re-scout: 1 ticket of 5 with no profile: label (routing misses #104)", s.join("\n"));
s = signals(runOf(["backend", 3], ["frontend", 3]));
ok("re-scout: one team at exactly half of 6 tickets is no skew", !s.length, s.join("\n"));
s = signals(runOf(["backend", 4], ["frontend", 3]));
ok("re-scout: one team just past half (4 of 7) is skew", s.length === 1 && s[0] === "SUGGEST re-scout: team backend holds 4 of 7 tickets (57%, over 50%)", s.join("\n"));
s = signals(runOf(["backend", 4], ["frontend", 1]));
ok("re-scout: no skew below 6 tickets in the run, even at 4 of 5", !s.length, s.join("\n"));
s = signals(runOf(["backend", 4], ["frontend", 2]));
ok("re-scout: skew counts from 6 tickets (4 of 6)", s.length === 1 && /team backend holds 4 of 6 tickets \(67%, over 50%\)$/.test(s[0]), s.join("\n"));
s = signals(runOf(["backend", 5, 2], ["frontend", 5]));
ok("re-scout: a team at exactly 40% bounces per ticket (2 over 5) is no hit", !s.length, s.join("\n"));
s = signals(runOf(["backend", 3, 2], ["frontend", 3]));
ok("re-scout: a team just past 40% (2 bounces over 3 tickets) is a hit, with its numbers", s.length === 1 && s[0] === "SUGGEST re-scout: team backend bounced 2 times over 3 tickets (67% BACK-TO-WORKER per ticket, over 40%)", s.join("\n"));
s = signals(runOf(["backend", 2, 2], ["frontend", 3]));
ok("re-scout: a team under 3 tickets is no bounce hit, even at 100%", !s.length, s.join("\n"));
s = signals(runOf(["backend", 5], [null, 2], ["qa", 3, 3]));
ok("re-scout: every hit prints its own line", s.length === 2 && /2 tickets of 10 .*#105, #106\)$/.test(s[0]) && /team qa bounced 3 times over 3 tickets \(100%/.test(s[1]), s.join("\n"));

r = report(["--no-cost"], { FAKE_GH: "fail" });
ok("tracker unreachable: exit 1, says so", r.code === 1 && /tracker unreachable/.test(r.err), r.err);
g(REPO, "branch", "-D", "proteus/r9");
ok("no run branch and no run named: exit 2", report(["--no-cost"]).code === 2);
ok("usage: an unknown flag exits 2", report(["--nope"]).code === 2);

// the Codex lead runs it outside the sandbox: it calls gh and npx, which need the network
const cx = require(path.join(ROOT, "templates", "hooks", "proteus-harness-codex.js"));
const CX = path.join(W, "cx");
fs.mkdirSync(CX);
cx.registerLead(CX);
ok("codex: the rules allow the lead's close report and tier check, never the gate cache (it runs any command)", ["close-report", "tier"].every((n) => fs.readFileSync(path.join(CX, ".codex", "rules", "proteus.rules"), "utf8").includes(JSON.stringify(path.join(CX, ".codex", "hooks", `proteus-${n}.js`).split(path.sep).join("/")))) && !fs.readFileSync(path.join(CX, ".codex", "rules", "proteus.rules"), "utf8").includes("proteus-gates-cache"));

lib.summary();
