// #212: node tests/indexcopy.test.js (needs git). lib.treeChanges runs git diff from unsandboxed hooks, and git
// rewrites a stat-dirty index by path, so it runs on a private copy of the checkout's index, never on
// <common>/worktrees/<id>/index, which a sandboxed agent can swap for a link to any dir. A flipper swaps that dir for
// a link to a victim dir while treeChanges runs; the victim must come out unchanged. Temp repo; never the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("indexcopy");
// the private copies go here, so the test can see that none is left behind
const TMP = path.join(W, "tmp");
fs.mkdirSync(TMP);
process.env.TMPDIR = process.env.TMP = process.env.TEMP = TMP;
const L = require(path.join(ROOT, "templates", "hooks", "proteus-lib.js"));

const link = (target, at, type) => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const snap = (d) => JSON.stringify(fs.readdirSync(d).sort().map((n) => [n, fs.readFileSync(path.join(d, n)).toString("base64")]));

const REPO = path.join(W, "app");
g(W, "init", "-q", "-b", "main", REPO);
g(REPO, "config", "user.name", "t");
g(REPO, "config", "user.email", "t@t");
const FILES = Array.from({ length: 40 }, (_, i) => `f${i}.txt`);
for (const f of FILES) fs.writeFileSync(path.join(REPO, f), `${f}\n`);
g(REPO, "add", ".");
g(REPO, "commit", "-q", "--no-verify", "-m", "a");
const WT = path.join(REPO, ".worktrees", "w1");
g(REPO, "worktree", "add", "-q", "-b", "w1", WT);
const COMMON = fs.realpathSync(path.join(REPO, ".git"));
L.pinProject(REPO, COMMON);
const GD = path.join(COMMON, "worktrees", "w1"), INDEX = path.join(GD, "index");
// every tracked file's mtime moved, so each entry in the index is stat-dirty and git diff would rewrite it
let clock = Math.floor(Date.now() / 1000) - 100000;
const dirty = () => { clock += 10; for (const f of FILES) fs.utimesSync(path.join(WT, f), clock, clock); };
const leftovers = () => fs.readdirSync(TMP).filter((n) => n.startsWith("proteus-index-"));

(async () => {
  dirty();
  const before = fs.readFileSync(INDEX);
  const clean = L.treeChanges(WT);
  ok("treeChanges: a stat-dirty but unchanged checkout has no changes", Array.isArray(clean) && !clean.length, JSON.stringify(clean));
  ok("treeChanges: git rewrote only the copy, the checkout's index is byte for byte as it was", fs.readFileSync(INDEX).equals(before));
  fs.writeFileSync(path.join(WT, "f1.txt"), "changed\n");
  fs.writeFileSync(path.join(WT, "new.txt"), "new\n");
  const seen = L.treeChanges(WT);
  ok("treeChanges: a modified and an untracked file are reported", Array.isArray(seen) && seen.includes(" M f1.txt") && seen.includes("?? new.txt"), JSON.stringify(seen));
  const a = await L.treeChangesAsync(WT);
  ok("treeChangesAsync: the same, on its own copy", JSON.stringify(a) === JSON.stringify(seen), JSON.stringify(a));
  g(WT, "checkout", "-q", "--", "f1.txt");
  fs.rmSync(path.join(WT, "new.txt"));

  if (process.platform !== "win32") {
    // the index itself a link (to a real index elsewhere) or a FIFO: no copy, no git, no changes known
    const real = path.join(W, "elsewhere-index");
    fs.renameSync(INDEX, real);
    fs.symlinkSync(real, INDEX);
    ok("treeChanges: an index that is a link is not read, and no changes are known", L.treeChanges(WT) === null);
    fs.unlinkSync(INDEX);
    require("child_process").execFileSync("mkfifo", [INDEX]);
    ok("treeChanges: an index that is a FIFO is not opened, and no changes are known", L.treeChanges(WT) === null);
    fs.unlinkSync(INDEX);
    fs.renameSync(real, INDEX);
  }

  // the flipper: worktrees/w1 swapped for a link to a victim dir, back and forth, while treeChanges runs. The victim
  // holds what git reads there (gitdir, HEAD, a stat-dirty index), so git on the old path read and rewrote it whenever
  // the swap held across its read and its lock
  const VICTIM = path.join(W, "victim"), LNK = path.join(W, "w1-link"), ASIDE = path.join(W, "w1-aside");
  fs.mkdirSync(VICTIM);
  for (const f of ["gitdir", "HEAD", "index"]) fs.copyFileSync(path.join(GD, f), path.join(VICTIM, f));
  if (link(VICTIM, LNK, "dir")) {
    const was = snap(VICTIM);
    const STOP = path.join(W, "flip-stop"), DONE = path.join(W, "flip-done");
    const flip = `const fs = require("fs"); const [d, l, t, stop, done] = process.argv.slice(1);
      const mv = (a, b) => { try { fs.renameSync(a, b); return true; } catch { return false; } };
      let n = 0;
      while (!fs.existsSync(stop)) { if (mv(d, t) && mv(l, d)) n++; const w = Date.now() + 2; while (Date.now() < w) {} mv(d, l); mv(t, d); }
      fs.writeFileSync(done, String(n));`;
    const child = require("child_process").spawn(process.execPath, ["-e", flip, GD, LNK, ASIDE, STOP, DONE], { stdio: "ignore" });
    const runs = [];
    for (let i = 0; i < 60; i++) { dirty(); runs.push(L.treeChanges(WT) === null ? "x" : "ok"); }
    fs.writeFileSync(STOP, "");
    for (let i = 0; i < 100 && !fs.existsSync(DONE); i++) nap(50);
    child.kill();
    if (isLink(GD)) fs.renameSync(GD, LNK); // the flipper stopped mid-swap
    if (!fs.existsSync(GD) && fs.existsSync(ASIDE)) fs.renameSync(ASIDE, GD);
    const flips = fs.existsSync(DONE) ? Number(fs.readFileSync(DONE, "utf8")) : 0;
    ok(`flipper: swapped worktrees/w1 for a link to the victim while treeChanges ran (${flips} flips, ${runs.filter((r) => r === "ok").length}/60 runs answered)`, flips > 0);
    ok("flipper: the victim dir is unchanged, no index or lock written there", snap(VICTIM) === was, fs.readdirSync(VICTIM).join(" "));
    ok("flipper: the worktree's own git dir is back in place", !isLink(GD) && fs.existsSync(INDEX));
  } else ok("flipper: skipped (no symlink, or Windows)", true);

  ok("treeChanges: every private copy is deleted afterwards", !leftovers().length, leftovers().join(" "));
  lib.summary();
})();
