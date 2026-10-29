#!/usr/bin/env node
// The tree a merge batch tests: node <hooks>/proteus-run-tree.js <sha>
// Empties <main>/.worktrees/_run and fills it with the tree of <sha>, for the lead to run the suite there. It runs
// sandboxed, never by a prefix rule or a sandbox exclusion (#226): proteus-merge.js, which runs outside the sandbox,
// only prints this command with the commit to test. _run is a plain directory, not a registered worktree: git reads
// the objects from the project's common dir, pinned (#215), and writes _run through a private index in a scratch dir
// beside it, so nothing under <common>/worktrees is touched. A _run left by an older Proteus as a registered
// worktree is emptied like any other; its admin dir stays until `git worktree prune`. Exit 0 when _run holds <sha>;
// 1 on a refusal or a git failure; 2 on usage or outside a project.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: node proteus-run-tree.js <sha>";
const HELP = `${USAGE}
Empties .worktrees/_run and fills it with the tree of <sha> (a full commit id), for the suite of a merge
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
  for (const d of [parent, dir]) {
    let st;
    try { st = fs.lstatSync(d); } catch (e) { if (e.code === "ENOENT") continue; return fail(`refused: ${e.message}`); }
    if (!st.isDirectory()) return fail(`refused: ${d} is not a real directory (a link or a file)`);
  }
  let was = false;
  try { was = fs.lstatSync(path.join(dir, ".git")).isFile(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (was) console.error("run-tree: .worktrees/_run was a registered worktree; it is a plain directory now. Run `git worktree prune` to drop its old entry.");

  const tmp = fs.mkdtempSync(path.join(parent, "_run-index-"));
  try {
    const r = lib.gitTry(common, ["read-tree", "-u", "--reset", sha], { cwd: dir, workTree: dir, index: path.join(tmp, "index"), timeout: 120000 });
    if (!r.ok) return fail(`.worktrees/_run cannot hold ${sha.slice(0, 12)} (${r.err.split(/\r?\n/).filter(Boolean).pop() || "git failed"})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`run-tree: .worktrees/_run holds ${sha.slice(0, 12)}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
