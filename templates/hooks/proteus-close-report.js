#!/usr/bin/env node
// Close report for a run: node <hooks>/proteus-close-report.js [run] [--no-cost | --cost-json <file>]
// Prints Markdown for the run-log issue and the close PR body: one row per ticket, one per team, and a summary.
//   bounces       BACK-TO-WORKER verdicts on the ticket's PRs (reviews and comments)
//   escalations   RED reports and CONTRACT-WRONG verdicts on the ticket or its PRs: each moved it up a rung
//   wall-clock    issue created → closed (open tickets: so far, marked open)
// Bounce and escalation rate: share of tickets with at least one. The team rows (profile:<team>, difficulty:<d>)
// are what tunes ROUTING.md and the difficulty call. A `SUGGEST re-scout: <reason>` line follows per signal that the
// teams themselves need a redesign: routing misses, one team over half of 6+ tickets, a team of 3+ tickets bouncing over 40%.
// --save <file> also writes what it read from the tracker, as {run, issues, prs, logs} with each PR's checks and the
// run log's comments, for proteus-retro.js, which reads files only.
// Cost comes from ccusage at the version enforcement.md §5 pins (Codex: @ccusage/codex), summed over the
// sessions the journal saw a human message in between the run log's creation and the last ticket's close.
// ccusage reports per session, not per ticket, so cost per ticket is that sum over closed tickets: an
// average. --cost-json reads a saved `ccusage session --json`; --no-cost skips it. Exit 1 when the tracker
// cannot be read or --save cannot write.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
const ad = require(path.join(__dirname, "proteus-harness.js"));

const CCUSAGE = { claude: ["-y", "ccusage@20.0.26", "session", "--json"], codex: ["-y", "@ccusage/codex@19.0.0", "session", "--json"] };
const USAGE = "usage: node proteus-close-report.js [run] [--no-cost | --cost-json <file>] [--save <file>]";

let arg = "";
const HELP = `${USAGE}
Markdown for the run-log issue and the close PR body: one row per ticket, one per team, and a summary
(bounces, escalations, wall-clock, cost). The team rows are what tunes ROUTING.md and the difficulty call;
a SUGGEST re-scout line names a sign the teams need a redesign.
  [run]               the run; default the open proteus/<run> branch
  --no-cost           skip the ccusage cost columns
  --cost-json <file>  read a saved \`ccusage session --json\` instead of running ccusage
  --save <file>       also write the tracker data it read, with PR checks and run-log comments, for proteus-retro.js
Exit 1 when the tracker cannot be read or --save cannot write; 2 on bad usage or no run.`;
if (process.argv[2] === "--help" || process.argv[2] === "-h") { console.log(HELP); process.exit(0); }
let cost = "ccusage";
let save = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--no-cost") cost = "";
  else if (argv[i] === "--cost-json" && argv[i + 1]) cost = argv[++i];
  else if (argv[i] === "--save" && argv[i + 1]) save = argv[++i];
  else if (!argv[i].startsWith("-") && !arg) arg = argv[i];
  else { console.error(USAGE + "\n(--help explains each flag)"); process.exit(2); }
}

const root = path.resolve(lib.projectRoot());
const common = lib.gitCommonDir(root);
const runBranches = common ? lib.runBranches(common) : [];
const run = lib.runName(arg || runBranches[0] || "");
if (!run) { console.error(`no run named and no open ${lib.CURRENT.branch}<run> branch`); process.exit(2); }
const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,title,state,createdAt,closedAt,milestone,labels,comments", "--limit", "500"], root, 30000));
if (!Array.isArray(issues)) { console.error(`run ${run}: tracker unreachable (gh issue list failed)`); process.exit(1); }
const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "all", "--json", `number,headRefName,body,reviews,comments${save ? ",statusCheckRollup" : ""}`, "--limit", "500"], root, 30000)) || [];
const logs = parse(lib.gh(["issue", "list", "--label", names.log, "--state", "all", "--json", `number,title,createdAt,comments`, "--limit", "100"], root, 10000)) || [];
if (save) saveTracker(save);

const tickets = lib.runTickets(issues, run, names);
const ticketOf = (pr) => lib.prTicket(pr, run, names);
const BOUNCE = lib.verdictIs("bounce");
const ESCALATION = lib.verdictIs("escalation");
const label = (i, prefix) => ((i.labels || []).map((l) => l.name).find((n) => n.startsWith(prefix)) || "").slice(prefix.length);
const isOpen = (i) => String(i.state).toUpperCase() === "OPEN";
const now = Date.now();

const rows = tickets.map((i) => {
  const own = prs.filter((p) => ticketOf(p) === i.number);
  const prNotes = own.flatMap((p) => [...(p.reviews || []), ...(p.comments || [])]);
  const end = isOpen(i) ? now : Date.parse(i.closedAt || "") || now;
  return {
    n: i.number, title: String(i.title || "").replace(/\|/g, "/").slice(0, 60), team: label(i, "profile:") || "?", diff: label(i, "difficulty:") || "?",
    prs: own.length, bounces: prNotes.filter(BOUNCE).length, escalations: [...(i.comments || []), ...prNotes].filter(ESCALATION).length,
    ms: Math.max(0, end - (Date.parse(i.createdAt || "") || end)), open: isOpen(i),
  };
});

const pct = (part, all) => (all ? `${Math.round((100 * part) / all)}%` : "n/a");
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function fmt(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d${h}h` : h ? `${h}h${mm ? mm + "m" : ""}` : `${mm}m`;
}
const rates = (rs) => {
  const closed = rs.filter((r) => !r.open);
  return { bounce: pct(rs.filter((r) => r.bounces).length, rs.length), escalation: pct(rs.filter((r) => r.escalations).length, rs.length), wall: closed.length ? fmt(median(closed.map((r) => r.ms))) : "n/a" };
};

const out = [`## Close report: ${run}`, ""];
out.push("| # | ticket | team | difficulty | PRs | bounces | escalations | wall-clock |", "|---|---|---|---|---|---|---|---|");
for (const r of rows) out.push(`| #${r.n} | ${r.title} | ${r.team} | ${r.diff} | ${r.prs} | ${r.bounces} | ${r.escalations} | ${fmt(r.ms)}${r.open ? " (open)" : ""} |`);
if (!rows.length) out.push("| – | no tickets in a milestone under this run | | | | | | |");

out.push("", "| team | difficulty | tickets | bounce rate | escalation rate | median wall-clock |", "|---|---|---|---|---|---|");
const groups = [...new Set(rows.map((r) => `${r.team}\0${r.diff}`))].sort();
for (const g of groups) {
  const [team, diff] = g.split("\0");
  const rs = rows.filter((r) => r.team === team && r.diff === diff);
  const t = rates(rs);
  out.push(`| ${team} | ${diff} | ${rs.length} | ${t.bounce} | ${t.escalation} | ${t.wall} |`);
}

const all = rates(rows);
const closed = rows.filter((r) => !r.open).length;
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const c = costLine(closed);
out.push("", `Run: ${rows.length} tickets, ${closed} closed · bounce rate ${all.bounce} (${count(rows.reduce((s, r) => s + r.bounces, 0), "bounce")}) · escalation rate ${all.escalation} (${count(rows.reduce((s, r) => s + r.escalations, 0), "escalation")}) · median wall-clock ${all.wall} · ${c}`);

// re-scout signals (#82). A routing miss is a ticket with no profile: label: the tracker shows each ticket's labels,
// not when a ROUTING.md row was added
const unrouted = rows.filter((r) => r.team === "?");
if (unrouted.length) out.push(`SUGGEST re-scout: ${count(unrouted.length, "ticket")} of ${rows.length} with no profile: label (routing misses ${unrouted.map((r) => `#${r.n}`).join(", ")})`);
for (const team of [...new Set(rows.map((r) => r.team))].filter((t) => t !== "?").sort()) {
  const rs = rows.filter((r) => r.team === team);
  const b = rs.reduce((s, r) => s + r.bounces, 0);
  if (rows.length >= 6 && rs.length * 2 > rows.length) out.push(`SUGGEST re-scout: team ${team} holds ${rs.length} of ${rows.length} tickets (${pct(rs.length, rows.length)}, over 50%)`);
  if (rs.length >= 3 && b * 10 > rs.length * 4) out.push(`SUGGEST re-scout: team ${team} bounced ${count(b, "time")} over ${rs.length} tickets (${pct(b, rs.length)} BACK-TO-WORKER per ticket, over 40%)`);
}
// checks the run skipped (enforcement.md §10c, teams.md): the human decides on these, so the report names them
const skipped = [...new Set(((lib.runLogOf(logs, run) || {}).comments || []).flatMap((c) => String((c && c.body) || "").split(/\r?\n/).filter((l) => /^\S+: skipped \(.*\)\s*$/.test(l)).map((l) => l.trim())))];
if (skipped.length) out.push("", "Skipped checks, for the human to decide:", ...skipped.map((l) => `- ${l}`));
console.log(out.join("\n"));

// --save: what the tracker gave, for proteus-retro.js, at the path the retro helper names (its scratch dir)
function saveTracker(file) {
  try { fs.writeFileSync(file, JSON.stringify({ run, issues, prs, logs }) + "\n"); } catch (e) { console.error(`cannot write ${file}: ${e.message}`); process.exit(1); }
}

// the sessions this run's lead had: journal entries (session ids of human messages) inside the run's window
function runSessions() {
  const log = lib.runLogOf(logs, run);
  const starts = tickets.map((i) => Date.parse(i.createdAt || "")).filter(Number.isFinite);
  const from = (log && Date.parse(log.createdAt || "")) || (starts.length ? Math.min(...starts) : 0);
  const ends = tickets.map((i) => (isOpen(i) ? now : Date.parse(i.closedAt || ""))).filter(Number.isFinite);
  const to = ends.length ? Math.max(...ends) : now;
  const ids = new Set();
  let text = "";
  try { text = fs.readFileSync(lib.leadPath(common, "journal.jsonl"), "utf8"); } catch {}
  for (const line of text.split("\n")) {
    const e = parse(line);
    const t = e && Date.parse(e.ts || "");
    if (e && e.session_id && t >= from && t <= to) ids.add(String(e.session_id));
  }
  return ids;
}

function costLine(closedCount) {
  if (!cost) return "cost not read (--no-cost)";
  let raw = "";
  try {
    if (cost === "ccusage") {
      const r = lib.spawnArgv("npx", CCUSAGE[ad.name] || CCUSAGE.claude, { cwd: root, timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      if (r.error || r.status !== 0) throw r.error || new Error(`npx exited ${r.status}`);
      raw = r.stdout;
    } else raw = fs.readFileSync(cost, "utf8");
  } catch (e) { return `cost n/a (${cost === "ccusage" ? "ccusage failed" : `cannot read ${cost}`}: ${String(e.message || e).split("\n")[0].slice(0, 80)})`; }
  const j = parse(raw);
  const list = j && (j.sessions || j.session || j.data);
  if (!Array.isArray(list)) return "cost n/a (ccusage printed no session list)";
  const ids = runSessions();
  if (!ids.size) return "cost n/a (no journal entry inside the run's window)";
  let sum = 0;
  let found = 0;
  for (const s of list) {
    const id = String((s && (s.sessionId || s.session_id || s.period || s.id)) || "");
    if (!ids.has(id) && !ids.has(id.split(/[\\/]/).pop())) continue;
    found++;
    sum += +(s.totalCost ?? s.costUSD ?? s.cost ?? 0) || 0;
  }
  if (!found) return `cost n/a (none of the run's ${ids.size} sessions in ccusage's report)`;
  const each = closedCount ? `$${(sum / closedCount).toFixed(2)} per closed ticket (average; ccusage does not split by ticket)` : "no closed ticket to divide by";
  return `cost $${sum.toFixed(2)} over ${found} session${found === 1 ? "" : "s"}, ${each}`;
}
