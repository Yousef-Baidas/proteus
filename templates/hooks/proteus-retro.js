#!/usr/bin/env node
// Close retro for a run (#193): node <hooks>/proteus-retro.js --from <file>
// Groups the run's recurring problems for the step-8 retro, one JSON line per group: {kind, key, count, refs}.
//   back-to-worker     BACK-TO-WORKER verdicts with the same reason (trimmed, lowercased, whitespace collapsed)
//   escalation         RED reports and CONTRACT-WRONG verdicts with the same word and reason
//   guard-violation    guard-violation records (proteus-shell-check.js) of the same rule: the guarded path, relative to
//                      its worktree, or a lost snapshot, or another worktree changed
//   classifier-denial  `BLOCKED #<n> classifier <tag>: <action>` reports with the same tag and command shape (the
//                      command, and its subcommand when the second word is a plain word: `git push`, `curl`)
//   red-gate           a check still failing on a PR's last head, by check name (the verifiers' signoffs left out)
// A group is printed only with 2 or more occurrences. <file> is what `proteus-close-report.js <run> --save <file>` wrote
// (the run, its issues, PRs and run logs); the guard records are read from <git-common-dir>/proteus-lead. Files only:
// no network, no git writes. Exit 0 (nothing printed: nothing recurred), 2 on bad usage or an unreadable <file>.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir

const USAGE = "usage: node proteus-retro.js --from <file>";
const HELP = `${USAGE}
The run's recurring problems, one JSON line per group: {kind, key, count, refs}, only groups of 2 or more.
Kinds: back-to-worker (same reason), escalation (RED or CONTRACT-WRONG, same reason), guard-violation (same
guarded path), classifier-denial (same tag and command shape), red-gate (same check failing on a PR's last head).
  --from <file>  what \`proteus-close-report.js <run> --save <file>\` wrote
Reads files only: <file> and the guard-violation records in <git-common-dir>/proteus-lead/tamper.
Exit 0, nothing printed when nothing recurred; 2 on bad usage or an unreadable <file>.`;

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") { console.log(HELP); process.exit(0); }
if (argv.length !== 2 || argv[0] !== "--from") { console.error(USAGE + "\n(--help explains it)"); process.exit(2); }
const data = lib.readJSON(argv[1], null);
const run = data && typeof data.run === "string" ? data.run : "";
if (!run) { console.error(`${argv[1]}: not a saved close report; run proteus-close-report.js <run> --save ${argv[1]} first`); process.exit(2); }

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
const body = (c) => String((c && c.body) || "");
// the reason after the verdict word and the ticket number it may name
const reason = (c) => norm(body(c).replace(/^\s*(\*\*)?[A-Z-]+(\*\*)?\s*(#\d+)?/, ""));

const groups = new Map();
function add(kind, key, ref) {
  const id = `${kind}\0${key}`;
  const g = groups.get(id) || { kind, key, count: 0, refs: new Set() };
  g.count++;
  if (ref) g.refs.add(ref);
  groups.set(id, g);
}

const tickets = lib.runTickets(data.issues, run);
const prs = (Array.isArray(data.prs) ? data.prs : []).filter((p) => p && p.number);
const log = lib.runLogOf(data.logs, run);
const notes = [
  ...tickets.flatMap((i) => (i.comments || []).map((c) => [c, `#${i.number}`])),
  ...prs.flatMap((p) => [...(p.reviews || []), ...(p.comments || [])].map((c) => [c, `#${p.number}`])),
  ...((log && log.comments) || []).map((c) => [c, `#${log.number}`]),
];

const bounce = lib.verdictIs("bounce"), escalation = lib.verdictIs("escalation");
for (const [c, ref] of notes) {
  if (bounce(c)) add("back-to-worker", reason(c), ref);
  else if (escalation(c)) add("escalation", `${/(RED|CONTRACT-WRONG)/.exec(body(c))[1]}: ${reason(c)}`, ref);
  for (const m of body(c).matchAll(/^\s*BLOCKED #\d+ classifier (\S+?):? (.+)$/gm)) {
    const words = norm(m[2]).split(" ");
    const command = [words[0], ...(/^[a-z][a-z0-9-]*$/.test(words[1] || "") ? [words[1]] : [])].join(" ");
    add("classifier-denial", `${m[1]}: ${command}`, ref);
  }
}

// a check red on a PR's last head; proteus/verdict and proteus/security are the verifiers' signoffs, not gates
const RED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
for (const p of prs) {
  const red = new Set();
  for (const k of p.statusCheckRollup || []) {
    const name = String((k && (k.name || k.context)) || "");
    if (name && !/^proteus\/(verdict|security)$/.test(name) && RED.has(String(k.conclusion || k.state || "").toUpperCase())) red.add(name);
  }
  for (const name of red) add("red-gate", name, `#${p.number}`);
}

// guard-violation records of the run's worker branches: open items and the history of closed ones
const common = lib.gitCommonDir(path.resolve(lib.projectRoot()));
if (common) {
  let dir = "", names = [];
  try { dir = require(path.join(__dirname, "proteus-shell-check.js")).tamperDir(common); names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch {}
  const mine = (b) => b.startsWith(`${lib.CURRENT.work}${run}/`) || b.startsWith(`${lib.CURRENT.branch}${run}-`);
  const slash = (p) => p.split(path.sep).join("/");
  const rel = (abs, wt) => {
    for (const base of [wt, path.dirname(common)]) {
      const r = base ? path.relative(base, abs) : "";
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) return slash(r);
    }
    return slash(abs);
  };
  for (const n of names.sort()) {
    const rec = lib.readJSON(path.join(dir, n), null);
    if (!rec || !mine(String(rec.branch || ""))) continue;
    for (const i of [...(rec.items || []), ...(rec.history || [])]) {
      const key = i && i.kind === "path" && i.path ? `path ${rel(String(i.path), rec.worktree || "")}` : i && i.kind === "snapshot" ? "snapshot lost" : i && i.kind === "sibling" ? "another worktree changed" : "";
      if (key) add("guard-violation", key, rec.branch);
    }
  }
}

const ORDER = ["back-to-worker", "escalation", "guard-violation", "classifier-denial", "red-gate"];
const out = [...groups.values()].filter((g) => g.count >= 2)
  .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
for (const g of out) console.log(JSON.stringify({ kind: g.kind, key: g.key, count: g.count, refs: [...g.refs].sort((a, b) => a.localeCompare(b, "en", { numeric: true })) }));
