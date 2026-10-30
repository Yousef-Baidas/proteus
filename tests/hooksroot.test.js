// One hooks dir per session (#277): node tests/hooksroot.test.js (needs git). The autostart records the realpath of
// the dir it runs from in <common>/proteus-lead/hooks-root and names it on the state line; the four scripts that post
// or record for the human's gate refuse to run from any other copy, and run unchecked when there is no record (CI).
// Temp repos, a copy of the hooks dir and the fake gh; never the network.
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("hooksroot");
const L = require(path.join(SRC, "proteus-lib.js"));
const REAL = fs.realpathSync.native(SRC);
const SCRIPTS = { "proteus-signoff.js": [], "proteus-verdict.js": [], "proteus-merge.js": [], "proteus-gh.js": ["issue", "comment", "5", "--body", "x"] };
const NOT_OURS = /this is not the session's Proteus/;

const repo = (name) => {
  const d = path.join(W, name);
  fs.mkdirSync(path.join(d, ".claude", "skills", "proteus"), { recursive: true });
  fs.writeFileSync(path.join(d, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
  g(W, "init", "-q", "-b", "main", d);
  return d;
};
// stale copies: the project's teams/templates/hooks, and an old plugin cache (a tree with .claude-plugin, which
// lib.homeOnly lets through)
const copy = (dir) => { fs.cpSync(SRC, dir, { recursive: true }); return dir; };
const OTHER = copy(path.join(W, "teams", "templates", "hooks"));
const CACHE = path.join(W, "cache", "proteus", "0ld");
copy(path.join(CACHE, "templates", "hooks"));
fs.mkdirSync(path.join(CACHE, ".claude-plugin"));
fs.writeFileSync(path.join(CACHE, ".claude-plugin", "plugin.json"), "{}\n");
const STALE = [OTHER, path.join(CACHE, "templates", "hooks")];
const start = (cwd) => lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd }, { cwd, env: { FAKE_GH_VISIBILITY: "PRIVATE" } });
let k = 0;
const runIn = (dir, script, cwd) => lib.run(path.join(dir, script), "", { cwd, args: SCRIPTS[script], env: { FAKE_GH_LIMIT: "0", FAKE_GH_LIMIT_FILE: path.join(W, `n${++k}`) } });

// the autostart writes the record and the state line names exactly that path
const REPO = repo("repo");
const REC = path.join(REPO, ".git", "proteus-lead", "hooks-root");
let r = start(REPO);
const line = r.out.split("\n").find((l) => l.startsWith("proteus-state")) || "";
ok("autostart: exits 0", r.code === 0, r.err);
ok("autostart: records its hooks dir's realpath in proteus-lead/hooks-root", fs.existsSync(REC) && fs.readFileSync(REC, "utf8").trim() === REAL, fs.existsSync(REC) ? fs.readFileSync(REC, "utf8") : "no record");
ok("autostart: the state line names hooks=<that path>", line.includes(` hooks=${REAL} `), line);

// with a record: each gate script refuses from another dir, naming the session's copy, and runs from the recorded one
for (const s of Object.keys(SCRIPTS)) {
  for (const d of STALE) {
    r = runIn(d, s, REPO);
    ok(`${s}: refused from ${path.relative(W, d)}, exit 1, naming the session's copy`, r.code === 1 && r.err.trim() === `proteus: this is not the session's Proteus (${fs.realpathSync.native(d)}); use ${path.join(REAL, s)}`, `${r.code} ${r.err}`);
  }
  r = runIn(SRC, s, REPO);
  ok(`${s}: runs from the recorded dir`, !NOT_OURS.test(r.err) && (s === "proteus-gh.js" ? r.code === 0 : r.code === 2), `${r.code} ${r.err}`);
}

// a worktree of the same repo reads the same record
g(REPO, "commit", "-q", "--allow-empty", "--no-verify", "-m", "a");
const WT = path.join(REPO, ".worktrees", "t1");
g(REPO, "worktree", "add", "-q", "-b", "t1", WT);
r = runIn(OTHER, "proteus-signoff.js", WT);
ok("from a linked worktree: the main checkout's record applies", r.code === 1 && NOT_OURS.test(r.err), `${r.code} ${r.err}`);

// no record (CI, no session): no check, so CI's teams/templates/hooks keeps working
const BARE = repo("norecord");
for (const s of Object.keys(SCRIPTS)) {
  r = runIn(STALE[1], s, BARE);
  ok(`${s}: no record, runs from another copy`, !NOT_OURS.test(r.err) && (s === "proteus-gh.js" ? r.code === 0 : r.code === 2), `${r.code} ${r.err}`);
}

// the record goes through the lead-write helper: a link at its name or at proteus-lead never writes through
const link = (target, at, type) => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const OUT = path.join(W, "outside");
fs.mkdirSync(OUT);
const VICTIM = path.join(OUT, "victim.txt");
fs.writeFileSync(VICTIM, "original\n");
const LR = repo("linkrec");
const common = path.join(LR, ".git");
L.leadDir(common);
const at = L.leadPath(common, "hooks-root");
if (link(VICTIM, at, "file")) {
  let threw = null;
  try { L.recordHooksRoot(common); } catch (e) { threw = e; }
  ok("record a link: the link's target is untouched", fs.readFileSync(VICTIM, "utf8") === "original\n" && !threw, threw && threw.message);
  ok("record a link: replaced by a regular file", fs.lstatSync(at).isFile() && fs.readFileSync(at, "utf8").trim() === REAL);
} else ok("record a link: skipped (no symlink here)", true);
const LD = repo("linkdir");
if (link(OUT, path.join(LD, ".git", "proteus-lead"), "dir")) {
  let code = "";
  try { L.recordHooksRoot(path.join(LD, ".git")); } catch (e) { code = e.code; }
  ok("proteus-lead a link: the record is refused", code === "ELEADSTATE" && !fs.existsSync(path.join(OUT, "hooks-root")), code);
  r = start(LD);
  ok("proteus-lead a link: the autostart still exits 0 and writes nothing through it", r.code === 0 && !fs.existsSync(path.join(OUT, "hooks-root")), r.err);
} else ok("proteus-lead a link: skipped (no symlink here)", true);

lib.summary();
