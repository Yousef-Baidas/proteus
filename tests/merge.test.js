// Merge-batch tests: node tests/merge.test.js. proteus-merge.js against a real origin repo and worker worktrees,
// with the fake gh (FAKE_GH_MERGE) merging PRs there as merge commits. The script only prints the commit to test and
// the commands; the test plays the lead: it runs proteus-run-tree.js <sha>, then suite.js in .worktrees/_run, and
// reports with --result. The --suite it hands the script marks a file if anything ever runs it, and every child the
// script starts is logged (fixtures/spawn-log.js): it never runs git with a working tree (#226).
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run, g } = lib;
const { spawnSync, spawn } = require("child_process");
const HOOKS = path.join(__dirname, "..", "templates", "hooks");
const { mergeOrder, checkState } = require(path.join(HOOKS, "proteus-merge.js"));
const SCRIPT = path.join(HOOKS, "proteus-merge.js"), RUN_TREE = path.join(HOOKS, "proteus-run-tree.js");

const GREEN = [{ __typename: "StatusContext", context: "proteus/verdict", state: "SUCCESS" }, { __typename: "CheckRun", name: "gates", status: "COMPLETED", conclusion: "SUCCESS" }];
const write = (dir, files) => { for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body); };
const dirLink = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
const listing = (d) => fs.readdirSync(d).sort().join(",");

// every child proteus-merge.js starts, one JSON line each
const LW = lib.workdir("merge-log"), SPAWNS = path.join(LW, "spawns.jsonl");
const SHIM = `--require "${path.join(__dirname, "fixtures", "spawn-log.js").replace(/\\/g, "/")}"`;
const logged = { SPAWN_LOG: SPAWNS, NODE_OPTIONS: [lib.ENV.NODE_OPTIONS, SHIM].filter(Boolean).join(" ") };

// a run r1 on origin, one worker worktree and pushed branch per ticket; tickets: [{ t, pr, files, deps, checks }].
// plant(root, W, common): what an agent writes before the lead runs the script
function setup(name, tickets, plant) {
  const W = lib.workdir(name);
  const origin = path.join(W, "origin.git"), root = path.join(W, "root");
  g(W, "init", "-q", "--bare", "-b", "main", origin);
  g(W, "clone", "-q", origin, root);
  write(root, { "suite.js": "process.exit(require(\"fs\").existsSync(\"bad\") ? 1 : 0);\n", "a.txt": "one\n" });
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "HEAD:main", "HEAD:proteus/r1");
  g(root, "fetch", "-q", "origin");
  for (const k of tickets) {
    const wt = path.join(root, ".worktrees", String(k.t));
    g(root, "worktree", "add", "-q", "-b", `proteus-work/r1/${k.t}`, wt, "origin/proteus/r1");
    write(wt, k.files);
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", `ticket ${k.t}`);
    g(wt, "push", "-q", "origin", `proteus-work/r1/${k.t}`);
  }
  const state = path.join(W, "gh.json");
  fs.writeFileSync(state, JSON.stringify({
    origin,
    issues: tickets.map((k) => ({ number: k.t, state: "OPEN", body: k.deps ? `Depends on: ${k.deps.map((d) => `#${d}`).join(", ")}` : "" })),
    prs: tickets.map((k) => ({ number: k.pr, headRefName: `proteus-work/r1/${k.t}`, baseRefName: "proteus/r1", body: `Closes #${k.t}`, isDraft: false, statusCheckRollup: k.checks || GREEN })),
  }));
  if (plant) plant(root, W, path.join(root, ".git"));
  const merge = (...more) => run(SCRIPT, "", { cwd: root, env: { FAKE_GH_MERGE: state, ...logged }, args: ["r1", "--suite", NEVER, ...more] });
  const r = merge();
  const merges = g(root, "--git-dir", origin, "log", "--first-parent", "--format=%s", "proteus/r1").split("\n");
  return { r, root, W, merges, merge, line: r.out.trim(), common: path.join(root, ".git") };
}
// the suite command handed to the script: run by anything, it marks NEVER_RAN
const NW = lib.workdir("merge-never"), NEVER_RAN = path.join(NW, "ran");
fs.writeFileSync(path.join(NW, "never.js"), `require("fs").writeFileSync(${JSON.stringify(NEVER_RAN)}, "ran\\n");\n`);
const NEVER = `node "${path.join(NW, "never.js").split(path.sep).join("/")}"`;
const RUN = (root) => path.join(root, ".worktrees", "_run");
// the commit a printed step names, "" for none
const STEP = /suite: run node \S*proteus-run-tree\.js ([0-9a-f]{40}), then in \.worktrees\/_run run /;
const stepSha = (out) => (STEP.exec(out) || [])[1] || "";
// the lead's sandboxed step: _run filled with sha's tree
const tree = (root, sha) => run(RUN_TREE, "", { cwd: root, args: [sha] });
// the lead's side of the loop: while the script prints a step, fill _run, run suite.js there and report it
function loop(s) {
  let r = s.r, steps = 0;
  for (let sha = stepSha(r.out); sha && steps < 10; sha = stepSha(r.out)) {
    const t = tree(s.root, sha);
    if (t.code !== 0) return { steps, r: t, line: t.out.trim() };
    const pass = spawnSync(process.execPath, ["suite.js"], { cwd: RUN(s.root) }).status === 0;
    r = s.merge("--result", pass ? "pass" : "fail");
    steps++;
  }
  return { steps, r, line: r.out.trim() };
}
const STATE = (root) => path.join(root, ".git", "proteus", "merge", "r1.json");
const stateGone = (root) => !fs.existsSync(STATE(root));
const gone = (root, t) => !fs.existsSync(path.join(root, ".worktrees", String(t)));

// order: depends-on first, ticket numbers otherwise; an open depends-on outside the batch leaves the PR out
const order = mergeOrder([{ n: 41, ticket: 5, deps: [6] }, { n: 40, ticket: 4, deps: [] }, { n: 42, ticket: 6, deps: [] }, { n: 43, ticket: 7, deps: [99] }], new Set([4, 5, 6, 7, 99]));
ok("order: a depends-on merges first, one waiting outside the batch is left out", order.map((p) => p.n).join() === "40,42,41", JSON.stringify(order));

// green batch: three ready PRs in dependency order; a FAILURE verdict and a pending check stay open
let s = setup("green", [
  { t: 4, pr: 40, files: { "b.txt": "b\n" } },
  { t: 5, pr: 41, files: { "c.txt": "c\n" }, deps: [6] },
  { t: 6, pr: 42, files: { "d.txt": "d\n" } },
  { t: 7, pr: 43, files: { "e.txt": "e\n" }, checks: [{ __typename: "StatusContext", context: "proteus/verdict", state: "FAILURE" }] },
  { t: 8, pr: 44, files: { "f.txt": "f\n" }, checks: [GREEN[0], { __typename: "CheckRun", name: "gates", status: "IN_PROGRESS", conclusion: "" }] },
]);
const tipOf = (root) => g(root, "rev-parse", "origin/proteus/r1");
ok("green: one line naming the merges in dependency order, the run's tip and the two sandboxed commands, exit 0", s.r.code === 0 && s.line.startsWith("merged PR #40 for #4, PR #42 for #6, PR #41 for #5; suite: run node ") && stepSha(s.line) === tipOf(s.root) && s.line.endsWith(` r1 --suite ${JSON.stringify(NEVER)} --result pass|fail`), `${s.r.code} ${s.r.out} ${s.r.err}`);
ok("green: origin has the three merges in that order", s.merges.slice(0, 3).join("|") === "Merge pull request #41 from o/proteus-work/r1/5|Merge pull request #42 from o/proteus-work/r1/6|Merge pull request #40 from o/proteus-work/r1/4", s.merges.join("|"));
ok("green: the script leaves .worktrees/_run alone; the state names the tip", !fs.existsSync(RUN(s.root)) && JSON.parse(fs.readFileSync(STATE(s.root), "utf8")).at === tipOf(s.root));
const again = s.merge();
ok("green: a second batch is refused while one awaits --result", again.code === 1 && again.out.includes("a batch awaits --result pass|fail"), again.out + again.err);
const t0 = tree(s.root, stepSha(s.line));
ok("green: proteus-run-tree.js fills _run with the tip's tree, a plain directory", t0.code === 0 && ["c.txt", "d.txt", "suite.js"].every((f) => fs.existsSync(path.join(RUN(s.root), f))) && !fs.existsSync(path.join(RUN(s.root), ".git")) && !fs.readdirSync(path.join(s.root, ".worktrees")).some((d) => d.startsWith("_run-index-")), `${t0.code} ${t0.out} ${t0.err}`);
let l = loop(s);
ok("green: --result pass ends the batch, naming the worktrees and branches left as the tracker has them, exit 0", l.steps === 1 && l.r.code === 0 && /^run r1: suite green at [0-9a-f]{12}; worktree and branch left for the lead: proteus-work\/r1\/4, proteus-work\/r1\/6, proteus-work\/r1\/5$/.test(l.line) && stateGone(s.root), `${l.r.code} ${l.r.out} ${l.r.err}`);
ok("green: no worktree removed, the lead removes the merged ones (#226)", [4, 5, 6, 7, 8].every((t) => !gone(s.root, t)));
ok("green: the main checkout's index untouched", g(s.root, "status", "--porcelain", "-uno") === "", g(s.root, "status", "--porcelain", "-uno"));
const none = s.merge("--result", "pass");
ok("green: --result with no batch waiting is a usage error", none.code === 2, none.out + none.err);

// red batch: the second of four merges breaks the suite; bisect names it
s = setup("red", [
  { t: 1, pr: 20, files: { "b.txt": "b\n" } },
  { t: 2, pr: 21, files: { "bad": "x\n" } },
  { t: 3, pr: 22, files: { "c.txt": "c\n" } },
  { t: 4, pr: 23, files: { "d.txt": "d\n" } },
]);
l = loop(s);
ok("red: tip, then two bisect steps; exit 1, first bad merge is PR #21", s.r.code === 0 && l.steps === 3 && l.r.code === 1 && /^run r1: suite red; first bad PR #21 for #2 \([0-9a-f]{12}\); worktree and branch left for the lead: proteus-work\/r1\/1, proteus-work\/r1\/2, proteus-work\/r1\/3, proteus-work\/r1\/4$/.test(l.line) && stateGone(s.root), `${s.r.out} ${l.steps} ${l.r.code} ${l.r.out} ${l.r.err}`);
ok("red: one line only", l.r.out.trim().split("\n").length === 1, l.r.out);
ok("red: the main checkout's index untouched by the bisect", g(s.root, "status", "--porcelain", "-uno") === "", g(s.root, "status", "--porcelain", "-uno"));

// conflict: two tickets edit the same line; the first merges, the second stops the batch, the suite still runs
s = setup("conflict", [
  { t: 1, pr: 10, files: { "a.txt": "two\n" } },
  { t: 2, pr: 11, files: { "a.txt": "three\n" } },
  { t: 3, pr: 12, files: { "c.txt": "c\n" } },
]);
l = loop(s);
ok("conflict: exit 1, the batch stops at the conflicting PR, the suite runs on what merged", s.r.code === 1 && s.line.startsWith("merged PR #10 for #1; conflict PR #11 for #2; suite: ") && l.r.code === 0 && l.line.startsWith("run r1: suite green at "), `${s.r.code} ${s.r.out} ${l.r.out} ${l.r.err}`);
ok("conflict: nothing after the conflict merged", s.merges[0] === "Merge pull request #10 from o/proteus-work/r1/1" && !gone(s.root, 3), s.merges.join("|"));

// nothing ready: nothing merges, nothing runs
s = setup("none", [{ t: 1, pr: 10, files: { "b.txt": "b\n" }, checks: [GREEN[1]] }]);
ok("none: a PR without proteus/verdict is not ready; exit 0", s.r.code === 0 && s.line === "merged none; suite not run" && !gone(s.root, 1), `${s.r.code} ${s.r.out} ${s.r.err}`);

// the lead's checkout on the run branch: the script runs no git there; the lead fast-forwards it
let leadAt;
s = setup("lead", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root) => { g(root, "checkout", "-q", "-b", "proteus/r1", "origin/proteus/r1"); leadAt = g(root, "rev-parse", "HEAD"); });
ok("lead: the lead's checkout on the run branch is left as it was, clean", s.r.code === 0 && g(s.root, "rev-parse", "HEAD") === leadAt && !fs.existsSync(path.join(s.root, "b.txt")) && g(s.root, "status", "--porcelain", "-uno") === "", `${s.r.code} ${s.r.out} ${s.r.err}`);

// #226: proteus-run-tree.js refuses a link at .worktrees or _run, so even outside a sandbox it never follows one
let T;
s = setup("runlink", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W) => {
  T = path.join(W, "outside"); fs.mkdirSync(T);
  fs.writeFileSync(path.join(T, "victim.txt"), "victim\n");
  dirLink(T, path.join(root, ".worktrees", "_run"));
});
let t = tree(s.root, stepSha(s.line));
ok("runlink: a linked .worktrees/_run is refused by proteus-run-tree.js, exit 1", s.r.code === 0 && t.code === 1 && /^run-tree: refused: .*_run is not a real directory/.test(t.out), `${s.r.out} ${t.code} ${t.out} ${t.err}`);
ok("runlink: the dir the link leads to is unchanged", listing(T) === "victim.txt", listing(T));
s = setup("wtlink", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W) => {
  T = path.join(W, "outside"); fs.mkdirSync(path.join(T, "_run"), { recursive: true });
  fs.writeFileSync(path.join(T, "_run", "victim.txt"), "victim\n");
  fs.renameSync(path.join(root, ".worktrees"), path.join(W, "old-worktrees"));
  dirLink(T, path.join(root, ".worktrees"));
});
t = tree(s.root, stepSha(s.line));
ok("wtlink: a linked .worktrees is refused by proteus-run-tree.js, exit 1", t.code === 1 && /^run-tree: refused: .*\.worktrees is not a real directory/.test(t.out), `${t.code} ${t.out} ${t.err}`);
ok("wtlink: the dir the link leads to is unchanged", listing(path.join(T, "_run")) === "victim.txt", listing(path.join(T, "_run")));
// an older Proteus's _run, a registered worktree: emptied and filled as a plain directory, its admin dir untouched
let admin;
s = setup("migrate", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W, common) => {
  g(root, "worktree", "add", "-q", "--detach", path.join(root, ".worktrees", "_run"), "origin/proteus/r1");
  fs.writeFileSync(path.join(root, ".worktrees", "_run", "stale.txt"), "stale\n");
  admin = path.join(common, "worktrees", "_run");
});
const adminBefore = listing(admin) + fs.readFileSync(path.join(admin, "HEAD"), "utf8");
t = tree(s.root, stepSha(s.line));
ok("migrate: a registered _run becomes a plain directory holding the tip, with a message naming git worktree prune", t.code === 0 && /was a registered worktree.*git worktree prune/.test(t.err) && fs.existsSync(path.join(RUN(s.root), "b.txt")) && !fs.existsSync(path.join(RUN(s.root), "stale.txt")) && !fs.existsSync(path.join(RUN(s.root), ".git")), `${t.code} ${t.out} ${t.err}`);
ok("migrate: <common>/worktrees/_run untouched", listing(admin) + fs.readFileSync(path.join(admin, "HEAD"), "utf8") === adminBefore);
// round 2 R5: <common>/worktrees/_run a link to another repo's .git naming _run: the batch and its loop leave it alone
let OG, before;
const snap = (gd) => fs.readFileSync(path.join(gd, "HEAD"), "utf8") + fs.readFileSync(path.join(gd, "index")).toString("hex");
s = setup("adminlink", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }, { t: 2, pr: 11, files: { "bad": "x\n" } }], (root, W, common) => {
  const other = path.join(W, "other"); g(W, "init", "-q", other);
  write(other, { x: "x\n" }); g(other, "add", "-A"); g(other, "commit", "-qm", "other");
  OG = path.join(other, ".git");
  write(OG, { gitdir: path.join(root, ".worktrees", "_run", ".git") + "\n", commondir: "../..\n" });
  before = snap(OG);
  fs.mkdirSync(path.join(common, "worktrees"), { recursive: true });
  dirLink(OG, path.join(common, "worktrees", "_run"));
});
l = loop(s);
ok("adminlink: the batch runs to its red end", s.r.code === 0 && l.r.code === 1 && l.line.startsWith("run r1: suite red; first bad PR #11 for #2 "), `${s.r.out} ${l.r.out} ${l.r.err}`);
ok("adminlink: the other repo's HEAD and index are unchanged", snap(OG) === before);

// round 2 R3: a racer swaps .worktrees/_run with a link out of the project while forged states drive 50 calls
s = setup("race", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root) => fs.mkdirSync(path.join(root, ".worktrees", "_run")));
T = path.join(s.W, "outside"); fs.mkdirSync(T);
const V = path.join(T, "profile.sh");
const racer = path.join(s.W, "racer.js");
fs.writeFileSync(racer, `const fs=require("fs");const [R,T]=process.argv.slice(2);const RR=R+".real";const ty=process.platform==="win32"?"junction":"dir";
for(;;){try{fs.renameSync(R,RR);fs.symlinkSync(T,R,ty);for(let i=0;i<20000;i++);fs.unlinkSync(R);fs.renameSync(RR,R);for(let i=0;i<20000;i++);}catch{}}`);
const tip = tipOf(s.root);
const forged = { head: tip, at: tip, merged: [1, 2, 3, 4, 5].map((n) => ({ n, sha: tip })), left: [], lo: -1, mid: 2, hi: 4 };
const rc = spawn(process.execPath, [racer, RUN(s.root), T], { stdio: "ignore" });
let raced = 0;
for (let i = 0; i < 50; i++) {
  fs.writeFileSync(V, "# the human's login profile\n");
  fs.rmSync(STATE(s.root), { force: true });
  fs.writeFileSync(STATE(s.root), JSON.stringify(forged));
  if (s.merge("--result", "pass").code === 0) raced++;
}
rc.kill();
ok("race: 50 forged bisect steps under a racing _run link each print a step", raced === 50, raced);
ok("race: the dir the link leads to is unchanged", listing(T) === "profile.sh" && fs.readFileSync(V, "utf8") === "# the human's login profile\n", listing(T));

// #226: the state file is an agent's to write; every read checks it, a forged one is refused and changes nothing
s = setup("forge", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }, { t: 2, pr: 11, files: { "c.txt": "c\n" } }]);
const good = JSON.parse(fs.readFileSync(STATE(s.root), "utf8"));
ok("forge: the state written is one checkState accepts", checkState(good) && good.left.join() === "proteus-work/r1/1,proteus-work/r1/2", JSON.stringify(good));
const ESC = "\u001b[31mINJECTED\u001b[0m";
const step = { ...good, lo: -1, mid: 0, hi: 1, at: good.merged[0].sha };
const forgeries = {
  "a non-integer n": { ...good, merged: [{ ...good.merged[0], n: "10; rm -rf ~" }, good.merged[1]] },
  "n 0": { ...good, merged: [{ ...good.merged[0], n: 0 }, good.merged[1]] },
  "a fractional n": { ...good, merged: [{ ...good.merged[0], n: 1.5 }, good.merged[1]] },
  "a ticket of text": { ...good, merged: [{ ...good.merged[0], ticket: `1 ${ESC}` }, good.merged[1]] },
  "a negative ticket": { ...good, merged: [{ ...good.merged[0], ticket: -1 }, good.merged[1]] },
  "an option-like sha": { ...good, merged: [{ ...good.merged[0], sha: "--index-output=/tmp/x" }, good.merged[1]] },
  "a short sha": { ...good, merged: [{ ...good.merged[0], sha: good.merged[0].sha.slice(0, 12) }, good.merged[1]] },
  "a non-hex head": { ...good, head: "z".repeat(40), at: "z".repeat(40) },
  "an at not the head": { ...good, at: good.merged[0].sha },
  "a merged head that is no worker branch": { ...good, merged: [{ ...good.merged[0], head: "main" }, good.merged[1]], left: ["proteus-work/r1/2"] },
  "a left of main": { ...good, left: ["main"] },
  "a left of the run branch": { ...good, left: ["proteus/r1"] },
  "a left with an escape": { ...good, left: [`proteus-work/r1/1${ESC}`] },
  "a left no merged PR heads": { ...good, left: ["proteus-work/r1/9"] },
  "no merges": { ...good, merged: [], left: [] },
  "lo below -1": { ...step, lo: -2 },
  "hi past the merges": { ...step, mid: 1, hi: 2, at: good.merged[1].sha },
  "a fractional mid": { ...step, mid: 0.5 },
  "a mid outside lo..hi": { ...step, lo: 0, mid: 0, hi: 1 },
  "a mid of text": { ...step, mid: "0" },
  "an at not the mid's merge": { ...step, at: good.merged[1].sha },
  "lo and hi while the tip is tested": { ...good, lo: -1, hi: 1 },
  "not an object": [1, 2],
};
for (const [what, st] of Object.entries(forgeries)) {
  const rs = ["pass", "fail"].map((res) => {
    fs.rmSync(STATE(s.root), { force: true });
    fs.writeFileSync(STATE(s.root), JSON.stringify(st));
    return s.merge("--result", res);
  });
  ok(`forge: ${what} is refused on pass and fail, the state left as it was`, rs.every((r) => r.code === 1 && /^run r1: refused: .*r1\.json is not a batch's state$/.test(r.out.trim()) && !r.out.includes("\u001b")) && fs.readFileSync(STATE(s.root), "utf8") === JSON.stringify(st), rs.map((r) => `${r.code} ${r.out} ${r.err}`).join(" | "));
}
fs.rmSync(STATE(s.root), { force: true });
fs.writeFileSync(STATE(s.root), JSON.stringify(forgeries["a left of main"]));
const blocked = s.merge();
ok("forge: a forged state also refuses a new batch", blocked.code === 1 && blocked.out.includes("is not a batch's state"), blocked.out + blocked.err);
// a well-formed state still names branches only as the tracker has them: a merged PR's head, a worker branch
const fakeGh = JSON.parse(fs.readFileSync(path.join(s.W, "gh.json"), "utf8"));
fakeGh.prs.push({ number: 77, headRefName: "proteus-work/r1/7", baseRefName: "proteus/r1", body: "", isDraft: false, statusCheckRollup: [] });
fakeGh.prs.push({ number: 78, headRefName: "main", baseRefName: "proteus/r1", body: "", isDraft: false, statusCheckRollup: [], merged: true });
fs.writeFileSync(path.join(s.W, "gh.json"), JSON.stringify(fakeGh));
const named = { ...good, merged: [{ n: 77, head: "proteus-work/r1/7", sha: good.head }, { n: 78, head: "proteus-work/r1/8", sha: good.head }, { n: 99, head: "proteus-work/r1/9", sha: good.head }, { n: 10, head: "proteus-work/r1/1", sha: good.head }], left: ["proteus-work/r1/7", "proteus-work/r1/8", "proteus-work/r1/9", "proteus-work/r1/1"] };
fs.rmSync(STATE(s.root), { force: true });
fs.writeFileSync(STATE(s.root), JSON.stringify(named));
const pass = s.merge("--result", "pass");
ok("forge: on pass only a MERGED PR's head that is a worker branch is named: not an open PR's, a non-worker head, or an unknown PR", pass.code === 0 && /^run r1: suite green at [0-9a-f]{12}; worktree and branch left for the lead: proteus-work\/r1\/1$/.test(pass.out.trim()), pass.out + pass.err);
// control characters in what the lead typed never reach the output
fs.writeFileSync(STATE(s.root), JSON.stringify({ ...forged, head: good.head, at: good.head, merged: forged.merged.map((p) => ({ ...p, sha: good.head })) }));
const esc = run(SCRIPT, "", { cwd: s.root, env: { FAKE_GH_MERGE: path.join(s.W, "gh.json") }, args: ["r1", "--suite", `x ${ESC}`, "--result", "pass"] });
ok("forge: a control character in the suite is stripped from the output", !esc.out.includes("\u001b") && esc.out.includes("[31mINJECTED"), esc.out + esc.err);

// across every batch above: the script ran no suite, and no git with a working tree, an index or in _run
ok("never: proteus-merge.js ran no suite (#226)", !fs.existsSync(NEVER_RAN));
const spawns = fs.readFileSync(SPAWNS, "utf8").trim().split("\n").map((x) => JSON.parse(x));
const gits = spawns.filter((x) => /(^|[\\/])git(\.exe)?$/i.test(x.file));
const WT_CMDS = ["read-tree", "checkout", "checkout-index", "switch", "restore", "reset", "merge", "worktree", "update-ref", "update-index", "stash", "clean", "pull"];
ok("never: proteus-merge.js spawned git, all of it without a working tree or an index (#226)", gits.length > 20 && gits.every((x) => !x.workTree && !x.index && !x.args.some((a) => WT_CMDS.includes(a)) && !/[\\/]\.worktrees([\\/]|$)/.test(x.cwd)), JSON.stringify(gits.filter((x) => x.workTree || x.index || x.args.some((a) => WT_CMDS.includes(a)))).slice(0, 400));
ok("never: proteus-merge.js spawned only git and gh", spawns.every((x) => /(^|[\\/])(git|gh)(\.exe)?$/i.test(x.file)), JSON.stringify([...new Set(spawns.map((x) => x.file))]));

// proteus-run-tree.js runs sandboxed: no prefix rule or sandbox exclusion names it, while proteus-merge.js's rule stays
const cx = require(path.join(HOOKS, "proteus-harness-codex.js"));
const outside = [cx.RULES, ...["install.js", ...fs.readdirSync(HOOKS).map((f) => path.join("templates", "hooks", f))]
  .map((f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8"))
  .flatMap((text) => text.split("\n").filter((x) => /prefix_rule|excludedCommands|allowUnsandboxedCommands/.test(x)))];
ok("run-tree: no prefix rule or sandbox exclusion names proteus-run-tree.js", outside.length > 0 && outside.every((x) => !x.includes("proteus-run-tree")) && cx.RULES.includes(".codex/hooks/proteus-merge.js"), outside.join("\n"));
ok("run-tree: anything but one full commit id is a usage error", ["--index-output=x", "HEAD", "abc"].every((a) => tree(s.root, a).code === 2) && run(RUN_TREE, "", { cwd: s.root, args: [] }).code === 2);

const h = run(SCRIPT, "", { args: ["--help"] });
ok("--help explains --suite and --result", h.code === 0 && /--suite/.test(h.out) && /--result/.test(h.out));
ok("no --suite is a usage error", run(SCRIPT, "", { args: ["r1"] }).code === 2);
ok("proteus-run-tree.js --help", run(RUN_TREE, "", { args: ["--help"] }).code === 0);

lib.summary();
