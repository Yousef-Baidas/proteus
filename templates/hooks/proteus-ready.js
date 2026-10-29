#!/usr/bin/env node
// The ready set for flow.md step 4: node <hooks>/proteus-ready.js [run]
// Prints each ready ticket as "#<n> <team> <difficulty>" (plus "speculative" while a milestone is under review),
// then each blocked one as "blocked #<n>: <reason>". Tickets in flight are neither and are not listed.
// A ticket is ready when every depends-on ticket has merged (its issue closed) and none of its owned paths
// overlaps one of a ticket in flight (an open PR into proteus/<run>, or its worker branch). While a review issue
// is open, a ticket of another milestone is speculative (review.md) and also must miss the paths of the milestone
// under review: its tickets' owned paths bound what that milestone changed.
// Owned paths: .proteus/owned/<n> on the run branch, else the body's "Owned:" line. depends-on: the #numbers
// on the body's "Depends on:" (or "depends-on:") line. Exit 1 when the tracker cannot be read; 2 when no run.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

// globs a and b can name a common file (ownedMatch both ways, each glob read as a path)
const overlaps = (a, b) => lib.ownedMatch(a, b) || lib.ownedMatch(b, a);

// tickets: [{ n, team, difficulty, open, milestone, deps: [n], owned: [glob], inFlight }]; reviewing: milestone
// titles under review. Returns { ready: [{ n, team, difficulty, speculative }], blocked: [{ n, reason }] }.
function readySet(tickets, reviewing = []) {
  const byN = new Map(tickets.map((t) => [t.n, t]));
  const flying = tickets.filter((t) => t.open && t.inFlight);
  const held = tickets.filter((t) => reviewing.includes(t.milestone));
  const clash = (t, others, why) => {
    for (const o of others) for (const p of t.owned) {
      const q = o.owned.find((g) => overlaps(p, g));
      if (q) return `${p} overlaps ${q} of #${o.n} ${why(o)}`;
    }
    return "";
  };
  const ready = [], blocked = [];
  for (const t of tickets) {
    if (!t.open || t.inFlight) continue;
    const speculative = reviewing.length > 0 && !reviewing.includes(t.milestone);
    const waits = t.deps.filter((d) => !byN.has(d) || byN.get(d).open);
    const reason = (waits.length && `waits on ${waits.map((d) => `#${d}`).join(", ")}`) ||
      (!t.owned.length && "no owned paths recorded") ||
      clash(t, flying, () => "in flight") ||
      (speculative && clash(t, held, (o) => `in ${o.milestone} under review`));
    if (reason) blocked.push({ n: t.n, reason });
    else ready.push({ n: t.n, team: t.team, difficulty: t.difficulty, speculative });
  }
  return { ready, blocked };
}

function main() {
  const arg = process.argv[2] || "";
  if (arg === "--help" || arg === "-h") {
    console.log("usage: node proteus-ready.js [run]\nThe tickets ready to dispatch (\"#<n> <team> <difficulty>\", \"speculative\" during a review),\nthen the blocked ones with the reason. The run defaults to the open proteus/<run> branch.");
    return 0;
  }
  const root = path.resolve(lib.projectRoot());
  const common = lib.gitCommonDir(root);
  const refs = common ? lib.runRefs(common) : [];
  const runBranches = common ? lib.runBranches(common) : [];
  const run = lib.runName(arg || runBranches[0] || "");
  if (!run) { console.error(`no run named and no open ${lib.CURRENT.branch}<run> branch`); return 2; }
  const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
  const NOT_TICKET = new Set([names.review, names.log, names.debt, names.question]);
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,title,state,milestone,labels,body", "--limit", "500"], root, 30000));
  if (!Array.isArray(issues)) { console.error(`run ${run}: tracker unreachable (gh issue list failed)`); return 1; }
  const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "open", "--json", "headRefName,body", "--limit", "200"], root, 30000)) || [];
  const reviews = parse(lib.gh(["issue", "list", "--label", names.review, "--state", "open", "--json", "milestone", "--limit", "50"], root, 10000)) || [];

  // a PR's or branch's ticket: the number its head ends in, else the PR body's Closes #n (as the close report)
  const heads = [`${lib.CURRENT.work}${run}/`, `${names.branch}${run}-`];
  const ticketOf = (head, body = "") => {
    const pre = heads.find((p) => head.startsWith(p));
    const m = (pre && /^(\d+)$/.exec(head.slice(pre.length))) || /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)\b/i.exec(body);
    return m ? +m[1] : 0;
  };
  const flying = new Set([...prs.map((p) => ticketOf(String(p.headRefName || ""), p.body || "")), ...refs.map((b) => ticketOf(b))]);
  const runRef = [`origin/${names.branch}${run}`, `${names.branch}${run}`].find((r) => lib.git(["rev-parse", "--verify", "-q", r], root)) || "";
  const label = (i, prefix) => ((i.labels || []).map((l) => l.name).find((n) => n.startsWith(prefix)) || "").slice(prefix.length);
  const lines = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const owned = (i) => {
    const rec = runRef ? lines(lib.git(["show", `${runRef}:${lib.OWNED_RECORDS}/${i.number}`], root)) : [];
    const m = /^Owned:[ \t]*(.+)$/im.exec(i.body || "");
    return rec.length ? rec : m ? m[1].split(/[,\s]+/).filter(Boolean) : [];
  };
  const deps = (body) => {
    const m = /^[\s*_>-]*depends[- ]on\b[*_:\s]*(.*)$/im.exec(body || "");
    return m ? [...m[1].matchAll(/#(\d+)/g)].map((d) => +d[1]) : [];
  };

  const tickets = issues.filter((i) => i.milestone && String(i.milestone.title).startsWith(run + "/") && !String(i.title || "").startsWith("Revision ") &&
    !(i.labels || []).some((l) => NOT_TICKET.has(l.name))).sort((a, b) => a.number - b.number).map((i) => ({
    n: i.number, team: label(i, "profile:") || "?", difficulty: label(i, "difficulty:") || "?", open: String(i.state).toUpperCase() === "OPEN",
    milestone: i.milestone.title, deps: deps(i.body), owned: owned(i), inFlight: flying.has(i.number),
  }));
  const reviewing = reviews.map((r) => r.milestone && r.milestone.title).filter((t) => t && t.startsWith(run + "/"));
  const { ready, blocked } = readySet(tickets, reviewing);
  for (const t of ready) console.log(`#${t.n} ${t.team} ${t.difficulty}${t.speculative ? " speculative" : ""}`);
  for (const b of blocked) console.log(`blocked #${b.n}: ${b.reason}`);
  return 0;
}

module.exports = { readySet, overlaps };
if (require.main === module) process.exitCode = main();
