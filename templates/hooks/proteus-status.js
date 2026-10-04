#!/usr/bin/env node
// One status line for the human: node .claude/hooks/proteus-status.js [run]
// Run (open proteus/<run> branch or the argument), current open milestone and its tickets closed,
// open PRs into proteus/<run> and how many carry a verdict, and an ETA:
// median ticket time (closedAt − createdAt over the run's closed tickets) × open tickets
// in the milestone ÷ parallelism (open PRs + worker branches without a PR, min 1).
// A run opened before the rename is read under its legacy names (lib.LEGACY) until it closes.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const root = path.resolve(lib.projectRoot());

// both branch prefixes: a run opened before the rename keeps its legacy branch, labels and PR base
const common = lib.gitCommonDir(root);
const branches = lib.runRefs(common);
const runBranches = lib.runBranches(common);
const arg = process.argv[2] || "";
const run = lib.runName(arg || runBranches[0] || "");
if (!run) { console.log(`no open run (no ${lib.CURRENT.branch}<run> branch)`); return; }
const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
const NOT_TICKET = new Set([names.review, names.log, names.debt]);

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,state,createdAt,closedAt,milestone,labels", "--limit", "500"], root, 10000));
if (!Array.isArray(issues)) { console.log(`run ${run} · tracker unreachable (gh issue list failed)`); return; }
const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "open", "--json", "number,headRefName,reviews,comments", "--limit", "100"], root, 10000)) || [];

const tickets = issues.filter((i) => i.milestone && String(i.milestone.title).startsWith(run + "/") && !(i.labels || []).some((l) => NOT_TICKET.has(l.name)));
const isOpen = (i) => String(i.state).toUpperCase() === "OPEN";
const openMs = tickets.filter(isOpen).map((i) => i.milestone);
const ms = openMs.sort((a, b) => a.number - b.number)[0] || tickets.map((i) => i.milestone).sort((a, b) => b.number - a.number)[0];

const parts = [`run ${run}`];
let remaining = 0;
if (ms) {
  const inMs = tickets.filter((i) => i.milestone.number === ms.number);
  remaining = inMs.filter(isOpen).length;
  parts.push(`milestone ${ms.title} ${inMs.length - remaining}/${inMs.length} closed`);
} else parts.push("no milestone yet");

const verdict = /^\s*(\*\*)?(MERGE|BACK-TO-WORKER|CONTRACT-WRONG)\b/;
const withVerdict = prs.filter((p) => [...(p.reviews || []), ...(p.comments || [])].some((c) => verdict.test((c && c.body) || ""))).length;
parts.push(`${prs.length} PRs open (${withVerdict} verdict)`);

const heads = new Set(prs.map((p) => p.headRefName));
const inProgress = branches.filter((b) => (b.startsWith(`${names.branch}${run}-`) || b.startsWith(`${lib.CURRENT.work}${run}/`)) && !heads.has(b)).length;
const parallel = Math.max(1, prs.length + inProgress);
const took = tickets.filter((i) => !isOpen(i) && i.closedAt && i.createdAt).map((i) => Date.parse(i.closedAt) - Date.parse(i.createdAt)).filter((d) => d > 0).sort((a, b) => a - b);
if (took.length < 2) parts.push(`eta: n/a (need 2 closed tickets)`);
else {
  const med = took.length % 2 ? took[(took.length - 1) / 2] : (took[took.length / 2 - 1] + took[took.length / 2]) / 2;
  parts.push(remaining ? `eta ~${fmt((med * remaining) / parallel)} (median ${fmt(med)}/ticket)` : `eta: milestone tickets done (median ${fmt(med)}/ticket)`);
}
console.log(parts.join(" · "));

function fmt(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d${h}h` : h ? `${h}h${mm ? mm + "m" : ""}` : `${mm}m`;
}
