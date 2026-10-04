#!/usr/bin/env node
// Link each profile's skills into teams/<profile>/.claude/skills/ (Claude Code) and
// teams/<profile>/.agents/skills/ (Codex), so one repo serves both CLIs. Run from the repo root. Copied here by Proteus's install.js --project
// (link-skills.sh and link-skills.ps1 are thin wrappers); proteus-scout re-runs it after
// rewriting a skills.txt.
//
//   node teams/link-skills.js              link what is already on this machine
//   node teams/link-skills.js --install    also `npx skills add` anything missing
//   node teams/link-skills.js --confine    also drop ~/.claude/skills/<name> links
//                                          so the lead never loads them
//   node teams/link-skills.js --relock     accept current hashes into teams/skills-lock.json
//
// skills.txt line format:  <owner/repo> <skill-name>
// required.txt (same format) holds the pipeline's mandatory skills; proteus-scout never
// rewrites it and it does not count against the eight-per-profile cap.
// teams/skills-lock.json pins each linked skill's content hash (sha256 over its files);
// a differing hash on this machine prints "drift: <skill>" and keeps the committed hash; until the copy
// matches or --relock, the lead guard refuses worker and verifier spawns (proteus-lib.js lockDrift).
// Links are symlinks, junctions on Windows (no admin needed); removing one never touches
// its target. install.js requires this file for the same link helpers.
// A skill name is one path segment ([A-Za-z0-9][A-Za-z0-9._-]*) or it is warned and skipped (#13).
// Every delete here goes through removeLink, which removes only a link directly in the directory
// its caller expects: teams/<profile>/{.claude,.agents}/skills or ~/.claude/skills. That dir is the
// real repo root (or HOME) plus fixed segments, each lstat'd a real directory: a symlinked component
// below the root refuses the delete, and no mkdir or link is made through one.
// Exit 0 on success, 1 when there is no teams/ here, 2 on an unknown flag.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const WIN = process.platform === "win32";
const HOME = os.homedir();
// Proteus's own global links; never confined
const OURS = new Set(["proteus", "proteus-review"]);
// Claude Code loads a team's .claude/skills once a worker reads a file in the team folder. Codex
// loads .agents/skills only between the repo root and the session cwd, and a spawned subagent
// keeps the lead's cwd, so a Codex worker opens <team>/.agents/skills/<name>/SKILL.md itself.
const SKILL_DIRS = [path.join(".claude", "skills"), path.join(".agents", "skills")];

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function real(p) { try { return fs.realpathSync(p); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function samePath(a, b) { return !!a && !!b && (WIN ? a.toLowerCase() === b.toLowerCase() : a === b); }

// a skill name from a list file: one path segment, so a link built from it stays in its skills dir
const validName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

// root (resolved once) joined with segs, every component below root lstat'd a real directory, never a
// link; make creates a missing one. null when any is a link, not a directory, or missing (#13).
function ownDir(root, segs, make = false) {
  let d = real(root);
  if (!d) return null;
  for (const s of segs) {
    d = path.join(d, s);
    if (make && !lstat(d)) { try { fs.mkdirSync(d); } catch {} }
    const st = lstat(d);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  return d;
}

// Remove a symlink or junction, never what it points to, and only when its real parent is exactly
// ownDir(root, segs); anything else is refused with a warning. Works on broken links too; never throws.
function removeLink(link, root, segs) {
  const st = lstat(link);
  if (!st) return false;
  const parent = real(path.dirname(path.resolve(link)));
  const dir = root && segs ? ownDir(root, segs) : null;
  if (!st.isSymbolicLink() || !dir || !parent || !samePath(parent, dir)) {
    const where = root && segs ? path.join(root, ...segs) : "a known dir";
    console.error(`refused  ${link} (${st.isSymbolicLink() ? `not a link directly in ${where}, or a link on the way` : "not a link"}; left alone)`);
    return false;
  }
  try {
    try { fs.unlinkSync(link); }
    catch (e) {
      if (e.code !== "EPERM" && e.code !== "EISDIR") throw e;
      fs.rmdirSync(link); // non-recursive: removes a junction, refuses a real directory
    }
    return true;
  } catch (e) {
    console.error(`warning: ${link} not removed: ${e.message}`);
    return false;
  }
}

// Point link at the directory target. False if a real file or directory is in the way, or if the
// old link could not be removed. remove(link) does the removal; without one, nothing is removed.
function linkDir(target, link, remove = () => false) {
  const st = lstat(link);
  if (st && !st.isSymbolicLink()) return false;
  if (st) {
    if (samePath(real(link), real(target))) return true;
    if (!remove(link)) return false;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, WIN ? "junction" : "dir");
  return true;
}

function findSrc(name) {
  for (const cand of [path.join(HOME, ".agents", "skills", name), path.join(HOME, ".claude", "skills", name)]) {
    if (isDir(cand)) return real(cand);
  }
  return null;
}

// [[source, name], ...] from a list file; blank lines and # comments skipped, CRLF tolerated
function readList(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter(([source]) => source && !source.startsWith("#"));
}

function listFiles(dir) {
  return ["required.txt", "skills.txt"].flatMap((f) => { const p = path.join(dir, f); return isFile(p) ? [p] : []; });
}

// sha256 over relative path + content of every file; must stay byte-identical to the
// original link-skills.sh hash or every existing lock reports drift
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" || e.name === ".git" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
function hashDir(d) {
  const h = crypto.createHash("sha256");
  for (const f of walk(d).sort()) {
    h.update(path.relative(d, f).split(path.sep).join("/") + "\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

function profiles(teams) {
  return fs.readdirSync(teams).filter((p) => isDir(path.join(teams, p))).sort();
}

// remove(link, root, segs) does every removal: removeLink by default; install.js passes its own guard.
// A team skills dir is used only when ownDir(root, teams/<p>/<d>) holds: a link on the way skips it.
function run({ root = process.cwd(), install = false, confine = false, relock = false, log = console.log, remove = removeLink } = {}) {
  const teams = path.join(root, "teams");
  if (!isDir(teams)) throw new Error("no teams/ here; run from the repo root");
  const missing = [];
  const linked = [];
  const homeSkills = [".claude", "skills"];
  for (const p of profiles(teams)) {
    const dir = path.join(teams, p);
    const lists = listFiles(dir);
    if (!lists.length) continue;
    const dirs = [];
    for (const d of SKILL_DIRS) {
      const segs = ["teams", p, ...d.split(path.sep)];
      const own = ownDir(root, segs, true);
      if (own) dirs.push({ d, segs, own });
      else console.error(`teams/${p}/${d.split(path.sep).join("/")} is a link or has one on the way; refused, left alone`);
    }
    if (!dirs.length) { log(`teams/${p} -> 0 skills linked`); continue; }
    let n = 0;
    for (const [source, name] of lists.flatMap(readList)) {
      if (!name) { console.error(`teams/${p}: line needs '<owner/repo> <skill>': ${source}`); continue; }
      if (!validName(name)) { console.error(`teams/${p}: skill name ${JSON.stringify(name)} is not one path segment; skipped`); continue; }
      let src = findSrc(name);
      if (!src && install) {
        spawnSync(WIN ? "npx.cmd" : "npx", ["-y", "skills", "add", source, "--skill", name, "-g", "-y", "-a", "claude-code"],
          { stdio: "ignore", shell: WIN });
        src = findSrc(name);
      }
      if (!src) { missing.push(`${p}: npx skills add ${source} --skill ${name} -g -y`); continue; }
      const blocked = dirs.filter(({ segs, own }) => !linkDir(src, path.join(own, name), (l) => remove(l, root, segs)));
      for (const { d } of blocked) console.error(`teams/${p}/${d.split(path.sep).join("/")}/${name} is a real directory or a link that could not be replaced; left alone`);
      if (blocked.length === dirs.length) continue;
      n++;
      linked.push({ name, source, src });
      const g = path.join(HOME, ...homeSkills, name);
      if (confine && !OURS.has(name) && lstat(g) && lstat(g).isSymbolicLink()) remove(g, HOME, homeSkills);
    }
    log(`teams/${p} -> ${n} skills linked`);
  }

  if (missing.length) {
    log("");
    log("missing; install then re-run (or pass --install):");
    for (const m of missing) log(`  ${m}`);
  }
  if (confine) log("confined: linked skills removed from ~/.claude/skills (restart Claude Code)");

  // lock; a link at it or on the way (a repo may commit one) is neither read nor written through (#22)
  const lockFile = path.join(teams, "skills-lock.json"), lockSt = lstat(lockFile);
  const lockOk = !!ownDir(root, ["teams"]) && !(lockSt && lockSt.isSymbolicLink());
  if (linked.length && !lockOk) console.error(`refused  ${lockFile} (a link, or a link on the way; lock not written, left alone)`);
  if (linked.length && lockOk) {
    let lock = { version: 1, skills: {} };
    let before = "";
    try { before = fs.readFileSync(lockFile, "utf8"); lock = JSON.parse(before); } catch {}
    const drift = [];
    for (const { name, source, src } of linked) {
      const h = hashDir(src);
      const old = lock.skills[name];
      if (old && old.hash !== h && !relock) { drift.push(name); continue; }
      lock.skills[name] = { source, hash: h };
    }
    const after = JSON.stringify(lock, null, 2) + "\n";
    if (after !== before) fs.writeFileSync(lockFile, after);
    for (const d of drift) log(`drift: ${d}  (npx skills update ${d}, or --relock to accept)`);
    log(`lock -> teams/skills-lock.json (${Object.keys(lock.skills).length} skills${relock ? ", relocked" : ""})`);
  }
  return { linked: linked.length, missing: missing.length };
}

module.exports = { WIN, SKILL_DIRS, lstat, real, isDir, isFile, samePath, validName, ownDir, removeLink, linkDir, readList, listFiles, profiles, hashDir, run };

if (require.main === module) {
  const opt = {};
  for (const a of process.argv.slice(2)) {
    if (a === "--install") opt.install = true;
    else if (a === "--confine") opt.confine = true;
    else if (a === "--relock") opt.relock = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  // from elsewhere (a guest dir outside the repo, a subfolder): the teams/ this script sits in
  if (!isDir(path.join(process.cwd(), "teams")) && path.basename(__dirname) === "teams") opt.root = path.dirname(__dirname);
  try { run(opt); }
  catch (e) { console.error(e.message); process.exit(1); }
}
