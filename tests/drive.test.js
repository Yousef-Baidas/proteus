// proteus-cli.js drive tests: node tests/drive.test.js (needs git). First drive's loop in process, with next, result
// and the step runner replaced: a suite RUN then result pass and the loop going on, a failed suite as result fail, the
// stop on each lead line, the round cap, the no-progress stop, a RUN that comes back, a failed non-suite RUN as
// BLOCKED. Then runSteps on real children, and drive from the CLI on a real merge batch (the fake gh's NEXT and MERGE
// against a real origin, as tests/next.test.js): the suite run in .worktrees/_run, result pass or the bisect to its
// first bad PR. No network.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-cli.js");
const W = lib.workdir("drive");
const TMPD = path.join(W, "tmp");
fs.mkdirSync(TMPD);
const TENV = { TMPDIR: TMPD, TEMP: TMPD, TMP: TMPD };
const { drive, runSteps } = require(SCRIPT);

// ---- the loop, with its parts replaced: next answers from a script of lists, the last one repeated
function rig(lists, { results = [], exits = {} } = {}) {
  const calls = { next: 0, result: [], exec: [] };
  const io = {
    root: W,
    next: () => ({ code: 0, out: lists[Math.min(calls.next++, lists.length - 1)] }),
    result: (arg, verdict, at) => { calls.result.push([verdict, at]); return results.shift() || { code: 0, out: [`result ${verdict}`], acts: [] }; },
    exec: (root, a) => { calls.exec.push(a.command); const code = exits[a.command] || 0; return { code, why: code ? "boom" : "", gate: !!a.gate }; },
  };
  return { io, calls };
}
const kinds = (xs) => xs.map((a) => a.kind).join();
const SUITE = (at) => ({ kind: "RUN", command: `suite at ${at}`, suite: true, at, argv: [], gate: "node suite.js" });
const SPAWN = { kind: "SPAWN", role: "worker", ticket: 3, team: "backend", difficulty: "standard", worktree: "/w", brief: "b" };

let t = rig([[{ kind: "MERGED", pr: 5, head: "a", verdict: "success", by: "v" }, SUITE("s1")], [SPAWN]]);
let d = drive("", t.io);
ok("loop: a suite RUN runs, then result pass at its sha", JSON.stringify(t.calls.result) === JSON.stringify([["pass", "s1"]]), JSON.stringify(t.calls));
ok("loop: after the result it calls next again and stops on its SPAWN", t.calls.next === 2 && d.code === 0 && kinds(d.out) === "SPAWN", JSON.stringify(d));
ok("loop: what it did comes back as done: MERGED, the RUN, the result's NOTE", kinds(d.done) === "MERGED,RUN,NOTE" && d.done.every((a) => a.done), JSON.stringify(d.done));

t = rig([[SUITE("s2")], [SPAWN]], { exits: { "suite at s2": 1 } });
d = drive("", t.io);
ok("loop: a failing suite is result fail at its sha", JSON.stringify(t.calls.result) === JSON.stringify([["fail", "s2"]]) && d.done.find((a) => a.kind === "RUN").exit === 1, JSON.stringify(t.calls));

t = rig([[SUITE("s3")]], { results: [{ code: 0, out: ["green"], acts: [{ kind: "STOP", agent: "w5", reason: "merged" }, { kind: "RUN", command: "forget w5", argv: [] }] }] });
d = drive("", t.io);
ok("loop: result's STOP is the lead's, its --forget runs here", kinds(d.out) === "STOP" && t.calls.exec.join("|") === "suite at s3|forget w5" && t.calls.next === 1, JSON.stringify(d) + JSON.stringify(t.calls));
t = rig([[SUITE("s4")]], { results: [{ code: 1, out: ["suite red; first bad PR #60 for #6"], acts: [] }] });
d = drive("", t.io);
ok("loop: a result that exits non-zero stops with DECIDE merge: and its line", d.out.length === 1 && d.out[0].kind === "DECIDE" && d.out[0].about === "merge" && /first bad PR #60/.test(d.out[0].reason), JSON.stringify(d));

for (const lead of [SPAWN, { kind: "ASK", n: 30, url: "u", title: "q" }, { kind: "DECIDE", about: "suite", reason: "r" }, { kind: "STOP", agent: "a", reason: "r" }, { kind: "NUDGE", agent: "a", reason: "r" }, { kind: "MERGE", pr: 1, head: "h", verdict: "v", by: "b" }]) {
  t = rig([[lead, { kind: "BLOCKED", ticket: 4, reason: "waits on #3" }]]);
  d = drive("", t.io);
  ok(`loop: stops on ${lead.kind} at once, every line for the lead`, d.code === 0 && t.calls.next === 1 && kinds(d.out) === `${lead.kind},BLOCKED` && !d.done.length, JSON.stringify(d));
}
t = rig([[{ kind: "BLOCKED", ticket: 4, reason: "waits on #3" }]]);
d = drive("", t.io);
ok("loop: stops on BLOCKED alone, no WAIT", t.calls.next === 1 && kinds(d.out) === "BLOCKED", JSON.stringify(d));
t = rig([[SPAWN, { kind: "RUN", command: "prep 8", argv: [] }], [SPAWN]]);
d = drive("", t.io);
ok("loop: a RUN beside a lead line runs first, then next again", t.calls.exec.join() === "prep 8" && t.calls.next === 2 && kinds(d.out) === "SPAWN", JSON.stringify(d));

t = rig([[{ kind: "BLOCKED", ticket: 4, reason: "x" }, { kind: "WAIT", command: "wait", argv: [] }], [SPAWN]]);
d = drive("", t.io);
ok("loop: WAIT runs the watchdog, then next again", t.calls.exec.join() === "wait" && t.calls.next === 2 && kinds(d.done) === "WAIT", JSON.stringify(d));

let k = 0;
const fresh = { root: W, max: 4, next: () => ({ code: 0, out: [{ kind: "RUN", command: `step ${k++}`, argv: [] }] }), result: () => ({ code: 0, out: [], acts: [] }), exec: () => ({ code: 0, why: "", gate: false }) };
d = drive("", fresh);
ok("cap: stops after max rounds with a NOTE", k === 4 && d.code === 0 && d.out.length === 1 && d.out[0].reason.startsWith("drive: stopped after 4 rounds"), JSON.stringify(d));
process.env.PROTEUS_DRIVE_MAX = "2";
k = 0;
d = drive("", { ...fresh, max: 0 });
ok("cap: PROTEUS_DRIVE_MAX sets it", k === 2 && /stopped after 2 rounds/.test(d.out[0].reason), JSON.stringify(d));
delete process.env.PROTEUS_DRIVE_MAX;

t = rig([[{ kind: "SWEPT", count: 1, mb: "0.1" }]]);
d = drive("", t.io);
ok("no progress: the same list twice with nothing run stops", t.calls.next === 2 && d.out.length === 1 && /no progress/.test(d.out[0].reason) && kinds(d.done) === "SWEPT,SWEPT", JSON.stringify(d));

t = rig([[{ kind: "RUN", command: "same", argv: [] }]]);
d = drive("", t.io);
ok("repeat: a RUN back after it ran is returned to the lead, run once", t.calls.exec.join() === "same" && kinds(d.out) === "RUN,NOTE" && d.out[0].command === "same" && /came back/.test(d.out[1].reason), JSON.stringify(d));
t = rig([[SUITE("s5")]]);
d = drive("", t.io);
ok("repeat: a suite RUN at the same sha again is returned too, one result", t.calls.result.length === 1 && kinds(d.out) === "RUN,NOTE", JSON.stringify(d));

t = rig([[{ kind: "RUN", command: "prep 9", argv: [] }, SPAWN]], { exits: { "prep 9": 3 } });
d = drive("", t.io);
ok("failed RUN: BLOCKED naming the command and its exit code, the rest for the lead", d.code === 0 && kinds(d.out) === "BLOCKED,SPAWN" && d.out[0].reason === "RUN exited 3: prep 9: boom" && !t.calls.result.length, JSON.stringify(d));
d = drive("", { root: W, next: () => ({ code: 1, err: "tracker unreachable" }) });
ok("error: next's error is the driver's, with its code", d.code === 1 && d.err === "tracker unreachable", JSON.stringify(d));

// ---- runSteps on real children: argv steps in order, the first failure's code; the gate in .worktrees/_run
const node = process.execPath;
let x = runSteps(W, { argv: [[node, "-e", "process.exit(0)"], [node, "-e", "console.error('bad step'); process.exit(3)"], [node, "-e", "process.exit(9)"]] });
ok("steps: the first failing step's exit code and last line", x.code === 3 && x.why === "bad step" && !x.gate, JSON.stringify(x));
fs.mkdirSync(path.join(W, ".worktrees", "_run"), { recursive: true });
fs.writeFileSync(path.join(W, ".worktrees", "_run", "here.js"), "process.exit(require('fs').existsSync('here.js') ? 4 : 5);\n");
x = runSteps(W, { argv: [[node, "-e", "process.exit(0)"]], gate: "node here.js" });
ok("steps: the gate runs in .worktrees/_run, its code returned as the suite's", x.code === 4 && x.gate, JSON.stringify(x));

// ---- the CLI on a real merge batch
const ms = { title: "r1/core", number: 1 };
const issue = (n) => ({ number: n, title: `ticket ${n}`, state: "OPEN", milestone: ms, labels: [{ name: "proteus" }, { name: "profile:backend" }, { name: "difficulty:standard" }], body: `Owned: src/t${n}.js\nReview: light` });
const VERDICT = { __typename: "StatusContext", context: "proteus/verdict", state: "SUCCESS" };
const CI = { __typename: "CheckRun", name: "gates", status: "COMPLETED", conclusion: "SUCCESS" };
const put = (dir, files) => { for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body); };
function batchRepo(name, tickets, ready) {
  const B = path.join(W, name), origin = path.join(B, "origin.git"), root = path.join(B, "root");
  fs.mkdirSync(B);
  g(B, "init", "-q", "--bare", "-b", "main", origin);
  g(B, "clone", "-q", origin, root);
  put(root, { "suite.js": "process.exit(require(\"fs\").existsSync(\"bad\") ? 1 : 0);\n", "a.txt": "one\n", "AGENTS.md": "# Agents\n\n## Learned\n\n- gate: `node suite.js`\n" });
  fs.mkdirSync(path.join(root, ".proteus", "owned"), { recursive: true });
  for (const n of [...tickets.map((k) => k.t), ...ready]) put(root, { [path.join(".proteus", "owned", String(n))]: `src/t${n}.js\n` });
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "HEAD:main", "HEAD:proteus/r1");
  g(root, "fetch", "-q", "origin");
  g(root, "branch", "-q", "proteus/r1", "origin/proteus/r1");
  const statuses = {}, prs = [];
  for (const k of tickets) {
    const wt = path.join(root, ".worktrees", String(k.t));
    g(root, "worktree", "add", "-q", "-b", `proteus-work/r1/${k.t}`, wt, "origin/proteus/r1");
    put(wt, k.files);
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", `ticket ${k.t}`);
    g(wt, "push", "-q", "origin", `proteus-work/r1/${k.t}`);
    const head = g(wt, "rev-parse", "HEAD");
    statuses[head] = [{ context: "proteus/verdict", state: "success", creator: { login: "verifier-app[bot]" } }];
    prs.push({ number: k.pr, headRefName: `proteus-work/r1/${k.t}`, headRefOid: head, baseRefName: "proteus/r1", body: `Closes #${k.t}`, isDraft: false, statusCheckRollup: [VERDICT, CI] });
  }
  const state = path.join(B, "gh.json");
  fs.writeFileSync(state, JSON.stringify({ origin, issues: [...tickets.map((k) => issue(k.t)), ...ready.map(issue)], prs, reviews: [], inbox: [], statuses }));
  const cli = (...args) => lib.run(SCRIPT, "", { cwd: root, args, env: { FAKE_GH_NEXT: state, FAKE_GH_MERGE: state, PROTEUS_DRIVE_MAX: "6", ...TENV } });
  const tip = () => g(root, "--git-dir", origin, "rev-parse", "proteus/r1");
  return { root, cli, tip, prs };
}
const lines = (r) => r.out.trim().split("\n").filter(Boolean);
// file-first (#366): the DID lines behind the count line, read from the file it names, then stdout's own
const detail = (L) => { const m = /^DID \d+ steps, each in (.+)$/.exec(L[0] || ""); return m ? [...fs.readFileSync(m[1], "utf8").trim().split("\n"), ...L] : L; };

let b = batchRepo("pass", [{ t: 5, pr: 50, files: { "b.txt": "five\n" } }, { t: 6, pr: 60, files: { "c.txt": "six\n" } }], [8]);
let r = b.cli("drive");
let L = lines(r);
const tip = b.tip();
ok("cli pass: exits 0", r.code === 0, `${r.code} ${r.out} ${r.err}`);
ok("cli pass: the batch's MERGED lines as DID", L.filter((l) => /^DID MERGED PR#(50|60) /.test(l)).length === 2, r.out);
ok("cli pass: over three DID lines go to a scratch file, one count line first naming it", /^DID \d+ steps, each in .*drive\.txt$/.test(L[0]) && !L.some((l) => l.startsWith("DID RUN ")), r.out);
ok("cli pass: the suite's RUN as DID, on the batch's tip", detail(L).some((l) => l.startsWith("DID RUN ") && l.includes(`proteus-run-tree.js ${tip}, then in .worktrees/_run: node suite.js`)), r.out);
ok("cli pass: result pass at the tip, the batch done", detail(L).some((l) => l.startsWith(`DID NOTE result pass --at ${tip}: `) && /suite green/.test(l)) && !fs.existsSync(path.join(b.root, ".git", "proteus", "merge", "r1.json")), r.out);
ok("cli pass: _run holds the tested tip", g(path.join(b.root, ".worktrees", "_run"), "rev-parse", "HEAD") === tip);
ok("cli pass: then the lead's line, the ready ticket's SPAWN, last and not DID", L[L.length - 1].startsWith("SPAWN worker #8 ") && !L.some((l) => l.startsWith("DID SPAWN")), r.out);
r = b.cli("drive", "--json");
let J = [];
try { J = JSON.parse(r.out); } catch {}
ok("cli --json: one array of actions, the lead's without done", r.code === 0 && Array.isArray(J) && J.some((a) => a.kind === "SPAWN" && a.ticket === 8 && !a.done), r.out + r.err);

b = batchRepo("bisect", [{ t: 5, pr: 50, files: { "b.txt": "five\n" } }, { t: 6, pr: 60, files: { bad: "x\n" } }], []);
const top = (() => { r = b.cli("drive"); return b.tip(); })();
L = lines(r);
ok("cli fail: exits 0, stopped for the lead", r.code === 0, `${r.code} ${r.out} ${r.err}`);
ok("cli fail: result fail at the tip", detail(L).some((l) => l.startsWith(`DID NOTE result fail --at ${top}: `)), r.out);
ok("cli fail: the bisect step ran too, and result pass on it", detail(L).some((l) => /^DID NOTE result pass --at [0-9a-f]{40}: /.test(l) && !l.includes(top)), r.out);
ok("cli fail: then DECIDE merge: naming the first bad PR", L[L.length - 1].startsWith("DECIDE merge: ") && /first bad PR #60/.test(L[L.length - 1]), r.out);

r = lib.run(SCRIPT, "", { cwd: b.root, args: ["drive", "--bogus"] });
ok("cli: an unknown argument is usage, exit 2", r.code === 2 && /usage/.test(r.err), `${r.code} ${r.err}`);

lib.summary();
