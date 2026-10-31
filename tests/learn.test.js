// Learning workspace tests (#84): node tests/learn.test.js. proteus-learn.js keeps <root>/learn for the teach hand-off:
// path, prepare, seed, status and seen from any cwd in the repo, a linked worktree too; the workspace goes in
// info/exclude once, a link at learn or at info/exclude is refused, a seeded file is never overwritten, the record walk
// skips links and stays in one folder, a malformed seen file reads as nothing read, and outside a repo it refuses.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "templates", "hooks", "proteus-learn.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("learn");

let n = 0;
const repo = () => {
  const d = path.join(W, `repo${++n}`);
  fs.mkdirSync(path.join(d, "sub", "deeper"), { recursive: true });
  g(d, "init", "-q");
  return d;
};
const cli = (cwd, ...args) => lib.run(SCRIPT, "", { cwd, args });
const EXCL = (d) => path.join(d, ".git", "info", "exclude");
const SEEN = (d) => path.join(d, ".git", "proteus", "learn-seen.json");
const REC = (d) => path.join(d, "learn", "learning-records");
const count = (s, line) => s.split(/\r?\n/).filter((l) => l === line).length;
const draft = (name, body) => { const f = path.join(W, name); fs.writeFileSync(f, body); return f; };
const link = (target, at, type) => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };

// --help and usage
let R = repo();
let r = cli(R, "--help");
ok("--help: prints the usage, exit 0", r.code === 0 && /^usage: /.test(r.out), r.out + r.err);
r = cli(R, "nonsense");
ok("usage: an unknown command exits 2", r.code === 2 && /^usage: /.test(r.err), r.err);
r = cli(R, "seed");
ok("usage: seed with no flag exits 2", r.code === 2, r.err);
r = cli(R, "seed", "--mission");
ok("usage: a flag with no value exits 2", r.code === 2, r.err);
r = cli(R, "seed", "--other", "x");
ok("usage: an unknown flag exits 2", r.code === 2, r.err);
ok("usage: a refused call writes nothing", !fs.existsSync(path.join(R, "learn")));

// path
r = cli(path.join(R, "sub", "deeper"), "path");
ok("path: <root>/learn from a subdir, nothing created", r.code === 0 && r.out.trim() === path.join(R, "learn") && !fs.existsSync(path.join(R, "learn")), r.out + r.err);

// status with no workspace
r = cli(R, "status");
ok("status: learn none with no workspace", r.code === 0 && r.out === "learn none\n", r.out + r.err);

// prepare
r = cli(path.join(R, "sub"), "prepare");
ok("prepare: makes the folder and says so", r.code === 0 && r.out === `learn ready ${path.join(R, "learn")}\n` && fs.statSync(path.join(R, "learn")).isDirectory(), r.out + r.err);
ok("prepare: adds the exclude line", count(fs.readFileSync(EXCL(R), "utf8"), "/learn/") === 1);
r = cli(R, "prepare");
ok("prepare: a second run adds no second line", r.code === 0 && count(fs.readFileSync(EXCL(R), "utf8"), "/learn/") === 1, r.out + r.err);
fs.writeFileSync(path.join(R, "learn", "x.md"), "x\n");
ok("prepare: git does not see the folder", !g(R, "status", "--porcelain").includes("learn"));
ok("prepare: no tracked ignore file is written", !fs.existsSync(path.join(R, ".gitignore")));

// an exclude file with no final newline, and CRLF lines
R = repo();
fs.mkdirSync(path.dirname(EXCL(R)), { recursive: true });
fs.writeFileSync(EXCL(R), "/other/");
cli(R, "prepare");
ok("prepare: an unterminated last line stays its own line", fs.readFileSync(EXCL(R), "utf8") === "/other/\n/learn/\n", fs.readFileSync(EXCL(R), "utf8"));
fs.writeFileSync(EXCL(R), "/learn/\r\n");
cli(R, "prepare");
ok("prepare: a CRLF line counts as present", fs.readFileSync(EXCL(R), "utf8") === "/learn/\r\n");

// no info dir at all
R = repo();
fs.rmSync(path.join(R, ".git", "info"), { recursive: true, force: true });
r = cli(R, "prepare");
ok("prepare: makes a missing info dir", r.code === 0 && count(fs.readFileSync(EXCL(R), "utf8"), "/learn/") === 1, r.out + r.err);

// a file at learn
R = repo();
fs.writeFileSync(path.join(R, "learn"), "x");
r = cli(R, "prepare");
ok("prepare: a file at learn is refused with a reason", r.code === 1 && /not a directory/.test(r.err) && !/\bat .*\.js:\d+/.test(r.err), r.err);

// links
{
  R = repo();
  const away = path.join(W, `away${n}`);
  fs.mkdirSync(away);
  if (link(away, path.join(R, "learn"), "junction")) {
    r = cli(R, "prepare");
    ok("prepare: a link at learn is refused with a reason", r.code === 1 && /is a link/.test(r.err), r.err);
    r = cli(R, "seed", "--mission", draft("m0.md", "m\n"));
    ok("seed: a link at learn is refused, nothing written through it", r.code === 1 && !fs.readdirSync(away).length, r.err);
    r = cli(R, "status");
    ok("status: a link at learn reads as no workspace", r.code === 0 && r.out === "learn none\n", r.out + r.err);
    r = cli(R, "seen");
    ok("seen: a link at learn writes nothing", r.code === 0 && r.out === "learn none\n" && !fs.existsSync(SEEN(R)), r.out + r.err);
  } else ok("links: skipped, no symlinks here", true);

  R = repo();
  const target = path.join(W, `target${n}`);
  fs.writeFileSync(target, "keep\n");
  fs.mkdirSync(path.dirname(EXCL(R)), { recursive: true });
  fs.rmSync(EXCL(R), { force: true });
  if (link(target, EXCL(R))) {
    r = cli(R, "prepare");
    ok("prepare: a link at info/exclude is refused with a reason", r.code === 1 && /exclude is a link/.test(r.err), r.err);
    ok("prepare: nothing written through the link", fs.readFileSync(target, "utf8") === "keep\n");
    ok("prepare: the link stays a link", fs.lstatSync(EXCL(R)).isSymbolicLink());
  } else ok("links: skipped, no file symlinks here", true);

  R = repo();
  const info = path.join(W, `info${n}`);
  fs.mkdirSync(info);
  fs.rmSync(path.join(R, ".git", "info"), { recursive: true, force: true });
  if (link(info, path.join(R, ".git", "info"), "junction")) {
    r = cli(R, "prepare");
    ok("prepare: a link at info/ is refused", r.code === 1 && !fs.readdirSync(info).length, r.err);
  } else ok("links: skipped, no dir symlinks here", true);
}

// seed
R = repo();
const m1 = draft("m1.md", "mission one\n"), r1 = draft("r1.md", "resources one\n"), g1 = draft("g1.md", "glossary one\n");
r = cli(path.join(R, "sub"), "seed", "--mission", m1, "--glossary", g1);
ok("seed: a subset writes those files, prepares first, and says so", r.code === 0 && r.out === `learn ready ${path.join(R, "learn")}\nseeded MISSION.md\nseeded GLOSSARY.md\n` && fs.readFileSync(path.join(R, "learn", "MISSION.md"), "utf8") === "mission one\n" && fs.readFileSync(path.join(R, "learn", "GLOSSARY.md"), "utf8") === "glossary one\n" && !fs.existsSync(path.join(R, "learn", "RESOURCES.md")), r.out + r.err);
ok("seed: adds the exclude line", count(fs.readFileSync(EXCL(R), "utf8"), "/learn/") === 1);
fs.writeFileSync(path.join(R, "learn", "MISSION.md"), "the skill's own\n");
r = cli(R, "seed", "--mission", draft("m2.md", "mission two\n"), "--resources", r1);
ok("seed: an existing file stays untouched and is named kept", r.code === 0 && /^kept MISSION\.md$/m.test(r.out) && /^seeded RESOURCES\.md$/m.test(r.out) && fs.readFileSync(path.join(R, "learn", "MISSION.md"), "utf8") === "the skill's own\n", r.out + r.err);
ok("seed: leaves no temp file", !fs.readdirSync(path.join(R, "learn")).some((f) => f.endsWith(".tmp")));
r = cli(R, "seed", "--glossary", path.join(W, "absent.md"));
ok("seed: an unreadable draft exits 1 with a reason", r.code === 1 && /cannot read/.test(r.err) && !/\bat .*\.js:\d+/.test(r.err), r.err);
{
  const P = repo();
  r = cli(P, "seed", "--mission", m1, "--glossary", path.join(W, "absent.md"));
  ok("seed: one bad draft writes nothing at all", r.code === 1 && !fs.existsSync(path.join(P, "learn")), r.err);
  fs.mkdirSync(path.join(P, "learn"));
  const out = path.join(W, `out${n}`);
  if (link(out, path.join(P, "learn", "MISSION.md"))) {
    r = cli(P, "seed", "--mission", m1);
    ok("seed: a dangling link at a seed name is kept, never written through", r.code === 0 && /^kept MISSION\.md$/m.test(r.out) && !fs.existsSync(out), r.out + r.err);
  } else ok("links: skipped, no file symlinks here", true);
}

// status and seen
R = repo();
cli(R, "prepare");
r = cli(R, "status");
ok("status: an empty workspace has no records", r.out === "learn records=0 new=0\n", r.out);
fs.mkdirSync(REC(R));
fs.writeFileSync(path.join(REC(R), "0001-a.md"), "# a\n");
fs.writeFileSync(path.join(REC(R), "0002-b.md"), "# b\n");
fs.writeFileSync(path.join(REC(R), "notes.txt"), "x\n");
fs.mkdirSync(path.join(REC(R), "nested.md"));
fs.writeFileSync(path.join(REC(R), "nested.md", "0003-c.md"), "# c\n");
fs.writeFileSync(path.join(R, "learn", "0004-outside.md"), "# d\n");
r = cli(path.join(R, "sub"), "status");
ok("status: counts learning-records/*.md files only, one folder deep", r.out === "learn records=2 new=2\n", r.out + r.err);
r = cli(R, "seen");
ok("seen: then new=0", r.code === 0 && r.out === "learn records=2 new=0\n", r.out + r.err);
ok("seen: stored under the state dir", JSON.parse(fs.readFileSync(SEEN(R), "utf8")).seen.join() === "0001-a.md,0002-b.md");
fs.writeFileSync(path.join(REC(R), "0005-e.md"), "# e\n");
r = cli(R, "status");
ok("status: a later record is new", r.out === "learn records=3 new=1\n", r.out);
if (link(path.join(REC(R), "0001-a.md"), path.join(REC(R), "0006-link.md"))) {
  r = cli(R, "status");
  ok("status: a link in the records folder is skipped", r.out === "learn records=3 new=1\n", r.out);
} else ok("links: skipped, no file symlinks here", true);

// malformed seen files
for (const [why, body] of [["garbage", "{ not json"], ["an array", "[1]"], ["a wrong type", '{"seen":"0001-a.md"}']]) {
  fs.writeFileSync(SEEN(R), body);
  r = cli(R, "status");
  ok(`seen file with ${why}: counts as nothing read, no stack`, r.code === 0 && /^learn records=\d+ new=\d+\n$/.test(r.out) && !r.err, r.out + r.err);
  ok(`seen file with ${why}: every record is new`, (([a, b]) => a === b)(/records=(\d+) new=(\d+)/.exec(r.out).slice(1)), r.out);
}
fs.writeFileSync(SEEN(R), JSON.stringify({ seen: [1, null, "../0001-a.md", "0001-a.md", "0002-b.md"] }));
r = cli(R, "status");
ok("seen file: invalid entries dropped, valid ones kept", r.out === "learn records=3 new=1\n", r.out);
fs.writeFileSync(SEEN(R), "x".repeat((1 << 20) + 1));
r = cli(R, "status");
ok("seen file: an oversized file counts as nothing read", r.code === 0 && !r.err, r.err);
fs.rmSync(SEEN(R));
fs.mkdirSync(SEEN(R));
r = cli(R, "seen");
ok("seen: a write that fails exits 1 with a reason, no stack", r.code === 1 && /^proteus-learn: /.test(r.err) && !/\bat .*\.js:\d+/.test(r.err), r.out + r.err);
fs.rmdirSync(SEEN(R));

// the walk's cap
{
  const P = repo();
  cli(P, "prepare");
  fs.mkdirSync(REC(P));
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(REC(P), `${i}.md`), "");
  r = cli(P, "status");
  ok("status: the walk stops at 1000 files", r.out === "learn records=1000 new=1000\n", r.out);
}

// a linked worktree resolves to the main checkout
{
  const P = repo();
  g(P, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
  const wt = path.join(W, `wt${n}`);
  g(P, "worktree", "add", "-q", wt);
  r = cli(wt, "path");
  ok("path: from a linked worktree, the main checkout's folder", r.out.trim() === path.join(P, "learn"), r.out + r.err);
  r = cli(wt, "prepare");
  ok("prepare: from a linked worktree, the main checkout's folder and exclude", r.code === 0 && fs.existsSync(path.join(P, "learn")) && !fs.existsSync(path.join(wt, "learn")) && count(fs.readFileSync(EXCL(P), "utf8"), "/learn/") === 1, r.out + r.err);
}

// outside a repo
{
  const out = path.join(W, "plain");
  fs.mkdirSync(out);
  for (const c of ["path", "prepare", "status", "seen"]) {
    r = cli(out, c);
    ok(`${c}: outside a repo exits 1 with a reason`, r.code === 1 && r.err === "proteus-learn: not inside a git repository\n", r.out + r.err);
  }
  r = cli(out, "seed", "--mission", m1);
  ok("seed: outside a repo exits 1 with a reason", r.code === 1 && /not inside a git repository/.test(r.err), r.err);
}

lib.summary();
