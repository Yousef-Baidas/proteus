// Installer write and delete confinement (#104): the one guard install.js, teams/link-skills.js and
// install-lead-hooks.js put every delete, and every write that could land through a link, behind.
// A root is a resolved path its caller owns (a link above it is the user's choice): install.js's
// allowedRoots, or ownDir(base, segs) with each seg below base lstat'd a real directory. A path is
// confined to a root when it is under it and no component between the root and the path is a link;
// the path itself may be a link, which is removed, never followed. A root that is a file
// (~/.claude/proteus.json) confines that file alone; a root directory is never removed itself. Nothing in the
// user's real home is touched while HOME points elsewhere. install.js --project copies it into teams/
// beside link-skills.js, which finds it there, or in ../hooks in the Proteus checkout. refusal, remove
// and writeFile never throw.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const WIN = process.platform === "win32";
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function real(p) { try { return fs.realpathSync(p); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
// whether two paths name one file: resolved, so a trailing or doubled separator does not count; on Windows either
// separator and any case, on macOS any case (both resolve /Users/Me and /users/me alike by default). The one
// samePath: install.js, link-skills.js and the hooks all take it from here; platform is for tests.
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const p = platform === "win32" ? path.win32 : path.posix, fold = platform === "win32" || platform === "darwin";
  const key = (x) => (fold ? p.resolve(String(x)).toLowerCase() : p.resolve(String(x)));
  return key(a) === key(b);
}
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
// realpath of the deepest existing ancestor, the rest joined on: a path that does not exist yet resolves too
const realish = (p) => { const a = path.resolve(p), r = real(a); if (r) return r; const d = path.dirname(a); return d === a ? a : path.join(realish(d), path.basename(a)); };
const userHome = () => { try { return realish(os.userInfo().homedir); } catch { return null; } };
// Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude (here: install.js, link-skills.js and the hooks all load this file)
const claudeDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
// install.js --sandbox (#188): a repo's key (its git common dir, hashed) and the dir its copy of
// proteus-worktree.js and the hooks beside it go in. That copy runs outside the sandbox, so it sits outside every
// path the sandbox lets agents write, and the in-repo proteus-worktree.js names it once a worktree is prepared.
const sandboxKey = (common) => require("crypto").createHash("sha256").update(real(common) || path.resolve(common)).digest("hex").slice(0, 8);
const sandboxBin = (common) => path.join(claudeDir(), "proteus-sandbox", "bin", sandboxKey(common));
// Edit deny rules for what git in a git dir would run outside the sandbox: its config, config.worktree and hooks; and for
// proteus-lead/, the state the hooks write outside the sandbox (install.js --sandbox makes it first). The same for
// every submodule git dir under modules/ (a dir holding HEAD, nested ones too). A worktree's own config.worktree and
// proteus-hooks/ are not denied: renaming worktrees/<id> defeats such a rule (#212 r5), and the hooks' pinned git
// reads neither. On Linux and WSL2 the sandbox's denyWrite honours an exact path or a trailing /** only, so every
// rule is one of those, listed per submodule as they are now; links are not followed
function gitDenyRules(gitdir) {
  const rule = (...s) => `Edit(/${path.join(gitdir, ...s).split(path.sep).join("/")})`;
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; } };
  const rules = [rule("config"), rule("config.worktree"), rule("hooks", "**"), rule("proteus-lead", "**")];
  const modules = (d) => {
    for (const n of dirs(d)) {
      const sub = path.join(d, n);
      if (lstat(path.join(sub, "HEAD"))) rules.push(...gitDenyRules(sub));
      else modules(sub);
    }
  };
  modules(path.join(gitdir, "modules"));
  return rules;
}
// the plugin's own folder when these hooks run as a Claude Code plugin's (it sets CLAUDE_PLUGIN_ROOT), else ""
const pluginRoot = () => (process.env.CLAUDE_PLUGIN_ROOT ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT) : "");

// the first of base's segs that is a link, not a directory, or missing (made first when make); null when none
function blocker(base, segs = [], make = false) {
  let d = real(base);
  if (!d) return path.resolve(base);
  for (const s of segs) {
    d = path.join(d, s);
    if (make && !lstat(d)) { try { fs.mkdirSync(d); } catch {} }
    const st = lstat(d);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return d;
  }
  return null;
}
// base (resolved) joined with segs, every one a real directory; null when blocker names one
function ownDir(base, segs = [], make = false) {
  return blocker(base, segs, make) ? null : path.join(real(base), ...segs);
}

const KINDS = {
  link: [(st) => st.isSymbolicLink(), "not a link"],
  file: [(st) => st.isFile(), "not a regular file"],
  any: [(st) => st.isSymbolicLink() || st.isFile() || st.isDirectory(), "not a file, directory or link"],
};
// why p may not be removed or written as kind ("link", "file" or "any"), or null when it may
function refusal(p, roots, kind = "any") {
  const a = path.resolve(p), st = lstat(a), u = userHome();
  const at = path.join(realish(path.dirname(a)), path.basename(a));
  if (u && inside(at, u) && !inside(realish(os.homedir()), u)) return `in the user's home while HOME=${os.homedir()}`;
  if (st && !KINDS[kind][0](st)) return KINDS[kind][1];
  if (roots.some((x) => x && samePath(x, at) && !isDir(x))) return null;
  // up from the parent to the root it resolves to; a root not made yet matches by name
  for (let d = path.dirname(a); ; d = path.dirname(d)) {
    const r = realish(d);
    if (roots.some((x) => x && samePath(x, r) && !isFile(x))) return null;
    const s = lstat(d);
    if (s && s.isSymbolicLink()) return `${d} is a link on the way`;
    if (path.dirname(d) === d) return "outside what Proteus owns";
  }
}
const refuse = (p, why) => { console.error(`refused  ${p} (${why}; left alone)`); return false; };

// true if p was removed; false if absent or refused. A link goes, never what it points to; a
// directory goes with everything in it (kind "any" only)
function remove(p, roots, kind = "any") {
  try {
    const st = lstat(p);
    if (!st) return false;
    const why = refusal(p, roots, kind);
    if (why) return refuse(p, why);
    if (!st.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
    else {
      // a junction needs rmdir, which refuses a real directory
      try { fs.unlinkSync(p); } catch (e) { if (e.code !== "EPERM" && e.code !== "EISDIR") throw e; fs.rmdirSync(p); }
    }
    return true;
  } catch (e) {
    console.error(`warning: ${p} not removed: ${e.message}`);
    return false;
  }
}

// write data (or copy the file from) to p, a regular file or nothing yet; a link at p is removed first,
// never written through. Missing dirs are made. True when written
function writeFile(p, data, roots, from = null) {
  const st = lstat(p);
  if (st && st.isSymbolicLink() && !remove(p, roots, "link")) return false;
  const why = refusal(p, roots, "file");
  if (why) return refuse(p, why);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (from) fs.copyFileSync(from, p); else fs.writeFileSync(p, data);
    return true;
  } catch (e) {
    console.error(`warning: ${p} not written: ${e.message}`);
    return false;
  }
}
const copyFile = (src, dest, roots) => writeFile(dest, null, roots, src);

// point link at the directory target; a link already there goes through remove(link), which refuses by
// default. False when a real file or directory is in the way or the old link stays
function linkDir(target, link, rm = () => false) {
  const st = lstat(link);
  if (st && !st.isSymbolicLink()) return false;
  if (st) {
    if (samePath(real(link), real(target))) return true;
    if (!rm(link)) return false;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, WIN ? "junction" : "dir");
  return true;
}

module.exports = { WIN, lstat, real, isDir, isFile, samePath, inside, realish, userHome, claudeDir, sandboxKey, sandboxBin, gitDenyRules, pluginRoot, blocker, ownDir, refusal, remove, writeFile, copyFile, linkDir };
