#!/usr/bin/env node
// The intake synthesis's coverage check (operations.md): every finding in the notes maps to exactly one outcome.
//   node <hooks>/proteus-intake-coverage.js <notes-file> <draft-file>
// notes-file: the intake issue's comment bodies in comment order (`gh api repos/{owner}/{repo}/issues/<n>/comments
// --jq '.[].body'`); only `Source:` lines and the finding lines under `### Findings` count, each `- <id> <at> ...`.
// draft-file: the drafter's draft, `## Draft <k>: <title>` sections, then `## Coverage` with one row per finding:
// `| <id> | issue <k> |`, `| <id> | shipped <file> |`, `| <id> | candidate |` or `| <id> | rejected <reason> |`.
// Exit 0 when coverage is exact; 1 listing each finding unmapped, mapped twice, or cited by a draft its row does not
// name, and each row with an unknown id or outcome; 2 on usage, an unreadable file, or a note that predates finding
// ids. Reads the two files only: no network, no git.
"use strict";
const fs = require("fs");

const HELP = `usage: node proteus-intake-coverage.js <notes-file> <draft-file>
Checks the intake draft's coverage table against the notes: every finding maps to exactly one outcome.
  notes-file  the intake issue's comment bodies, in comment order:
              gh api repos/{owner}/{repo}/issues/<n>/comments --jq '.[].body' > notes.md
  draft-file  "## Draft <k>: <title>" sections citing their supporting finding ids, then "## Coverage",
              a table with one row per finding: | <id> | issue <k> | shipped <file> | candidate | rejected <reason> |
Exit 0 on exact coverage; 1 listing every finding unmapped, mapped twice or cited by the wrong draft, and every
row with an unknown id or outcome; 2 on usage, an unreadable file, or a note that predates finding ids.`;

const ID = /\b[0-9a-f]{6}-F\d+\b/g;
const FINDING = /^- ([0-9a-f]{6}-F\d+) \d{1,2}(:\d{2}){1,2}(-\d{1,2}(:\d{2}){1,2})? \[/;
const OLD = /^- \d{1,2}(:\d{2}){1,2}(-\d{1,2}(:\d{2}){1,2})? \[[\d,]+\] /;
const OUTCOME = /^(issue (\d+)|shipped \S.*|candidate|rejected \S.*)$/;

// { ids: [id, ...] in order, old: [source, ...] } from the notes' Source and finding lines
function parseNotes(text) {
  const ids = [], old = [];
  let source = "", inFindings = false;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith("Source: ")) { source = l.slice(8).trim(); inFindings = false; continue; }
    if (/^#{2,3} /.test(l)) { inFindings = l === "### Findings"; continue; }
    if (!inFindings) continue;
    const m = FINDING.exec(l);
    if (m) ids.push(m[1]);
    else if (OLD.test(l) && !old.includes(source)) old.push(source);
  }
  return { ids, old };
}

// { drafts: Map(k -> Set(id cited)), rows: [{ id, outcome, issue }] }
function parseDraft(text) {
  const drafts = new Map(), rows = [];
  let cur = null, coverage = false;
  for (const l of text.split(/\r?\n/)) {
    const h = /^## (Draft (\d+)\b|Coverage\b)?/.exec(l);
    if (h) { coverage = h[1] === "Coverage"; cur = h[2] ? (drafts.get(+h[2]) || drafts.set(+h[2], new Set()).get(+h[2])) : null; continue; }
    if (cur) for (const id of l.match(ID) || []) cur.add(id);
    if (!coverage || !l.trim().startsWith("|")) continue;
    const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (!/^[0-9a-f]{6}-F\d+$/.test(cells[0])) continue;
    const outcome = cells.slice(1).join(" | ").replace(/`/g, "").trim(), m = OUTCOME.exec(outcome);
    rows.push({ id: cells[0], outcome, ok: !!m, issue: m && m[2] ? +m[2] : null });
  }
  return { drafts, rows };
}

// the problems, [] on exact coverage
function check(notes, draft) {
  const { ids } = parseNotes(notes), { drafts, rows } = parseDraft(draft), bad = [];
  const known = new Set(ids), byId = new Map();
  for (const r of rows) {
    if (!known.has(r.id)) { bad.push(`${r.id}: in the coverage table but not a finding in the notes`); continue; }
    if (!r.ok) bad.push(`${r.id}: outcome "${r.outcome}" is not issue <k>, shipped <file>, candidate or rejected <reason>`);
    else if (r.issue !== null && !drafts.has(r.issue)) bad.push(`${r.id}: issue ${r.issue} is not a drafted issue`);
    (byId.get(r.id) || byId.set(r.id, []).get(r.id)).push(r);
  }
  for (const id of ids) {
    const rs = byId.get(id) || [];
    if (!rs.length) bad.push(`${id}: unmapped`);
    else if (rs.length > 1) bad.push(`${id}: mapped ${rs.length} times (${rs.map((r) => r.outcome).join("; ")})`);
    const cited = [...drafts].flatMap(([k, s]) => (s.has(id) ? [k] : []));
    const want = rs.length === 1 && rs[0].issue !== null ? rs[0].issue : null;
    for (const k of cited) if (k !== want) bad.push(`${id}: cited by draft ${k} but its row is ${rs.length === 1 ? `"${rs[0].outcome}"` : "not one row"}`);
  }
  return bad;
}

function main(args) {
  if (args[0] === "--help" || args[0] === "-h") { console.log(HELP); return 0; }
  if (args.length !== 2) { console.error(HELP); return 2; }
  let notes, draft;
  try { notes = fs.readFileSync(args[0], "utf8"); draft = fs.readFileSync(args[1], "utf8"); } catch (e) { console.error(`proteus-intake-coverage: ${e.message}`); return 2; }
  const { ids, old } = parseNotes(notes);
  if (old.length) { console.error(`proteus-intake-coverage: note predates finding ids; re-post it: ${old.join(", ")}`); return 2; }
  const bad = check(notes, draft);
  if (bad.length) { console.error(`proteus-intake-coverage: ${bad.length} problem(s):\n  ${bad.join("\n  ")}`); return 1; }
  console.log(`intake coverage: ${ids.length} findings, each mapped once`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseNotes, parseDraft, check };
