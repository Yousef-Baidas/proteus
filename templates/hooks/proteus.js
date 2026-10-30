#!/usr/bin/env node
// The lead's loop: node <hooks>/proteus.js next [run] [--json]
// Reads the tracker and the lead's local state and prints what is due, one line per action, in this order:
//   ASK <issue url> <title>                                  an open needs-human issue (the inbox cache)
//   STOP <agent> <reason> / NUDGE <agent> <reason>            a STALL-AGAIN / STALL agent (the watchdog's read)
//   MERGE PR#<n> <head sha12> verdict=<state> by=<login>       a PR proteus-merge.js would pick
//   SPAWN verifier PR#<n> #<ticket> head=<sha12>               an open PR with no proteus/verdict and no verifier
//                                                             spawn recorded for its head
//   SPAWN worker #<n> team=<team> difficulty=<d>[ speculative] a ready ticket (proteus-ready.js's set)
//   BLOCKED #<n> <reason>                                     a blocked ticket
//   WAIT node <hooks>/proteus-watchdog.js --wait              when nothing but BLOCKED is due
// --json prints the same as an array of { kind, ... }. Read-only: it changes no ref, issue, label, PR or file, the
// lead's state included; it executes none of the lines. Exit 0 with the list; 1 when the tracker cannot be read;
// 2 on usage or when there is no run.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
const { fromTracker, ticketOf } = require(path.join(__dirname, "proteus-ready.js"));
const { pick } = require(path.join(__dirname, "proteus-merge.js"));
const { stalls } = require(path.join(__dirname, "proteus-watchdog.js"));

const USAGE = "usage: node proteus.js next [run] [--json]";
const HELP = `${USAGE}
Prints the lead's next actions, one line each: ASK, STOP, NUDGE, MERGE, SPAWN verifier, SPAWN worker,
BLOCKED, then WAIT when nothing but BLOCKED is due. Executes none of them and writes nothing.
  run      the run; defaults to the open proteus/<run> branch
  --json   the same as a JSON array of { kind, ... }
Exit 0 with the list; 1 when the tracker cannot be read; 2 on usage or no run.`;
const VERDICT = "proteus/verdict";
// what reaches the lead's output: no control character (terminal escapes, a second line)
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// an issue's web URL on the project's repo (lib.ghRepo: owner/name on github.com, else host/owner/name)
function issueUrl(root, n) {
  const repo = lib.ghRepo(root);
  if (!repo) return `#${n}`;
  return repo.split("/").length === 3 ? `https://${repo}/issues/${n}` : `https://github.com/${repo}/issues/${n}`;
}

// the newest proteus/verdict status on sha with its poster, { verdict, by }; the rollup's state and "?" when the API fails
function verdictOf(root, sha, rollup) {
  const list = parse(lib.gh(["api", `repos/{owner}/{repo}/commits/${sha}/statuses`], root, 30000));
  const s = Array.isArray(list) ? list.find((x) => x && x.context === VERDICT) : null; // newest first
  if (s) return { verdict: String(s.state || "?"), by: String((s.creator && s.creator.login) || "?") };
  const r = rollup.find((c) => (c.context || c.name) === VERDICT) || {};
  return { verdict: String(r.state || "?").toLowerCase(), by: "?" };
}

// the PR and head sha12 of each verifier spawn the lead's guard recorded (lib.recordSpawn, from the prompt's PR#<n>
// and head=<sha12>), as "<pr> <sha12>"; a spawn without both tokens is not among them
function verifierSpawns(common) {
  const dir = lib.leadPath(common, "spawns");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  return new Set(files.map((f) => lib.readJSON(path.join(dir, f), null))
    .filter((r) => r && lib.isVerifier(String(r.type || "")) && Number.isInteger(r.pr) && typeof r.head === "string")
    .map((r) => `${r.pr} ${r.head}`));
}

// the actions, in print order; { code } when there are none to give
function next(arg) {
  const root = path.resolve(lib.projectRoot());
  const common = lib.gitCommonDir(root);
  const refs = common ? lib.runRefs(common) : [];
  const runBranches = common ? lib.runBranches(common) : [];
  const run = lib.runName(arg || runBranches[0] || "");
  if (!run) return { code: 2, err: `no run named and no open ${lib.CURRENT.branch}<run> branch` };
  const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;

  const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,title,state,milestone,labels,body", "--limit", "500"], root, 30000));
  if (!Array.isArray(issues)) return { code: 1, err: `run ${run}: tracker unreachable (gh issue list failed)` };
  const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "open", "--json", "number,headRefName,headRefOid,body,isDraft,statusCheckRollup", "--limit", "200"], root, 30000));
  if (!Array.isArray(prs)) return { code: 1, err: `run ${run}: tracker unreachable (gh pr list failed)` };
  const reviews = parse(lib.gh(["issue", "list", "--label", names.review, "--state", "open", "--json", "milestone", "--limit", "50"], root, 10000)) || [];

  const out = [];
  // the cache as the inbox keeps it; gh's answer, unwritten, only when there is no cache
  const inbox = (common && lib.readInbox(common)) || lib.queryInbox(root);
  if (inbox) for (const i of [...inbox.questions, ...inbox.reviews]) out.push({ kind: "ASK", n: i.n, url: issueUrl(root, i.n), title: i.title });

  if (common) {
    const { stalled } = stalls(common, Date.now());
    for (const s of stalled.filter((x) => x.again)) out.push({ kind: "STOP", agent: s.agent, reason: `${s.why}, cwd ${s.cwd}` });
    for (const s of stalled.filter((x) => !x.again)) out.push({ kind: "NUDGE", agent: s.agent, reason: `${s.why}, cwd ${s.cwd}` });
  }

  const byN = new Map(prs.map((p) => [p.number, p]));
  for (const m of pick(prs, issues, run, names)) {
    const p = byN.get(m.n);
    const head = String(p.headRefOid || "");
    out.push({ kind: "MERGE", pr: m.n, head, ...verdictOf(root, head, p.statusCheckRollup || []) });
  }
  const spawned = common ? verifierSpawns(common) : new Set();
  for (const p of prs) {
    const head = String(p.headRefOid || "");
    if ((p.statusCheckRollup || []).some((c) => (c.context || c.name) === VERDICT) || spawned.has(`${p.number} ${head.slice(0, 12)}`)) continue;
    out.push({ kind: "SPAWN", role: "verifier", pr: p.number, ticket: ticketOf(run, names, String(p.headRefName || ""), p.body || ""), head });
  }

  const { ready, blocked } = fromTracker(root, run, names, { issues, prs, reviews, refs });
  for (const t of ready) out.push({ kind: "SPAWN", role: "worker", ticket: t.n, team: t.team, difficulty: t.difficulty, speculative: t.speculative });
  for (const b of blocked) out.push({ kind: "BLOCKED", ticket: b.n, reason: b.reason });
  if (out.every((a) => a.kind === "BLOCKED")) out.push({ kind: "WAIT", command: `node ${path.join(__dirname, "proteus-watchdog.js")} --wait` });
  return { code: 0, out };
}

const line = (a) => {
  switch (a.kind) {
    case "ASK": return `ASK ${a.url} ${a.title}`;
    case "STOP": case "NUDGE": return `${a.kind} ${a.agent} ${a.reason}`;
    case "MERGE": return `MERGE PR#${a.pr} ${a.head.slice(0, 12)} verdict=${a.verdict} by=${a.by}`;
    case "SPAWN": return a.role === "verifier"
      ? `SPAWN verifier PR#${a.pr} #${a.ticket || "?"} head=${a.head.slice(0, 12)}`
      : `SPAWN worker #${a.ticket} team=${a.team} difficulty=${a.difficulty}${a.speculative ? " speculative" : ""}`;
    case "BLOCKED": return `BLOCKED #${a.ticket} ${a.reason}`;
    default: return `WAIT ${a.command}`;
  }
};

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return argv.length ? 0 : 2; }
  if (argv[0] !== "next") { console.error(`${USAGE}\nunknown command ${plain(argv[0])}`); return 2; }
  let arg = "", json = false;
  for (const a of argv.slice(1)) {
    if (a === "--json") json = true;
    else if (!arg && !a.startsWith("-")) arg = a;
    else { console.error(`${USAGE}\nunknown argument ${plain(a)}`); return 2; }
  }
  const r = next(arg);
  if (r.err) { console.error(plain(r.err)); return r.code; }
  if (json) console.log(JSON.stringify(r.out, null, 2));
  else for (const a of r.out) console.log(plain(line(a)));
  return 0;
}

module.exports = { next };
if (require.main === module) process.exitCode = main();
