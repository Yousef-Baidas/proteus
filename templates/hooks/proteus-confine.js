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
function samePath(a, b) { return !!a && !!b && (WIN ? a.toLowerCase() === b.toLowerCase() : a === b); }
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
// realpath of the deepest existing ancestor, the rest joined on: a path that does not exist yet resolves too
const realish = (p) => { const a = path.resolve(p), r = real(a); if (r) return r; const d = path.dirname(a); return d === a ? a : path.join(realish(d), path.basename(a)); };
const userHome = () => { try { return realish(os.userInfo().homedir); } catch { return null; } };

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

module.exports = { WIN, lstat, real, isDir, isFile, samePath, inside, realish, userHome, blocker, ownDir, refusal, remove, writeFile, copyFile, linkDir };
