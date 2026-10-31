#!/usr/bin/env node
// The learning workspace (#84): when the human wants to learn the project in depth, the lead prepares a learn/ folder
// and hands off to the teach skill, which only the human can start and which writes where it runs
// (skills/proteus/references/audience.md). This keeps the folder and what the lead has read from it:
//   node <hooks>/proteus-learn.js path      the workspace, <root>/learn
//   node <hooks>/proteus-learn.js prepare   makes the folder, keeps it out of git; prints learn ready <path>
//   node <hooks>/proteus-learn.js seed [--mission <file>] [--resources <file>] [--glossary <file>]
//                                           prepares, then writes MISSION.md, RESOURCES.md, GLOSSARY.md where missing
//   node <hooks>/proteus-learn.js status    one line: learn records=<n> new=<n>, or learn none with no workspace
//   node <hooks>/proteus-learn.js seen      marks every current record as read
// Paths resolve from the main checkout's root, from any cwd inside the repo. The folder goes in
// <git-common-dir>/info/exclude, never a tracked ignore file. A seeded file is never written again: the skill owns it.
// A record is a regular file learning-records/*.md, at most MAX_RECORDS are looked at, and links are skipped. The read
// names are in <git-common-dir>/proteus/learn-seen.json. A convenience store, not a trust boundary: it does not check
// who runs it, every read re-validates every entry and drops what is invalid, and a file that cannot be read counts as
// nothing read. A write is a fresh temp file created exclusively and renamed over the name, never through a link.
// Exit 0 done; 1 no repo, a link or non-directory at the workspace, a link at info/exclude, an unreadable draft, or a
// failed write; 2 bad usage.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: node proteus-learn.js path | prepare | seed [--mission <file>] [--resources <file>] [--glossary <file>] | status | seen";
const DIR = "learn";
const RECORDS = "learning-records";
const EXCLUDE = `/${DIR}/`;
const SEEN = "learn-seen.json";
const SEEDS = { "--mission": "MISSION.md", "--resources": "RESOURCES.md", "--glossary": "GLOSSARY.md" };
const MAX_RECORDS = 1000;
const MAX_NAME = 255;
const MAX_SEED = 1 << 20;
const MAX_SEEN = 1 << 20;

const seenFile = (common) => path.join(lib.stateDir(common), SEEN);
// { root, common, dir } of the checkout root, null without a repo there
function at(checkout) {
  const common = checkout ? lib.gitCommonDir(checkout) : null;
  if (!common) return null;
  const root = lib.mainRoot(common) || checkout;
  return { root, common, dir: path.join(root, DIR) };
}
// from the cwd, else from the harness's project dir
const locate = () => at(lib.gitRoot(process.cwd()) || lib.gitRoot(lib.projectRoot()));

const isRecord = (n) => typeof n === "string" && n.length <= MAX_NAME && n.endsWith(".md") && n !== ".md" && !/[/\\]|\p{Cc}/u.test(n);
const plainDir = (d) => { try { const st = fs.lstatSync(d); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

// d is a real dir (not a link) this user owns
function realDir(d) {
  if (!plainDir(d)) throw new Error(`${d} is not a directory`);
  if (typeof process.getuid === "function" && fs.lstatSync(d).uid !== process.getuid()) throw new Error(`${d} is not owned by this user`);
}

// the record names, sorted; null with no workspace. Bounded by what it looks at, so a huge folder costs no more
function records(w) {
  if (!plainDir(w.dir)) return null;
  const dir = path.join(w.dir, RECORDS), names = [];
  if (!plainDir(dir)) return names;
  let d;
  try {
    d = fs.opendirSync(dir);
    for (let e, i = 0; i < MAX_RECORDS && (e = d.readSync()); i++) if (e.isFile() && isRecord(e.name)) names.push(e.name);
  } catch {} finally { try { if (d) d.closeSync(); } catch {} }
  return names.sort();
}
// the read names that still validate, malformed state counting as none
function readSeen(common) {
  const v = lib.readUntrustedJSON(seenFile(common), null, MAX_SEEN);
  return new Set(v && Array.isArray(v.seen) ? v.seen.filter(isRecord) : []);
}
function counts(w) {
  const names = records(w);
  if (!names) return null;
  const seen = readSeen(w.common);
  return { records: names.length, fresh: names.filter((n) => !seen.has(n)).length, names };
}
const statusLine = (w) => { const c = counts(w); return c ? `learn records=${c.records} new=${c.fresh}` : "learn none"; };
// the autostart's state line: the unread records in the checkout's project, 0 on anything wrong
const fresh = (checkout) => { try { const c = counts(at(checkout)); return c ? c.fresh : 0; } catch { return 0; } };

// the line goes in only when absent; a link at info/ or at the file is refused, not followed
function addExclude(common) {
  const info = path.join(common, "info"), file = path.join(info, "exclude");
  try { fs.mkdirSync(info); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!plainDir(info)) throw new Error(`${info} is not a directory`);
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (st && !st.isFile()) throw new Error(`${file} is ${st.isSymbolicLink() ? "a link" : "not a file"}`);
  const cur = st ? lib.readUntrusted(file) : "";
  if (cur.split(/\r?\n/).includes(EXCLUDE)) return;
  const c = fs.constants;
  const fd = fs.openSync(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o644);
  try { fs.writeSync(fd, (cur && !cur.endsWith("\n") ? "\n" : "") + EXCLUDE + "\n"); } finally { fs.closeSync(fd); }
}
function prepare(w) {
  try { fs.mkdirSync(w.dir); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = fs.lstatSync(w.dir);
  if (st.isSymbolicLink()) throw new Error(`${w.dir} is a link`);
  if (!st.isDirectory()) throw new Error(`${w.dir} is not a directory`);
  addExclude(w.common);
}

// body under a fresh temp name, renamed to file (a link there is replaced, never followed)
function writeFresh(dir, name, body) {
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(tmp, path.join(dir, name)); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
// true when it wrote; anything at the name, a dangling link too, stays
function seedFile(dir, name, body) {
  try { fs.lstatSync(path.join(dir, name)); return false; } catch (e) { if (e.code !== "ENOENT") throw e; }
  writeFresh(dir, name, body);
  return true;
}
function saveSeen(common, names) {
  realDir(common);
  const dir = lib.stateDir(common);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  realDir(dir);
  writeFresh(dir, SEEN, JSON.stringify({ seen: names }, null, 2) + "\n");
}

// [[target name, source path]...], null on anything but the seed flags, each once, with a value
function seedArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const name = SEEDS[argv[i]], src = argv[i + 1];
    if (!Object.hasOwn(SEEDS, argv[i]) || !src || src.startsWith("--") || out.has(name)) return null;
    out.set(name, src);
  }
  return out.size ? [...out] : null;
}

function run(cmd, rest, w) {
  if (cmd === "path") { console.log(w.dir); return 0; }
  if (cmd === "status") { console.log(statusLine(w)); return 0; }
  if (cmd === "prepare") { prepare(w); console.log(`learn ready ${w.dir}`); return 0; }
  if (cmd === "seen") {
    const c = counts(w);
    if (c) saveSeen(w.common, c.names);
    console.log(statusLine(w));
    return 0;
  }
  const seeds = seedArgs(rest);
  if (!seeds) { console.error(USAGE); return 2; }
  // every draft read before anything is written, so a bad path leaves nothing half done
  const bodies = seeds.map(([name, src]) => {
    try { return [name, lib.readUntrusted(src, MAX_SEED)]; } catch (e) { throw new Error(`cannot read ${src} (${e.message})`); }
  });
  prepare(w);
  console.log(`learn ready ${w.dir}`);
  for (const [name, body] of bodies) console.log(`${seedFile(w.dir, name, body) ? "seeded" : "kept"} ${name}`);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(USAGE); return 0; }
  if (!["path", "prepare", "seed", "status", "seen"].includes(cmd) || (cmd !== "seed" && rest.length)) { console.error(USAGE); return 2; }
  try {
    const w = locate();
    if (!w) { console.error("proteus-learn: not inside a git repository"); return 1; }
    return run(cmd, rest, w);
  } catch (e) { console.error(`proteus-learn: ${e.message}`); return 1; }
}

module.exports = { fresh };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
