#!/usr/bin/env node
// Close report for a run: node <hooks>/proteus-close-report.js [run] [--no-cost | --cost-json <file>]
// Prints Markdown for the run-log issue and the close PR body: one row per ticket, one per team, and a summary.
//   bounces       BACK-TO-WORKER verdicts on the ticket's PRs (reviews and comments)
//   escalations   RED reports and CONTRACT-WRONG verdicts on the ticket or its PRs: each moved it up a rung
//   wall-clock    issue created → closed (open tickets: so far, marked open)
// Bounce and escalation rate: share of tickets with at least one. The team rows (profile:<team>, difficulty:<d>)
// are what tunes ROUTING.md and the difficulty call.
// Cost comes from ccusage at the version enforcement.md §5 pins (Codex: @ccusage/codex), summed over the
// sessions the journal saw a human message in between the run log's creation and the last ticket's close.
// ccusage reports per session, not per ticket, so cost per ticket is that sum over closed tickets: an
// average. --cost-json reads a saved `ccusage session --json`; --no-cost skips it. Exit 1 when the tracker
// cannot be read.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const ad = require(path.join(__dirname, "proteus-harness.js"));

const CCUSAGE = { claude: ["-y", "ccusage@20.0.26", "session", "--json"], codex: ["-y", "@ccusage/codex@19.0.0", "session", "--json"] };
const USAGE = "usage: node proteus-close-report.js [run] [--no-cost | --cost-json <file>]";

let arg = "";
let cost = "ccusage";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--no-cost") cost = "";
  else if (argv[i] === "--cost-json" && argv[i + 1]) cost = argv[++i];
  else if (!argv[i].startsWith("-") && !arg) arg = argv[i];
  else { console.error(USAGE); process.exit(2); }
}

const root = path.resolve(lib.projectRoot());
const common = lib.gitCommonDir(root);
const runBranches = common ? lib.runBranches(common) : [];
const run = lib.runName(arg || runBranches[0] || "");
if (!run) { console.error(`no run named and no open ${lib.CURRENT.branch}<run> branch`); process.exit(2); }
const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
const NOT_TICKET = new Set([names.review, names.log, names.debt, names.question]);

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,title,state,createdAt,closedAt,milestone,labels,comments", "--limit", "500"], root, 30000));
if (!Array.isArray(issues)) { console.error(`run ${run}: tracker unreachable (gh issue list failed)`); process.exit(1); }
const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "all", "--json", "number,headRefName,body,reviews,comments", "--limit", "500"], root, 30000)) || [];
const logs = parse(lib.gh(["issue", "list", "--label", names.log, "--state", "all", "--json", "number,title,createdAt", "--limit", "100"], root, 10000)) || [];

const tickets = issues.filter((i) => i.milestone && String(i.milestone.title).startsWith(run + "/") && !String(i.title || "").startsWith("Revision ") &&
  !(i.labels || []).some((l) => NOT_TICKET.has(l.name))).sort((a, b) => a.number - b.number);

// a PR's ticket: the number its head ends in (proteus-work/<run>/<id>, or <run>-<id> before the rename), else Closes #n
const workHeads = [`${lib.CURRENT.work}${run}/`, `${names.branch}${run}-`];
function ticketOf(pr) {
  const head = String(pr.headRefName || "");
  const pre = workHeads.find((p) => head.startsWith(p));
  const m = (pre && /^(\d+)$/.exec(head.slice(pre.length))) || /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)\b/i.exec(pr.body || "");
  return m ? +m[1] : 0;
}
const firstWord = (re) => (c) => re.test(String((c && c.body) || ""));
const BOUNCE = firstWord(/^\s*(\*\*)?BACK-TO-WORKER\b/);
const ESCALATION = firstWord(/^\s*(\*\*)?(RED|CONTRACT-WRONG)\b/);
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
console.log(out.join("\n"));

// the sessions this run's lead had: journal entries (session ids of human messages) inside the run's window
function runSessions() {
  const log = logs.find((l) => new RegExp(`(^|[\\s:])${run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(String(l.title || "")));
  const starts = tickets.map((i) => Date.parse(i.createdAt || "")).filter(Number.isFinite);
  const from = (log && Date.parse(log.createdAt || "")) || (starts.length ? Math.min(...starts) : 0);
  const ends = tickets.map((i) => (isOpen(i) ? now : Date.parse(i.closedAt || ""))).filter(Number.isFinite);
  const to = ends.length ? Math.max(...ends) : now;
  const ids = new Set();
  let text = "";
  try { text = fs.readFileSync(path.join(lib.stateDir(common), "journal.jsonl"), "utf8"); } catch {}
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
    raw = cost === "ccusage"
      ? execFileSync("npx", CCUSAGE[ad.name] || CCUSAGE.claude, { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32", windowsHide: true })
      : fs.readFileSync(cost, "utf8");
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
