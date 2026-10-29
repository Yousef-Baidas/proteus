#!/usr/bin/env node
// The tree a merge batch tests: node <hooks>/proteus-run-tree.js <sha>
// Checks out <sha> in <main>/.worktrees/_run, for the lead to run the suite there. It runs sandboxed, never by a
// prefix rule or a sandbox exclusion (#226): proteus-merge.js, which runs outside the sandbox, only prints this command
// with the commit to test. _run is a small repo of its own, not a worktree: `git init` once, its objects read from the
// project's through objects/info/alternates, then for each sha a branch run at it and a forced detached checkout, with
// untracked and ignored files cleaned. So git in the suite answers for the tested commit, not the lead's checkout, and
// nothing under <common> is written. Its git runs on _run/.git alone, pinned as every hook's (#215), with no auto
// maintenance. A _run that an older Proteus registered as a worktree is refused, with a message: remove it with
// `git worktree remove` outside any agent session. Exit 0 when _run's HEAD is <sha>; 1 on a refusal or a git failure;
// 2 on usage or outside a project.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: node proteus-run-tree.js <sha>";
const HELP = `${USAGE}
Checks out <sha> (a full commit id) in .worktrees/_run, a repo of its own, for the suite of a merge
batch. Run it sandboxed, from the project; proteus-merge.js prints it with the commit to test.
Exit 0 when _run holds <sha>; 1 on a refusal or a git failure; 2 on usage.`;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  if (argv.length !== 1 || !SHA.test(argv[0])) { console.error(`${USAGE}\n<sha> is a full commit id (--help explains it)`); return 2; }
  const sha = argv[0];
  const common = lib.repoCommon();
  const root = common && lib.mainRoot(common);
  if (!root) { console.error("not in a project checkout"); return 2; }
  const parent = lib.worktreesDir(root), dir = path.join(parent, "_run");
  const fail = (why) => { console.log(`run-tree: ${why}`); return 1; };

  // sandboxed, a link swapped in gains nothing; a link already there is still refused, not followed
  const gitDir = path.join(dir, ".git"), info = path.join(gitDir, "objects", "info");
  for (const d of [parent, dir, gitDir, path.dirname(info), info]) {
    let st;
    try { st = fs.lstatSync(d); } catch (e) { if (e.code === "ENOENT") continue; return fail(`refused: ${e.message}`); }
    if (d === gitDir && st.isFile()) return fail("refused: .worktrees/_run is a worktree an older Proteus registered; remove it with `git worktree remove --force .worktrees/_run` outside any agent session, then run this again");
    if (!st.isDirectory()) return fail(`refused: ${d} is not a real directory (a link or a file)`);
  }
  // _run's own repo, its git reading only _run/.git's config; a _run without one (a plain copy) starts over
  const git = (args) => lib.gitTry(gitDir, ["-c", "maintenance.auto=false", ...args], { cwd: dir, workTree: dir, timeout: 120000 });
  const why = (r) => r.err.split(/\r?\n/).filter(Boolean).pop() || "git failed";
  if (!fs.existsSync(gitDir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = git(["init", "-q", "-b", "run"]);
    if (!r.ok) return fail(`cannot make .worktrees/_run a repo (${why(r)})`);
  }
  // the project's objects, read only: a new alternates file, never one written through
  try {
    const alt = path.join(info, "alternates");
    fs.mkdirSync(info, { recursive: true });
    fs.rmSync(alt, { force: true });
    fs.writeFileSync(alt, `${path.join(common, "objects").split(path.sep).join("/")}\n`, { flag: "wx" });
  } catch (e) {
    return fail(`cannot point .worktrees/_run at the project's objects (${e.message})`);
  }
  for (const args of [["update-ref", "refs/heads/run", sha], ["checkout", "-q", "-f", "--detach", sha], ["clean", "-q", "-ffdx"]]) {
    const r = git(args);
    if (!r.ok) return fail(`.worktrees/_run cannot hold ${sha.slice(0, 12)} (${why(r)})`);
  }
  if (git(["rev-parse", "--verify", "HEAD"]).out !== sha) return fail(`.worktrees/_run's HEAD is not ${sha.slice(0, 12)}`);
  console.log(`run-tree: .worktrees/_run holds ${sha.slice(0, 12)}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
