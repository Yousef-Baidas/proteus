#!/usr/bin/env node
// Where a skill that is not linked into the skills folder lives (a plugin's, or one a tool refuses to invoke):
//   node .claude/hooks/proteus-skillpath.js <skill>    print the SKILL.md paths, newest first; exit 1 if none
// Searches the harness adapter's skillRoots() (plugin cache, skills folders), then any dirs in
// PROTEUS_SKILL_DIRS (path-delimited). Never a hardcoded ~/.claude/plugins/cache/<market>/<plugin>/<version>.
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_DEPTH = 8;

// dirs named `name` (null: any name) under root that hold a SKILL.md; no symlink is followed except a root itself
function find(root, name, depth = 0, out = []) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const d = path.join(root, e.name);
    const dir = e.isDirectory() || (e.isSymbolicLink() && depth === 0 && isDir(d));
    if (!dir) continue;
    const md = path.join(d, "SKILL.md");
    if ((name === null || e.name === name) && fs.existsSync(md)) out.push(md);
    else if (depth < MAX_DEPTH) find(d, name, depth + 1, out);
  }
  return out;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

function locate(name, roots) {
  const seen = new Set();
  const hits = [];
  for (const r of roots) for (const f of find(r, name)) {
    const real = fs.realpathSync(f);
    if (!seen.has(real)) { seen.add(real); hits.push(f); }
  }
  return hits.sort((a, b) => mtime(b) - mtime(a));
}

function roots() {
  const extra = (process.env.PROTEUS_SKILL_DIRS || "").split(path.delimiter).filter(Boolean);
  let own = [];
  try { own = require(path.join(__dirname, "proteus-harness.js")).skillRoots(); } catch { /* adapter missing: only the env dirs */ }
  return [...own, ...extra];
}

if (require.main === module) {
  require(path.join(__dirname, "proteus-lib.js")).homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
  const USAGE = "usage: node proteus-skillpath.js <skill>";
  const name = process.argv[2];
  if (name === "--help" || name === "-h") {
    console.log(`${USAGE}
Prints the SKILL.md paths of a skill that is not linked into the skills folder, newest first:
  <skill>   the skill's directory name
Searches the harness adapter's skill roots (plugin cache, skills folders), then the dirs in
PROTEUS_SKILL_DIRS (path-delimited). Exit 1 if none is found; 2 on usage.`);
    process.exit(0);
  }
  if (!name || !/^[\w.-]+$/.test(name)) { console.error(USAGE + "\n(--help explains the argument)"); process.exit(2); }
  const hits = locate(name, roots());
  if (!hits.length) { console.error(`proteus-skillpath: no SKILL.md for "${name}" under the plugin cache or skills folders; set PROTEUS_SKILL_DIRS or install the skill`); process.exit(1); }
  console.log(hits.join("\n"));
}
module.exports = { locate, find, roots };
