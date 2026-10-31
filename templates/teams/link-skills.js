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
// Every delete and write here goes through proteus-confine.js (C below says where it is found):
// removeLink removes only a link under teams/<profile>/{.claude,.agents}/skills or ~/.claude/skills,
// each the real repo root (or HOME) plus fixed segments lstat'd real directories, so a symlinked
// component below the root refuses the delete, and no mkdir, link or lock write goes through one.
// Exit 0 on success, 1 when there is no teams/ here, 2 on an unknown flag.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// the guard: beside this file in a repo's teams/, else in its teams/templates/hooks/, else ../hooks/ in the checkout
const C = require([__dirname, path.join(__dirname, "templates", "hooks"), path.join(__dirname, "..", "hooks")]
  .map((d) => path.join(d, "proteus-confine.js")).find((f) => fs.existsSync(f)) || path.join(__dirname, "proteus-confine.js"));
const { WIN, lstat, real, isDir, isFile, samePath, inside, ownDir, linkDir } = C;
const HOME = os.homedir();
// Claude Code's skills dir ($CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills) as a confined root and its segments:
// from HOME when it is under it, so a link anywhere on the way is refused as before
const CLAUDE = C.claudeDir();
const [SKILLS_BASE, SKILLS_SEGS] = inside(CLAUDE, HOME) ? [HOME, [...path.relative(HOME, CLAUDE).split(path.sep).filter(Boolean), "skills"]] : [CLAUDE, ["skills"]];
// Proteus's own global links; never confined
const OURS = new Set(["proteus", "proteus-review"]);
// Claude Code loads a team's .claude/skills once a worker reads a file in the team folder. Codex
// loads .agents/skills only between the repo root and the session cwd, and a spawned subagent
// keeps the lead's cwd, so a Codex worker opens <team>/.agents/skills/<name>/SKILL.md itself.
const SKILL_DIRS = [path.join(".claude", "skills"), path.join(".agents", "skills")];

// a skill name from a list file: one path segment, so a link built from it stays in its skills dir
const validName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

// remove a symlink or junction, never what it points to, confined to ownDir(root, segs); anything
// else is refused with a warning. Works on broken links too; never throws.
function removeLink(link, root, segs) {
  const dir = root && segs ? ownDir(root, segs) : null;
  if (dir || !lstat(link)) return C.remove(link, [dir], "link");
  console.error(`refused  ${link} (${root && segs ? `${C.blocker(root, segs)} is a link or not a directory` : "no dir it belongs in"}; left alone)`);
  return false;
}

function findSrc(name) {
  for (const cand of [path.join(HOME, ".agents", "skills", name), path.join(CLAUDE, "skills", name), path.join(HOME, ".claude", "skills", name)]) {
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
  let confined = 0; // global links actually removed
  let lists = 0, listed = 0; // list files and skill lines: lists naming no skill (the scout may pick zero) still lock
  for (const p of profiles(teams)) {
    const dir = path.join(teams, p);
    const files = listFiles(dir);
    if (!files.length) continue;
    lists++;
    listed += files.flatMap(readList).length;
    const dirs = [];
    for (const d of SKILL_DIRS) {
      const segs = ["teams", p, ...d.split(path.sep)];
      const own = ownDir(root, segs, true);
      if (own) dirs.push({ d, segs, own });
      else console.error(`teams/${p}/${d.split(path.sep).join("/")} is a link or has one on the way; refused, left alone`);
    }
    if (!dirs.length) { log(`teams/${p} -> 0 skills linked`); continue; }
    let n = 0;
    for (const [source, name] of files.flatMap(readList)) {
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
      const g = path.join(SKILLS_BASE, ...SKILLS_SEGS, name);
      if (confine && !OURS.has(name) && lstat(g) && lstat(g).isSymbolicLink() && remove(g, SKILLS_BASE, SKILLS_SEGS)) confined++;
    }
    log(`teams/${p} -> ${n} skills linked`);
  }

  if (missing.length) {
    log("");
    log("missing; install then re-run (or pass --install):");
    for (const m of missing) log(`  ${m}`);
  }
  if (confine) log(confined ? `confined: ${confined} linked skill${confined === 1 ? "" : "s"} removed from ~/.claude/skills (restart Claude Code)` : "confine : nothing to remove from ~/.claude/skills");

  // lock; a link at it or on the way (a repo may commit one) is neither read nor written through (#22)
  const lockFile = path.join(teams, "skills-lock.json"), lockSt = lstat(lockFile);
  const lockOk = !!ownDir(root, ["teams"]) && !(lockSt && lockSt.isSymbolicLink());
  const lockIt = linked.length || (lists && !listed);
  if (lockIt && !lockOk) console.error(`refused  ${lockFile} (a link, or a link on the way; lock not written, left alone)`);
  if (lockIt && lockOk) {
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
    if (after !== before) C.writeFile(lockFile, after, [ownDir(root, ["teams"])]);
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
