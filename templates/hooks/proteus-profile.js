#!/usr/bin/env node
// The audience profile (#308): how familiar the human is with the kind of work this project does, whether they want
// to learn along the way, and the terms they have shown they know. The lead and the guide phrase every decision that
// reaches the human at this level (skills/proteus/references/audience.md). A module and a CLI:
//   node <hooks>/proteus-profile.js show                     one line: audience familiarity=<f> learning=<l> known=<n>
//   node <hooks>/proteus-profile.js set familiarity=<f> learning=<l>    either key, or both
//   node <hooks>/proteus-profile.js know <term>...           add terms the human has shown they know
//   node <hooks>/proteus-profile.js forget <term>...         remove terms
//   node <hooks>/proteus-profile.js terms                    the known terms, one per line
//   node <hooks>/proteus-profile.js path                     the profile file
// One file per project and machine: <git-common-dir>/proteus/profile.json, never committed. It sits beside
// forgotten.json, not in proteus-lead, so the lead's sandboxed shell can write it; agents can too. A convenience
// store, not a trust boundary: it does not check who runs it, every read re-validates every field and drops what is
// invalid, and a file that cannot be read as a profile is unset. A write is a fresh temp file created exclusively and
// renamed over the name, never through a link. Works from any cwd inside the repo. set starts a fresh profile over an
// unset one; know and forget need a profile, so they never stand in for the gauging set ends.
// Exit 0 done; 1 an invalid value or term, no repo, no profile for know or forget, or the file could not be written;
// 2 bad usage.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: node proteus-profile.js show | set familiarity=<f> learning=<l> | know <term>... | forget <term>... | terms | path";
const FILE = "profile.json";
const FAMILIARITY = ["new", "some", "fluent"];
const LEARNING = ["along", "asked", "off"];
// what a skipped gauging leaves
const DEFAULTS = { familiarity: "some", learning: "asked" };
const MAX_TERM = 60;
const MAX_TERMS = 300;
const KEYS = { familiarity: FAMILIARITY, learning: LEARNING };

const MAX_BYTES = 1 << 16;
const file = (common) => path.join(lib.stateDir(common), FILE);
// the project's common dir from the cwd, else from the harness's project dir; null outside any repo
function commonDir() {
  const root = lib.gitRoot(process.cwd()) || lib.gitRoot(lib.projectRoot());
  return root ? lib.gitCommonDir(root) : null;
}

// why term cannot be stored, "" when it can
function termError(t) {
  if (typeof t !== "string" || !t.trim()) return "a term must not be empty";
  if (/\p{Cc}/u.test(t)) return "a term must not hold control characters";
  if (t.trim().length > MAX_TERM) return `a term must be at most ${MAX_TERM} characters`;
  return "";
}
const key = (t) => t.trim().toLowerCase();
// terms deduplicated case-insensitively, the later spelling kept at the later place; the newest MAX_TERMS
function dedup(terms) {
  const m = new Map();
  for (const t of terms) { const k = key(t); m.delete(k); m.set(k, t.trim()); }
  return [...m.values()].slice(-MAX_TERMS);
}

// { profile } when familiarity and learning are valid (invalid terms dropped), else { profile: null }; error only
// outside a repo
function read(common) {
  if (!common) return { profile: null, error: "not inside a git repository" };
  const p = lib.readUntrustedJSON(file(common), null, MAX_BYTES);
  if (!p || Array.isArray(p)) return { profile: null };
  for (const [k, allowed] of Object.entries(KEYS)) if (!allowed.includes(p[k])) return { profile: null };
  const known = Array.isArray(p.known) ? p.known.filter((t) => !termError(t)) : [];
  const updated = typeof p.updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.updated) ? p.updated : "";
  return { profile: { familiarity: p.familiarity, learning: p.learning, known: dedup(known), updated } };
}

// the show line; the autostart puts the short form on its state line
function line(common) {
  const r = read(common);
  if (!r.profile) return r.error ? `audience unset (${r.error})` : "audience unset";
  return `audience familiarity=${r.profile.familiarity} learning=${r.profile.learning} known=${r.profile.known.length}`;
}
const short = (common) => { const p = read(common).profile; return p ? `${p.familiarity}/${p.learning}` : "unset"; };

// d is a real dir (not a link) this user owns
function realDir(d) {
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${d} is not owned by this user`);
}
// write profile with today's date: a temp file created exclusively, then renamed over the name (a link there is
// replaced, never followed); throws when <common> or <common>/proteus is a link or not this user's
function save(common, profile) {
  const p = { familiarity: profile.familiarity, learning: profile.learning, known: dedup(profile.known), updated: new Date().toISOString().slice(0, 10) };
  realDir(common);
  const dir = lib.stateDir(common);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  realDir(dir);
  const tmp = path.join(dir, `.${FILE}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { fs.renameSync(tmp, file(common)); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return p;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(USAGE); return 0; }
  const common = commonDir();
  if (cmd === "show") { console.log(line(common)); return 0; }
  if (!["set", "know", "forget", "terms", "path"].includes(cmd)) { console.error(USAGE); return 2; }
  if (!common) { console.error("proteus-profile: not inside a git repository"); return 1; }
  if (cmd === "path") { console.log(file(common)); return 0; }
  const r = read(common), cur = r.profile;
  if (cmd === "terms") { for (const t of cur ? cur.known : []) console.log(t); return 0; }
  if (!cur && cmd !== "set") { console.error("proteus-profile: no profile yet; run set first"); return 1; }
  const next = { ...DEFAULTS, known: [], ...cur };
  if (cmd === "set") {
    if (!rest.length) { console.error(`proteus-profile: set needs familiarity=<${FAMILIARITY.join("|")}>, learning=<${LEARNING.join("|")}>, or both`); return 2; }
    for (const a of rest) {
      const i = a.indexOf("="), k = i < 0 ? a : a.slice(0, i), v = i < 0 ? "" : a.slice(i + 1);
      if (!KEYS[k]) { console.error(`proteus-profile: unknown setting "${k}"; the settings are ${Object.keys(KEYS).join(", ")}`); return 1; }
      if (!KEYS[k].includes(v)) { console.error(`proteus-profile: ${k} must be one of ${KEYS[k].join(", ")}`); return 1; }
      next[k] = v;
    }
  } else {
    if (!rest.length) { console.error(`proteus-profile: ${cmd} needs at least one term`); return 2; }
    for (const t of rest) { const e = termError(t); if (e) { console.error(`proteus-profile: ${e}; nothing written`); return 1; } }
    const drop = new Set(rest.map(key));
    next.known = cmd === "know" ? [...next.known, ...rest] : next.known.filter((t) => !drop.has(key(t)));
  }
  try { save(common, next); } catch (e) { console.error(`proteus-profile: cannot write ${file(common)} (${e.message})`); return 1; }
  console.log(line(common));
  return 0;
}

module.exports = { read, line, short, save, termError, file, FAMILIARITY, LEARNING, DEFAULTS, MAX_TERM, MAX_TERMS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
