#!/usr/bin/env node
// One status line for the human: node .claude/hooks/proteus-status.js [run] [--json]
// Run (open proteus/<run> branch or the argument), the policy's preset (proteus-policy.js, #307), current open
// milestone and its tickets closed,
// open PRs into proteus/<run> and how many carry a verdict, and an ETA:
// median ticket time (closedAt − createdAt over the run's closed tickets) × open tickets
// in the milestone ÷ parallelism (open PRs + worker branches without a PR, min 1).
// --json (#311, the run panel mod): one JSON object and nothing else, state "ok", "no-run" or "unreachable" (gh
// failed), with the line's facts as fields plus what waits on the human: open proteus-question issues and open
// proteus-review issues still labelled needs-human, each { number, title, url }. Exit 0 in every state.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const Policy = require(path.join(__dirname, "proteus-policy.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log("usage: node proteus-status.js [run] [--json]\nOne status line: the run (default the open proteus/<run> branch), the policy's preset, its open milestone and\ntickets closed, open PRs and how many carry a verdict, and an ETA from the median ticket time.\n--json: the same facts and what waits on the human (open questions, milestone reviews) as one JSON object.");
  process.exit(0);
}
const asJson = argv.includes("--json");
const say = (line, obj) => console.log(asJson ? JSON.stringify({ version: 1, ...obj }) : line);
const root = path.resolve(lib.projectRoot());

const common = lib.gitCommonDir(root);
const branches = lib.runRefs(common);
const runBranches = lib.runBranches(common);
const arg = argv.find((a) => a !== "--json") || "";
const run = lib.runName(arg || runBranches[0] || "");
if (!run) { say(`no open run (no ${lib.CURRENT.branch}<run> branch)`, { state: "no-run" }); return; }
const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,state,createdAt,closedAt,milestone,labels", "--limit", "500"], root, 10000));
if (!Array.isArray(issues)) { say(`run ${run} · tracker unreachable (gh issue list failed)`, { state: "unreachable", run }); return; }
const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "open", "--json", `number,headRefName,reviews,comments${asJson ? ",title,url" : ""}`, "--limit", "100"], root, 10000)) || [];

const tickets = lib.runTickets(issues, run, names);
const isOpen = (i) => String(i.state).toUpperCase() === "OPEN";
const openMs = tickets.filter(isOpen).map((i) => i.milestone);
const ms = openMs.sort((a, b) => a.number - b.number)[0] || tickets.map((i) => i.milestone).sort((a, b) => b.number - a.number)[0];

const preset = Policy.load({ root }).policy.preset;
const parts = [`run ${run}`, `policy ${preset}`];
let remaining = 0, milestone = null;
if (ms) {
  const inMs = tickets.filter((i) => i.milestone.number === ms.number);
  remaining = lib.milestoneOpen(run, ms.title, { issues: tickets, names }).length;
  milestone = { title: ms.title, closed: inMs.length - remaining, total: inMs.length };
  parts.push(`milestone ${ms.title} ${inMs.length - remaining}/${inMs.length} closed`);
} else parts.push("no milestone yet");

const verdict = /^\s*(\*\*)?(MERGE|BACK-TO-WORKER|CONTRACT-WRONG)\b/;
const hasVerdict = (p) => [...(p.reviews || []), ...(p.comments || [])].some((c) => verdict.test((c && c.body) || ""));
const withVerdict = prs.filter(hasVerdict).length;
parts.push(`${prs.length} PRs open (${withVerdict} verdict)`);

const heads = new Set(prs.map((p) => p.headRefName));
const inProgress = branches.filter((b) => (b.startsWith(`${names.branch}${run}-`) || b.startsWith(`${lib.CURRENT.work}${run}/`)) && !heads.has(b)).length;
const parallel = Math.max(1, prs.length + inProgress);
const took = tickets.filter((i) => !isOpen(i) && i.closedAt && i.createdAt).map((i) => Date.parse(i.closedAt) - Date.parse(i.createdAt)).filter((d) => d > 0).sort((a, b) => a - b);
let eta = { ms: null, medianMs: null };
if (took.length < 2) parts.push(`eta: n/a (need 2 closed tickets)`);
else {
  const med = took.length % 2 ? took[(took.length - 1) / 2] : (took[took.length / 2 - 1] + took[took.length / 2]) / 2;
  eta = { ms: remaining ? Math.round((med * remaining) / parallel) : 0, medianMs: med };
  parts.push(remaining ? `eta ~${fmt((med * remaining) / parallel)} (median ${fmt(med)}/ticket)` : `eta: milestone tickets done (median ${fmt(med)}/ticket)`);
}
if (!asJson) { console.log(parts.join(" · ")); return; }

// what waits on the human: a failed read is the tracker unreachable, never an empty list
const item = (i) => ({ number: i.number, title: String(i.title || ""), url: String(i.url || "") });
const waiting = (labels) => parse(lib.gh(["issue", "list", "--state", "open", ...labels.flatMap((l) => ["--label", l]), "--json", "number,title,url", "--limit", "100"], root, 10000));
const questions = waiting([names.question]);
const reviews = waiting([names.review, "needs-human"]);
if (!Array.isArray(questions) || !Array.isArray(reviews)) { say("", { state: "unreachable", run }); return; }
say("", {
  state: "ok", run, policy: preset, milestone,
  prs: { open: prs.length, verdict: withVerdict, items: prs.map((p) => ({ ...item(p), verdict: hasVerdict(p) })) },
  inProgress, eta,
  waiting: { questions: questions.map(item), reviews: reviews.map(item) },
  line: parts.join(" · "),
});

function fmt(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d${h}h` : h ? `${h}h${mm ? mm + "m" : ""}` : `${mm}m`;
}
