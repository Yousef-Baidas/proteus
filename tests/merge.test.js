// Merge-batch tests: node tests/merge.test.js. proteus-merge.js against a real origin repo and worker worktrees,
// with the fake gh (FAKE_GH_MERGE) merging PRs there as merge commits. The script only prints the suite command;
// the test plays the lead: it runs suite.js in .worktrees/_run and reports with --result. The --suite it hands the
// script marks a file if anything ever runs it (#226).
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run, g } = lib;
const { spawnSync } = require("child_process");
const { mergeOrder, writeState } = require(path.join(__dirname, "..", "templates", "hooks", "proteus-merge.js"));
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-merge.js");

const GREEN = [{ __typename: "StatusContext", context: "proteus/verdict", state: "SUCCESS" }, { __typename: "CheckRun", name: "gates", status: "COMPLETED", conclusion: "SUCCESS" }];
const write = (dir, files) => { for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body); };

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
  const merge = (...more) => run(SCRIPT, "", { cwd: root, env: { FAKE_GH_MERGE: state }, args: ["r1", "--suite", NEVER, ...more] });
  const r = merge();
  const merges = g(root, "--git-dir", origin, "log", "--first-parent", "--format=%s", "proteus/r1").split("\n");
  return { r, root, W, merges, merge, line: r.out.trim() };
}
// the suite command handed to the script: run by anything, it marks NEVER_RAN
const NW = lib.workdir("merge-never"), NEVER_RAN = path.join(NW, "ran");
fs.writeFileSync(path.join(NW, "never.js"), `require("fs").writeFileSync(${JSON.stringify(NEVER_RAN)}, "ran\\n");\n`);
const NEVER = `node "${path.join(NW, "never.js").split(path.sep).join("/")}"`;
const RUN = (root) => path.join(root, ".worktrees", "_run");
// the lead's side of the loop: while the script prints a step, run suite.js in _run and report it. { steps, r, line }
function loop(s) {
  let r = s.r, steps = 0;
  while (r.out.includes("suite: in .worktrees/_run run ") && steps < 10) {
    const pass = spawnSync(process.execPath, ["suite.js"], { cwd: RUN(s.root) }).status === 0;
    r = s.merge("--result", pass ? "pass" : "fail");
    steps++;
  }
  return { steps, r, line: r.out.trim() };
}
const stateGone = (root) => !fs.existsSync(path.join(root, ".git", "proteus", "merge", "r1.json"));
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
ok("green: one line naming the merges in dependency order and the suite command for _run, exit 0", s.r.code === 0 && s.line.startsWith("merged PR #40 for #4, PR #42 for #6, PR #41 for #5; suite: in .worktrees/_run run node ") && s.line.endsWith(` r1 --suite ${JSON.stringify(NEVER)} --result pass|fail`), `${s.r.code} ${s.r.out} ${s.r.err}`);
ok("green: origin has the three merges in that order", s.merges.slice(0, 3).join("|") === "Merge pull request #41 from o/proteus-work/r1/5|Merge pull request #42 from o/proteus-work/r1/6|Merge pull request #40 from o/proteus-work/r1/4", s.merges.join("|"));
ok("green: _run is at the run's head", fs.existsSync(path.join(RUN(s.root), "d.txt")) && fs.existsSync(path.join(RUN(s.root), "c.txt")));
const again = s.merge();
ok("green: a second batch is refused while one awaits --result", again.code === 1 && again.out.includes("a batch awaits --result pass|fail"), again.out + again.err);
let l = loop(s);
ok("green: --result pass ends the batch, naming the worktrees and branches left, exit 0", l.steps === 1 && l.r.code === 0 && /^run r1: suite green at [0-9a-f]{12}; worktree and branch left for the lead: proteus-work\/r1\/4, proteus-work\/r1\/6, proteus-work\/r1\/5$/.test(l.line) && stateGone(s.root), `${l.r.code} ${l.r.out} ${l.r.err}`);
ok("green: no worktree removed, the lead removes the merged ones (#226)", [4, 5, 6, 7, 8].every((t) => !gone(s.root, t)));
ok("green: the main checkout's index untouched by the run's checkouts", g(s.root, "status", "--porcelain", "-uno") === "", g(s.root, "status", "--porcelain", "-uno"));
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
ok("red: _run is back at the run's head", fs.existsSync(path.join(RUN(s.root), "d.txt")) && fs.existsSync(path.join(RUN(s.root), "bad")));
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

// the lead's checkout on the run branch follows it: fast-forwarded to the batch's head
s = setup("lead", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root) => g(root, "checkout", "-q", "-b", "proteus/r1", "origin/proteus/r1"));
ok("lead: the lead's checkout on the run branch is fast-forwarded, clean", s.r.code === 0 && fs.existsSync(path.join(s.root, "b.txt")) && g(s.root, "rev-parse", "HEAD") === g(s.root, "rev-parse", "origin/proteus/r1") && g(s.root, "status", "--porcelain", "-uno") === "", `${s.r.code} ${s.r.out} ${s.r.err}`);

// #226: what a sandboxed agent can write under the project never turns the script on files outside it
const dirLink = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
const listing = (d) => fs.readdirSync(d).sort().join(",");
// an admin dir naming gitdir, its index listing victim.txt (read-tree --reset deletes a listed file it does not keep)
function plantAdmin(root, common, id, gitdir) {
  const admin = path.join(common, "worktrees", id);
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, "gitdir"), gitdir + "\n");
  fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
  fs.writeFileSync(path.join(admin, "HEAD"), g(root, "rev-parse", "origin/proteus/r1") + "\n");
  const env = { ...lib.ENV, GIT_INDEX_FILE: path.join(admin, "index") };
  const blob = require("child_process").execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, env, input: "victim\n", encoding: "utf8" }).trim();
  require("child_process").execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},victim.txt`], { cwd: root, env });
}
// _run a link out of the project, registered under its lexical path: git would follow it
let T;
s = setup("runlink", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W, common) => {
  T = path.join(W, "outside"); fs.mkdirSync(T);
  fs.writeFileSync(path.join(T, "victim.txt"), "victim\n");
  fs.mkdirSync(path.join(root, ".worktrees"), { recursive: true });
  dirLink(T, path.join(root, ".worktrees", "_run"));
  plantAdmin(root, common, "evil", path.join(root, ".worktrees", "_run", ".git"));
});
ok("runlink: a linked .worktrees/_run is refused, exit 1, nothing merged", s.r.code === 1 && /^run r1: refused: .*_run is not a real directory/.test(s.line) && s.merges[0] === "init", `${s.r.code} ${s.r.out} ${s.r.err}`);
ok("runlink: the dir the link leads to is unchanged", listing(T) === "victim.txt", listing(T));
// .worktrees itself a link out of the project
s = setup("wtlink", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W, common) => {
  T = path.join(W, "outside"); fs.mkdirSync(path.join(T, "_run"), { recursive: true });
  fs.writeFileSync(path.join(T, "_run", "victim.txt"), "victim\n");
  fs.renameSync(path.join(root, ".worktrees"), path.join(W, "old-worktrees"));
  dirLink(T, path.join(root, ".worktrees"));
  plantAdmin(root, common, "evil", path.join(root, ".worktrees", "_run", ".git"));
});
ok("wtlink: a linked .worktrees is refused, exit 1, nothing merged", s.r.code === 1 && /^run r1: refused: .*\.worktrees is not a real directory/.test(s.line) && s.merges[0] === "init", `${s.r.code} ${s.r.out} ${s.r.err}`);
ok("wtlink: the dir the link leads to is unchanged", listing(path.join(T, "_run")) === "victim.txt", listing(path.join(T, "_run")));
// _run a real directory no admin dir of its own names: a stranger's admin dir points elsewhere
s = setup("runowner", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W, common) => {
  T = path.join(root, ".worktrees", "_run"); fs.mkdirSync(T);
  fs.writeFileSync(path.join(T, "victim.txt"), "victim\n");
  plantAdmin(root, common, "evil", path.join(W, "elsewhere", ".git"));
});
ok("runowner: a .worktrees/_run no admin dir registers is refused, exit 1, nothing merged", s.r.code === 1 && /^run r1: refused: .*_run is not a worktree of this project/.test(s.line) && s.merges[0] === "init", `${s.r.code} ${s.r.out} ${s.r.err}`);
ok("runowner: the unregistered _run is unchanged", listing(T) === "victim.txt", listing(T));

// the batch's state a link: never written through, made new
let V;
s = setup("statelink", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W, common) => {
  V = path.join(W, "victim"); fs.writeFileSync(V, "victim\n");
  fs.mkdirSync(path.join(common, "proteus", "merge"), { recursive: true });
  fs.symlinkSync(V, path.join(common, "proteus", "merge", "r1.json"));
});
const STATE = (root) => path.join(root, ".git", "proteus", "merge", "r1.json");
ok("statelink: a state that is a link refuses the batch, exit 1, nothing merged", s.r.code === 1 && s.line.includes("refused:") && s.line.includes("is not a regular file") && s.merges[0] === "init", `${s.r.code} ${s.r.out} ${s.r.err}`);
ok("statelink: the link's target is unchanged", fs.readFileSync(V, "utf8") === "victim\n");
writeState(path.join(s.root, ".git"), "r1", { mid: null });
ok("statelink: writing the state replaces the link with a new file, the target unchanged", fs.readFileSync(V, "utf8") === "victim\n" && fs.lstatSync(STATE(s.root)).isFile() && JSON.parse(fs.readFileSync(STATE(s.root), "utf8")).mid === null);
// merge/ a link to a dir outside: refused, nothing written there
s = setup("statedir", [{ t: 1, pr: 10, files: { "b.txt": "b\n" } }], (root, W, common) => {
  T = path.join(W, "outside"); fs.mkdirSync(T);
  fs.mkdirSync(path.join(common, "proteus"), { recursive: true });
  dirLink(T, path.join(common, "proteus", "merge"));
});
ok("statedir: a linked merge/ is refused, exit 1, nothing written through it", s.r.code === 1 && /; suite not run: .*merge is not a real directory/.test(s.line) && listing(T) === "", `${s.r.code} ${s.r.out} ${s.r.err} ${listing(T)}`);

// across every batch above: the script never ran the suite command it was handed, nor anything in _run
ok("never: proteus-merge.js ran no suite (#226)", !fs.existsSync(NEVER_RAN));

const h = run(SCRIPT, "", { args: ["--help"] });
ok("--help explains --suite and --result", h.code === 0 && /--suite/.test(h.out) && /--result/.test(h.out));
ok("no --suite is a usage error", run(SCRIPT, "", { args: ["r1"] }).code === 2);

lib.summary();
