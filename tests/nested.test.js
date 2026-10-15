// Nested worktree tests: node tests/nested.test.js (needs git). Worker worktrees live in <repo>/.worktrees/<id>/,
// inside the main checkout: git skips them through info/exclude, the lead guard refuses the lead's edits there, a
// worker stays in its own, and the worktree's own hooks resolve its own toplevel. A run opened before the move
// keeps its worktrees in ../<repo>-proteus/ until they merge.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const T = require(path.join(__dirname, "lib.js"));
const { ok, g, summary } = T;
const W = T.workdir("nested");
const lib = require(path.join(HOOKS, "proteus-lib.js"));

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
put(REPO, "teams/ROUTING.md", "# Routing\n\n```tiers\ndocs/**  direct  lines=5\n```\n");
put(REPO, "src/a.ts", "a\n"); put(REPO, "docs/a.md", "a\n"); put(REPO, "AGENTS.md", "## Learned\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "branch", "proteus/r1");

const WT = path.join(REPO, ".worktrees");
const WA = path.join(WT, "r1-1"), WB = path.join(WT, "r1-2"), WD = path.join(WT, "direct-2026-10-16");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WA, "proteus/r1");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/2", WB, "proteus/r1");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/direct/2026-10-16", WD, "main");
const prep = (wt, ...args) => T.run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: REPO, args: [wt, ...args] });
let r = prep(WA, "src/");
ok("prepare: a worktree under .worktrees/ is prepared", r.code === 0 && fs.existsSync(lib.ownedFile(WA)), r.out + r.err);
prep(WA, "src/"); prep(WB, "src/"); prep(WD, "--tier", "direct", "docs/");

// ---- git: the main checkout skips .worktrees/ through info/exclude, never .gitignore
const exclude = fs.readFileSync(path.join(REPO, ".git", "info", "exclude"), "utf8");
ok("exclude: /.worktrees/ is listed once after repeated runs", exclude.split(/\r?\n/).filter((l) => l === "/.worktrees/").length === 1, exclude);
ok("exclude: no .gitignore is written", !fs.existsSync(path.join(REPO, ".gitignore")));
const clean = () => g(REPO, "status", "--porcelain", "--untracked-files=all");
ok("main: git status is clean with three worktrees nested in it", clean() === "", clean());
ok("main: git add -A stages nothing from .worktrees/", g(REPO, "add", "-A", "--dry-run") === "");
ok("lib: worktreesUnder finds the nested worktrees", lib.worktreesUnder(REPO, WT).length === 3 && lib.worktreesDir(REPO) === WT);

// ---- the lead guard, main thread: the lead writes no code, and a worker's worktree is code
const LG = path.join(HOOKS, "proteus-lead-guard.js");
const fw = (p) => p.split(path.sep).join("/");
const edit = (file, extra = {}, cwd = REPO) => T.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name: "Edit", tool_input: { file_path: file }, ...extra }, { cwd: REPO });
r = edit(path.join(WA, "src", "a.ts"));
ok("lead: an edit under .worktrees/ is refused and named", r.code === 2 && r.err.includes("the lead does not edit .worktrees/r1-1/src/a.ts"), r.err);
r = edit(path.join(WA, "AGENTS.md"));
ok("lead: a doc the lead keeps is still refused inside a worktree", r.code === 2 && r.err.includes(".worktrees/r1-1/AGENTS.md"), r.err);
ok("lead: its own AGENTS.md still passes", edit(path.join(REPO, "AGENTS.md")).code === 0);

// ---- a subagent stays in its own worktree
const sub = (id, file, cwd) => edit(file, { agent_id: id, agent_type: "proteus-worker" }, cwd);
ok("subagent (cwd its worktree): its owned path passes", sub("c1", path.join(WA, "src", "a.ts"), WA).code === 0);
r = sub("c1", path.join(REPO, "src", "a.ts"), WA);
ok("subagent (cwd its worktree): the main checkout is refused", r.code === 2 && /main checkout while a run is open/.test(r.err) && r.err.includes(`yours is ${fw(WA)}`), r.err);
r = sub("c1", path.join(WB, "src", "a.ts"), WA);
ok("subagent (cwd its worktree): a sibling .worktrees/<other> is refused", r.code === 2 && r.err.includes(`is in ${fw(WB)}, another worker's worktree; yours is ${fw(WA)} (your cwd)`), r.err);
ok("subagent (bound): its first edit binds it", sub("b1", path.join(WA, "src", "b.ts"), REPO).code === 0);
put(WA, "src/b.ts", "b\n");
r = sub("b1", path.join(WB, "src", "a.ts"), REPO);
ok("subagent (bound): a sibling .worktrees/<other> is refused", r.code === 2 && r.err.includes(`yours is ${fw(WA)} (uncommitted work there)`), r.err);
r = sub("b1", path.join(REPO, "src", "a.ts"), REPO);
ok("subagent (bound): the main checkout is refused, naming its worktree", r.code === 2 && r.err.includes(`yours is ${fw(WA)}: edit ${fw(path.join(WA, "src", "a.ts"))}`), r.err);
fs.rmSync(path.join(WA, "src", "b.ts"));

// ---- the worker's own edit hook in its worktree
const OP = path.join(WA, ".claude", "hooks", "proteus-owned-paths.js");
const wedit = (file) => T.run(OP, { hook_event_name: "PreToolUse", session_id: "w1", cwd: WA, tool_name: "Edit", tool_input: { file_path: file } }, { cwd: WA });
ok("worker hook: an owned path in its worktree passes", wedit(path.join(WA, "src", "a.ts")).code === 0);
r = wedit(path.join(REPO, "src", "a.ts"));
ok("worker hook: the main checkout around it is outside the worktree", r.code === 2 && /outside the worktree/.test(r.err), r.err);
r = wedit(path.join(WB, "src", "a.ts"));
ok("worker hook: a sibling .worktrees/<other> is outside the worktree", r.code === 2 && /outside the worktree/.test(r.err), r.err);

// ---- pre-commit: the owned and tier checks resolve the nested worktree's own toplevel
const commit = (dir, file, text) => {
  put(dir, file, text);
  g(dir, "add", file);
  return spawnSync("git", ["commit", "-qm", "docs: x"], { cwd: dir, encoding: "utf8", env: T.ENV });
};
r = commit(WA, "src/n.ts", "n\n");
ok("pre-commit (owned): an owned path commits in a nested worktree", r.status === 0, r.stderr);
r = commit(WA, "docs/n.md", "n\n");
ok("pre-commit (owned): a path outside the list is refused, named from the worktree's root",
  r.status !== 0 && /not in \.claude\/proteus-owned:\n  docs\/n\.md/.test(r.stderr) && !r.stderr.includes(".worktrees"), r.stderr);
g(WA, "reset", "-q", "--hard");
r = commit(WD, "docs/a.md", "b\n");
ok("pre-commit (tier): a change within Direct commits in .worktrees/direct-<batch>", r.status === 0, r.stderr);
r = commit(WD, "docs/b.md", "1\n2\n3\n4\n5\n6\n");
ok("pre-commit (tier): one over the Direct limits is refused", r.status !== 0 && /needs the quick tier, declared direct/.test(r.stderr), r.stderr);
g(WD, "reset", "-q", "--hard");
ok("main: still clean after commits in the nested worktrees", clean() === "", clean());

// ---- a run opened before the move: its worktree beside the repo still prepares, commits and is found
const OLD = path.join(`${REPO}-proteus`, "r0-1");
g(REPO, "branch", "proteus/r0");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r0/1", OLD, "proteus/r0");
r = prep(OLD, "src/");
ok("older run: its worktree in ../<repo>-proteus/ is prepared as before", r.code === 0 && fs.existsSync(lib.ownedFile(OLD)), r.out + r.err);
r = commit(OLD, "src/o.ts", "o\n");
ok("older run: an owned commit there still passes", r.status === 0, r.stderr);
ok("older run: lib lists its folder among the old ones holding worktrees",
  lib.oldWorktreeDirs(REPO).some((d) => lib.worktreesUnder(REPO, d).length === 1) && lib.worktreesUnder(REPO, WT).length === 3);
const cx = require(path.join(HOOKS, "proteus-harness-codex.js"));
const roots = cx.sandboxRoots(REPO, false);
ok("older run: Codex needs its folder in writable_roots, and nothing for .worktrees/",
  !roots.error && roots.missing.length === 1 && roots.missing[0] === `${REPO}-proteus`, JSON.stringify(roots));
ok("older run: a worker there is refused the main checkout too", sub("o1", path.join(REPO, "src", "a.ts"), OLD).code === 2);

summary();
