#!/usr/bin/env node
// Writes scripts/known-blobs.json: every git blob id an agents/ or templates/ path had in HEAD's history and no longer
// has (the shipped roster's pre-move teams/ paths counted as templates/teams/), plus the text of each past ROUTING.md,
// PROFILE.md and skills.txt. install.js reads it to tell a 1.x copy from an edit, and to write a .base beside a
// .upstream: the plugin's copy has no git history. tests/knownblobs.test.js (audit) fails when the file lacks a
// version this branch superseded, and warns about the rest (#164); scripts/changelog.js --release runs this script.
// Usage: node scripts/known-blobs.js (in a full clone). Exit 0 once written, 1 when git fails.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(__dirname, "known-blobs.json");
// teams/ held the shipped roster until 2f2933f moved it to templates/teams/; since then teams/ is this repo's own
const MOVED = "2f2933f";
const TEXTS = /^templates\/teams\/(ROUTING\.md|[\w-]+\/(PROFILE\.md|skills\.txt))$/;

function git(args, root, input) {
  // with input: stdout as a Buffer, sliced by byte size (cat-file --batch)
  const r = input === undefined ? spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, windowsHide: true })
    : spawnSync("git", args, { cwd: root, input, maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr || r.error || "").trim()}`);
  return r.stdout;
}

// { blobs: { path: [id, ...] }, texts: { path: { id: text } } }, keys and ids sorted
function compute(root = ROOT) {
  const seen = new Map();
  const add = (p, id) => { if (!/^0+$/.test(id)) (seen.get(p) || seen.set(p, new Set()).get(p)).add(id); };
  // -m: a merge's own blobs (a resolved conflict) too
  const raw = (range, paths) => git(["log", "-m", "--format=", "--raw", "--no-abbrev", "--no-renames", range, "--", ...paths], root);
  const rows = (text) => text.split("\n").map((l) => /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) \w+\t(.+)$/.exec(l)).filter(Boolean);
  for (const [, id, p] of rows(raw("HEAD", ["agents", "templates"]))) add(p, id);
  const yes = (args) => spawnSync("git", args, { cwd: root, stdio: "ignore", windowsHide: true }).status === 0;
  if (yes(["merge-base", "--is-ancestor", MOVED, "HEAD"])) {
    for (const [, id, p] of rows(raw(MOVED, ["teams"]))) add(`templates/${p}`, id);
  }
  // the blob a path has now is the shipped text itself, read from the file at run time
  const paths = [...seen.keys()].filter((p) => fs.existsSync(path.join(root, ...p.split("/"))));
  const now = paths.length ? git(["hash-object", "--stdin-paths"], root, paths.join("\n") + "\n").toString("utf8").trim().split("\n") : [];
  paths.forEach((p, i) => seen.get(p).delete(now[i]));
  const blobs = {}, want = [];
  for (const p of [...seen.keys()].sort()) {
    const ids = [...seen.get(p)].sort();
    if (!ids.length) continue;
    blobs[p] = ids;
    if (TEXTS.test(p)) for (const id of ids) want.push([p, id]);
  }
  const texts = {};
  const out = want.length ? git(["cat-file", "--batch"], root, want.map(([, id]) => id).join("\n") + "\n") : null;
  let at = 0;
  for (const [p, id] of want) {
    const nl = out.indexOf(10, at), size = Number(out.toString("utf8", at, nl).split(" ")[2]);
    at = nl + 1;
    (texts[p] = texts[p] || {})[id] = out.toString("utf8", at, at + size);
    at += size + 1;
  }
  return { blobs, texts };
}

const render = (v) => JSON.stringify(v, null, 2) + "\n";

// the list have against compute(root): { strict, own, other, extra }, each a list of [path, id]. own: versions it
// lacks that a commit in merge-base(HEAD, base)..HEAD superseded, the branch's own to add; other: the rest it lacks,
// superseded elsewhere (two PRs merged together), left to a later run on main; extra: what it lists that compute()
// does not. strict (no base ref, or a shallow clone): every version it lacks counts as own.
function audit(root = ROOT, have = JSON.parse(fs.readFileSync(FILE, "utf8")), base = "origin/main") {
  const want = compute(root);
  const ids = (o, p) => new Set(((o && o.blobs) || {})[p] || []);
  const text = (o, p, id) => (((o && o.texts) || {})[p] || {})[id];
  const missing = [], extra = [];
  for (const [p, list] of Object.entries(want.blobs)) {
    const h = ids(have, p);
    for (const id of list) if (!h.has(id) || (text(want, p, id) !== undefined && text(have, p, id) !== text(want, p, id))) missing.push([p, id]);
  }
  for (const [p, list] of Object.entries((have && have.blobs) || {})) { const w = ids(want, p); for (const id of list) if (!w.has(id)) extra.push([p, id]); }
  for (const [p, t] of Object.entries((have && have.texts) || {})) for (const id of Object.keys(t)) if (text(want, p, id) === undefined) extra.push([p, id]);
  const out = (strict, own, other) => ({ strict, own, other, extra });
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, windowsHide: true });
  const shallow = run(["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false";
  const mb = shallow ? null : run(["merge-base", "HEAD", base]);
  if (!mb || mb.status !== 0) return out(true, missing, []);
  // the versions this branch's own commits replaced or deleted: the old blob of each change in the range
  const raw = git(["log", "--no-merges", "--format=", "--raw", "--no-abbrev", "--no-renames", `${mb.stdout.trim()}..HEAD`, "--", "agents", "templates"], root);
  const mine = new Set(raw.split("\n").map((l) => /^:\d+ \d+ ([0-9a-f]+) [0-9a-f]+ \w+\t(.+)$/.exec(l)).filter(Boolean).map(([, id, p]) => `${p}\0${id}`));
  return out(false, missing.filter(([p, id]) => mine.has(`${p}\0${id}`)), missing.filter(([p, id]) => !mine.has(`${p}\0${id}`)));
}

if (require.main === module) {
  try {
    fs.writeFileSync(FILE, render(compute()));
    console.log(`wrote ${path.relative(process.cwd(), FILE)}`);
  } catch (e) {
    console.error(`known-blobs: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { compute, render, audit, FILE };
