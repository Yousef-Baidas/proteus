// proteus-confine.js (#104), the one guard for install.js, link-skills.js and install-lead-hooks.js: a path is
// confined to a root when no component between them is a link; kinds; a link removed, never followed; writes
// through a link refused; install-lead-hooks names the link it refuses and says what to do, and removes the
// skipped files itself; --project copies the module beside teams/link-skills.js; the migration report
// promises no retry for an entry that is never moved. Temp dirs only; no network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = fs.realpathSync(lib.workdir("confine"));
const C = require(path.join(SRC, "proteus-confine.js"));
const WIN = process.platform === "win32";
const dirLink = (target, link) => fs.symlinkSync(target, link, "junction");

// ---- refusal and remove
{
  const root = path.join(W, "r", "root"), out = path.join(W, "r", "out");
  for (const d of [path.join(root, "a"), out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, "a", "f"), "x");
  fs.writeFileSync(path.join(out, "f"), "keep");
  dirLink(out, path.join(root, "via"));
  ok("refusal: a file under the root is confined", C.refusal(path.join(root, "a", "f"), [root]) === null);
  ok("refusal: a path outside every root is refused", /outside/.test(C.refusal(path.join(out, "f"), [root]) || ""));
  ok("refusal: a link between the root and the path refuses it, naming the link", (C.refusal(path.join(root, "via", "f"), [root]) || "").includes(path.join(root, "via")));
  ok("refusal: a file is not a link", C.refusal(path.join(root, "a", "f"), [root], "link") === "not a link");
  ok("refusal: a directory is not a regular file", C.refusal(path.join(root, "a"), [root], "file") === "not a regular file");
  ok("refusal: a path not made yet under a root not made yet is confined", C.refusal(path.join(root, "new", "x", "f"), [path.join(root, "new")]) === null);
  const fileRoot = path.join(root, "a", "f");
  ok("refusal: a file root confines that file alone", C.refusal(fileRoot, [fileRoot]) === null && C.refusal(path.join(root, "a", "g"), [fileRoot]) !== null);
  ok("remove: a link through a link on the way is refused and kept", !C.remove(path.join(root, "via", "f"), [root]) && fs.existsSync(path.join(out, "f")));
  ok("remove: the link itself goes, never what it points to", C.remove(path.join(root, "via"), [root], "link") && !C.lstat(path.join(root, "via")) && fs.readFileSync(path.join(out, "f"), "utf8") === "keep");
  ok("remove: kind file refuses a directory", !C.remove(path.join(root, "a"), [root], "file") && fs.existsSync(path.join(root, "a", "f")));
  if (!WIN && spawnSync("mkfifo", [path.join(root, "fifo")]).status === 0) {
    ok("remove: a FIFO is neither file, directory nor link: refused", !C.remove(path.join(root, "fifo"), [root]) && !!C.lstat(path.join(root, "fifo")));
  }
}

// ---- writeFile and ownDir
{
  const root = path.join(W, "w", "root"), out = path.join(W, "w", "out");
  for (const d of [root, out]) fs.mkdirSync(d, { recursive: true });
  dirLink(out, path.join(root, "via"));
  ok("writeFile: nothing is written through a link on the way", !C.writeFile(path.join(root, "via", "f"), "x", [root]) && !fs.existsSync(path.join(out, "f")));
  ok("writeFile: missing dirs under the root are made", C.writeFile(path.join(root, "d", "e", "f"), "x", [root]) && fs.readFileSync(path.join(root, "d", "e", "f"), "utf8") === "x");
  ok("writeFile: outside every root is refused", !C.writeFile(path.join(out, "g"), "x", [root]) && !fs.existsSync(path.join(out, "g")));
  fs.writeFileSync(path.join(out, "target"), "keep");
  let made = false;
  try { fs.symlinkSync(path.join(out, "target"), path.join(root, "fl")); made = true; } catch {}
  if (made) ok("writeFile: a link at the path is replaced, its target kept", C.writeFile(path.join(root, "fl"), "new", [root]) && !C.lstat(path.join(root, "fl")).isSymbolicLink() && fs.readFileSync(path.join(out, "target"), "utf8") === "keep");
  ok("ownDir: a link among the segs is refused, and blocker names it", C.ownDir(root, ["via", "x"]) === null && C.blocker(root, ["via", "x"]) === path.join(root, "via"));
  ok("ownDir: real segs (made when asked) resolve", C.ownDir(root, ["m", "n"], true) === path.join(root, "m", "n"));
}

// ---- install-lead-hooks: an actionable refusal; removes the adapter's skipped files with no installer help
{
  const repo = path.join(W, "ilh", "repo"), out = path.join(W, "ilh", "out");
  for (const d of [repo, out]) fs.mkdirSync(d, { recursive: true });
  dirLink(out, path.join(repo, ".claude"));
  let r = lib.run(path.join(SRC, "install-lead-hooks.js"), "", { cwd: repo });
  ok("install-lead-hooks: a linked .claude is refused, named, with what to do", r.code === 1 && r.err.includes(path.join(fs.realpathSync(repo), ".claude")) && /Replace .* with a real directory, then re-run node /.test(r.err), r.out + r.err);
  ok("install-lead-hooks: nothing is written through the link", fs.readdirSync(out).length === 0, fs.readdirSync(out).join());
  fs.unlinkSync(path.join(repo, ".claude"));
  const cxd = path.join(repo, ".codex", "hooks");
  fs.mkdirSync(cxd, { recursive: true });
  fs.writeFileSync(path.join(cxd, "proteus-statusline.js"), "// older install\n");
  r = lib.run(path.join(SRC, "install-lead-hooks.js"), "", { cwd: repo, env: { PROTEUS_HARNESS: "codex", PROTEUS_KEEP_SKIPPED: "1" } });
  ok("install-lead-hooks: a skipped file an older install left is removed, PROTEUS_KEEP_SKIPPED or not", r.code === 0 && /1 unused removed/.test(r.out) && !fs.existsSync(path.join(cxd, "proteus-statusline.js")), r.out + r.err);
  ok("install-lead-hooks: the module is copied with the other hooks", fs.existsSync(path.join(cxd, "proteus-confine.js")));
}

// ---- link-skills: runs with the module beside it (a repo's teams/) and with it in ../hooks (the checkout)
{
  const repo = path.join(W, "ls", "repo");
  fs.mkdirSync(path.join(repo, "teams", "a"), { recursive: true });
  fs.writeFileSync(path.join(repo, "teams", "a", "skills.txt"), "x/y missing-skill\n");
  fs.copyFileSync(path.join(ROOT, "templates", "teams", "link-skills.js"), path.join(repo, "teams", "link-skills.js"));
  fs.copyFileSync(path.join(SRC, "proteus-confine.js"), path.join(repo, "teams", "proteus-confine.js"));
  let r = lib.run(path.join(repo, "teams", "link-skills.js"), "", { cwd: repo });
  ok("link-skills: with proteus-confine.js beside it, it runs", r.code === 0 && /teams\/a -> 0 skills linked/.test(r.out), r.out + r.err);
  r = lib.run(path.join(ROOT, "templates", "teams", "link-skills.js"), "", { cwd: repo });
  ok("link-skills: the checkout's copy finds the module in ../hooks", r.code === 0 && /teams\/a -> 0 skills linked/.test(r.out), r.out + r.err);
  const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");
  ok("install.js copies proteus-confine.js beside teams/link-skills.js", /LINK_SCRIPTS = \[[^\]]*"proteus-confine\.js"/.test(inst));
}

lib.summary();
