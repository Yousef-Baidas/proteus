// Gate cache tests: node tests/gates.test.js (needs git). proteus-gates-cache.js runs a gate once per clean tree
// and command, replays a pass, never stores a failure, and runs uncached on a dirty checkout. No network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GC = path.join(ROOT, "templates", "hooks", "proteus-gates-cache.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("gates");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, "sub"));
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
fs.writeFileSync(path.join(REPO, "sub", "b.txt"), "b\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

// a gate that counts its runs in a file outside the repo and exits with EXIT (default 0)
const CNT = path.join(W, "runs.txt");
const GATE = `node -e "require('fs').appendFileSync(process.env.CNT,'x');console.log('suite ok '+process.env.TAG);process.exit(+process.env.EXIT||0)"`;
const runs = () => { try { return fs.readFileSync(CNT, "utf8").length; } catch { return 0; } };
const gate = (cwd = REPO, env = {}, cmd = GATE) => lib.run(GC, "", { cwd, env: { CNT, TAG: "t1", ...env }, args: [cmd] });
const store = path.join(REPO, ".git", "proteus", "gates");
const stored = () => { try { return fs.readdirSync(store).length; } catch { return 0; } };

let r = gate();
ok("miss: runs the gate, passes its output and exit code through, stores the pass", r.code === 0 && /suite ok t1/.test(r.out) && runs() === 1 && stored() === 1, r.out + r.err);
r = gate(REPO, { TAG: "t2" });
ok("hit: same tree and command runs nothing, replays the stored tail, exits 0", r.code === 0 && runs() === 1 && /suite ok t1/.test(r.out) && /gates-cache: hit, passed on tree [0-9a-f]{12}/.test(r.out), r.out + r.err);
r = gate(REPO, {}, GATE + " ");
ok("hit: surrounding whitespace is not part of the key", runs() === 1 && r.code === 0, r.out);

r = gate(REPO, {}, GATE + " && echo more");
ok("miss: a different command runs", runs() === 2 && r.code === 0 && stored() === 2, r.out + r.err);
r = gate(path.join(REPO, "sub"));
ok("miss: the same command from another directory of the repo runs", runs() === 3 && stored() === 3, r.out + r.err);

const failing = GATE + " && echo unreached";
r = gate(REPO, { EXIT: "3" }, failing);
const r2 = gate(REPO, { EXIT: "3" }, failing);
ok("failure: exit code passed through and never stored, so it runs again", r.code === 3 && r2.code === 3 && runs() === 5 && stored() === 3, `${r.code} ${r2.code} ${runs()} ${stored()}`);

fs.writeFileSync(path.join(REPO, "new.txt"), "untracked\n");
r = gate();
ok("dirty: an untracked file runs uncached, says so, stores nothing", runs() === 6 && /uncommitted or untracked/.test(r.err) && stored() === 3, r.err);
r = gate();
ok("dirty: and runs again next time", runs() === 7, r.err);
fs.rmSync(path.join(REPO, "new.txt"));
fs.writeFileSync(path.join(REPO, "a.txt"), "changed\n");
r = gate();
ok("dirty: a modified tracked file runs uncached", runs() === 8 && stored() === 3, r.err);
g(REPO, "commit", "-qam", "change");
r = gate();
ok("new tree: a commit that changes the tree runs the gate again", runs() === 9 && stored() === 4 && r.code === 0, r.err);

const touch = `node -e "require('fs').appendFileSync(process.env.CNT,'x');require('fs').writeFileSync('a.txt','by the gate\\n')"`;
r = gate(REPO, {}, touch);
const dirtyAfter = g(REPO, "status", "--porcelain");
ok("changed by the gate: a pass that leaves the tree changed is not stored", r.code === 0 && runs() === 10 && stored() === 4 && /a\.txt/.test(dirtyAfter), dirtyAfter);
g(REPO, "checkout", "--", "a.txt");

const WT = path.join(W, "wt");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT);
r = gate(WT, { TAG: "wt" });
ok("worktree: another worktree on the same tree shares the pass", runs() === 10 && r.code === 0 && /suite ok t1/.test(r.out), r.out + r.err);
fs.writeFileSync(path.join(WT, "w.txt"), "w\n");
g(WT, "add", "w.txt"); g(WT, "commit", "-qm", "wt");
r = gate(WT, { TAG: "wt" });
ok("worktree: its own commit is a new tree, stored in the shared common dir", runs() === 11 && stored() === 5 && /suite ok wt/.test(r.out), r.err);

r = gate(REPO, { PROTEUS_GATES_CACHE: "0" });
ok("PROTEUS_GATES_CACHE=0 runs uncached", runs() === 12 && stored() === 5 && r.code === 0, r.err);

const PLAIN = path.join(W, "plain");
fs.mkdirSync(PLAIN);
r = gate(PLAIN, { EXIT: "4" });
ok("outside a repo: runs, exit code passed through, no note", runs() === 13 && r.code === 4 && !/gates-cache/.test(r.err), r.err);

// a worker's worktree gets the script, so `node <hooks>/proteus-gates-cache.js` works from there on both CLIs
const SRC = path.dirname(GC);
for (const cli of ["claude", "codex"]) {
  const ad = require(path.join(SRC, `proteus-harness-${cli}.js`));
  const wt = path.join(W, `prep-${cli}`);
  fs.mkdirSync(path.join(wt, ".claude"), { recursive: true });
  ad.prepareWorker(wt, SRC);
  ok(`worktree hooks (${cli}): the gates cache is copied`, fs.existsSync(path.join(ad.hooksDir(wt), "proteus-gates-cache.js")));
}

ok("usage: no command exits 2", lib.run(GC, "", { cwd: REPO }).code === 2);

lib.summary();
