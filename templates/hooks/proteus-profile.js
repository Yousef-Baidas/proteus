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
// One file per project and machine: <git-common-dir>/proteus-lead/profile.json, never committed, written through
// lib.leadJSON (a fresh temp file renamed over it, never through a link). Works from any cwd inside the repo.
// A convenience store, not a trust boundary: it does not check who runs it. A malformed file reads as unset, and set
// starts a fresh profile over it; know and forget need a profile, so they never stand in for the gauging set ends.
// Exit 0 done; 1 an invalid value or term, no repo, no profile for know or forget, or the file could not be written;
// 2 bad usage.
"use strict";
const path = require("path");
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

const file = (common) => lib.leadPath(common, FILE);
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

// { profile } when the file is valid, { profile: null } when there is none, { profile: null, error } when malformed
function read(common) {
  if (!common) return { profile: null, error: "not inside a git repository" };
  let text;
  try { text = lib.readUntrusted(file(common), 1 << 16); } catch (e) { return e.code === "ENOENT" ? { profile: null } : { profile: null, error: `cannot be read (${e.code || e.message})` }; }
  let p;
  try { p = JSON.parse(text); } catch { return { profile: null, error: "not valid JSON" }; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return { profile: null, error: "not a JSON object" };
  for (const [k, allowed] of Object.entries(KEYS)) if (!allowed.includes(p[k])) return { profile: null, error: `${k} must be one of ${allowed.join(", ")}` };
  if (!Array.isArray(p.known) || p.known.some((t) => termError(t))) return { profile: null, error: "known must be a list of terms" };
  return { profile: { familiarity: p.familiarity, learning: p.learning, known: dedup(p.known), updated: typeof p.updated === "string" ? p.updated : "" } };
}

// the show line; the autostart puts the short form on its state line
function line(common) {
  const r = read(common);
  if (!r.profile) return r.error ? `audience unset (unreadable: ${r.error})` : "audience unset";
  return `audience familiarity=${r.profile.familiarity} learning=${r.profile.learning} known=${r.profile.known.length}`;
}
const short = (common) => { const p = read(common).profile; return p ? `${p.familiarity}/${p.learning}` : "unset"; };

// write profile with today's date; throws when the lead state is refused or the write fails
function save(common, profile) {
  const p = { familiarity: profile.familiarity, learning: profile.learning, known: dedup(profile.known), updated: new Date().toISOString().slice(0, 10) };
  lib.leadJSON(common, file(common), p);
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
  if (!cur && cmd !== "set") { console.error(`proteus-profile: ${r.error ? `the profile is unreadable (${r.error})` : "no profile yet"}; run set first`); return 1; }
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
