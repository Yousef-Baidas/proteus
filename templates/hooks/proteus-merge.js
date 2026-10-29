#!/usr/bin/env node
// The merge batch of flow.md step 7: node <hooks>/proteus-merge.js [run] --suite "<suite command>"
// Picks the open PRs into proteus/<run> whose checks and statuses are all green, proteus/verdict among them (the
// verifier posts it green only for MERGE), and merges them in dependency order (the "Depends on:" line of each
// ticket's issue; a PR whose depends-on ticket is open and not in the batch waits). Before each merge it removes
// the worktree holding the PR's branch, then `gh pr merge --merge --delete-branch`; a conflict or any other
// failed merge stops the batch. Then the suite once in .worktrees/_run through proteus-gates-cache.js, and on red
// a bisect over the batch's merges (first parent) for the first bad one. What merged before a stop is still tested.
// Prints one line: the merged PRs with their tickets, the stop if any, the suite result, the first bad merge.
// The suite's output goes to <git-common-dir>/proteus/merge/<run>.log. Opening tickets, routing a conflict and
// stopping agents stay the lead's. Exit 0 when green or nothing to merge; 1 on a stop, a red suite, or a git or
// tracker failure; 2 on usage or no run.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const CACHE = path.join(__dirname, "proteus-gates-cache.js");
const USAGE = "usage: node proteus-merge.js [run] --suite \"<suite command>\"";
const HELP = `${USAGE}
Merges the ready PRs into proteus/<run>, runs the suite once, and bisects a red one:
  run       the run; defaults to the open proteus/<run> branch
  --suite   the full suite command (the gate commands in AGENTS.md ## Learned), run through
            proteus-gates-cache.js in .worktrees/_run, made on first use
A PR is ready when every check and status on its head is green and proteus/verdict is among them;
it merges after the PRs of the tickets its own depends on. Each PR's worktree is removed before its
merge; a conflict stops the batch. Prints one line: merged PRs (with tickets), the stop if any, the
suite result, and the first bad merge on red. Suite output: <git-common-dir>/proteus/merge/<run>.log.
Exit 0 green or nothing to merge; 1 on a stop, a red suite or a failure; 2 on usage.`;

const last = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";
// a statusCheckRollup entry: a commit status (StatusContext) or a check run
const green = (c) => (c.__typename === "StatusContext"
  ? c.state === "SUCCESS"
  : c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion));

// prs: [{ n, ticket, deps: [ticket] }], open: tickets still open. The merge order: a PR after those whose ticket it
// depends on, else by ticket then PR number; one whose depends-on ticket is open outside the batch (or in a cycle)
// is left out
function mergeOrder(prs, open) {
  const left = [...prs].sort((a, b) => (a.ticket || Infinity) - (b.ticket || Infinity) || a.n - b.n);
  const out = [], done = new Set();
  for (let moved = true; moved;) {
    moved = false;
    for (const p of left) {
      if (out.includes(p)) continue;
      const waits = p.deps.filter((d) => !done.has(d) && (open.has(d) || left.some((q) => q.ticket === d && !out.includes(q))));
      if (waits.length) continue;
      out.push(p);
      if (p.ticket) done.add(p.ticket);
      moved = true;
      break;
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  let arg = "", suite = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suite") suite = argv[++i] || "";
    else if (argv[i].startsWith("--suite=")) suite = argv[i].slice(8);
    else if (!arg && !argv[i].startsWith("-")) arg = argv[i];
    else { console.error(`${USAGE}\nunknown argument ${argv[i]} (--help explains them)`); return 2; }
  }
  if (!suite.trim()) { console.error(`${USAGE}\n--suite is required (--help explains it)`); return 2; }

  const here = path.resolve(lib.projectRoot());
  const common = lib.gitCommonDir(here);
  const root = (common && lib.mainRoot(common)) || here;
  const runBranches = common ? lib.runBranches(common) : [];
  const run = lib.runName(arg || runBranches[0] || "");
  if (!run) { console.error(`no run named and no open ${lib.CURRENT.branch}<run> branch`); return 2; }
  const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
  const base = `${names.branch}${run}`;
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const fail = (why) => { console.log(`run ${run}: ${why}`); return 1; };

  const prs = parse(lib.gh(["pr", "list", "--base", base, "--state", "open", "--json", "number,headRefName,body,isDraft,statusCheckRollup", "--limit", "200"], root, 30000));
  if (!Array.isArray(prs)) return fail("tracker unreachable (gh pr list failed)");
  const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,state,body", "--limit", "500"], root, 30000));
  if (!Array.isArray(issues)) return fail("tracker unreachable (gh issue list failed)");

  // a PR's ticket: the number its head ends in, else the body's Closes #n (as proteus-ready.js)
  const heads = [`${lib.CURRENT.work}${run}/`, `${names.branch}${run}-`];
  const ticketOf = (head, body = "") => {
    const pre = heads.find((p) => head.startsWith(p));
    const m = (pre && /^(\d+)$/.exec(head.slice(pre.length))) || /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)\b/i.exec(body);
    return m ? +m[1] : 0;
  };
  const deps = (body) => {
    const m = /^[\s*_>-]*depends[- ]on\b[*_:\s]*(.*)$/im.exec(body || "");
    return m ? [...m[1].matchAll(/#(\d+)/g)].map((d) => +d[1]) : [];
  };
  const byN = new Map(issues.map((i) => [i.number, i]));
  const open = new Set(issues.filter((i) => String(i.state).toUpperCase() === "OPEN").map((i) => i.number));
  const ready = prs.filter((p) => {
    const checks = p.statusCheckRollup || [];
    return !p.isDraft && checks.length && checks.every(green) && checks.some((c) => (c.context || c.name) === "proteus/verdict");
  }).map((p) => {
    const ticket = ticketOf(String(p.headRefName || ""), p.body || "");
    return { n: p.number, head: String(p.headRefName || ""), ticket, deps: ticket && byN.has(ticket) ? deps(byN.get(ticket).body) : [] };
  });
  const batch = mergeOrder(ready, open);
  if (!batch.length) { console.log("merged none; suite not run"); return 0; }

  const tip = () => (lib.gitTry(["fetch", "origin", base], root, 120000).ok && lib.gitTry(["rev-parse", "--verify", "-q", `origin/${base}^{commit}`], root).out) || "";
  const pre = tip();
  if (!pre) return fail(`cannot fetch origin/${base}`);
  const worktrees = {};
  let wt = "";
  for (const l of lib.gitTry(["worktree", "list", "--porcelain"], root, 30000).out.split(/\r?\n/)) {
    if (l.startsWith("worktree ")) wt = l.slice(9);
    else if (l.startsWith("branch refs/heads/") && !lib.samePath(lib.realOr(wt), lib.realOr(root))) worktrees[l.slice(18)] = wt;
  }

  const merged = [];
  let stop = "";
  for (const p of batch) {
    const tree = worktrees[p.head];
    if (tree) {
      const r = lib.gitTry(["worktree", "remove", tree], root, 60000);
      if (!r.ok) { stop = `PR #${p.n} not merged: worktree ${tree} not removed (${last(r.err)})`; break; }
    }
    const m = lib.ghTry(["pr", "merge", String(p.n), "--merge", "--delete-branch"], root, 120000);
    if (!m.ok) {
      const state = lib.gh(["pr", "view", String(p.n), "--json", "mergeable", "-q", ".mergeable"], root, 30000);
      stop = state === "CONFLICTING" ? `conflict PR #${p.n}${p.ticket ? ` for #${p.ticket}` : ""}` : `PR #${p.n} not merged (${last(m.err || m.out)})`;
      break;
    }
    merged.push({ ...p, sha: tip() });
  }
  const name = (p) => `PR #${p.n}${p.ticket ? ` for #${p.ticket}` : ""}`;
  const head = merged.length ? tip() : "";
  let line = `merged ${merged.length ? merged.map(name).join(", ") : "none"}${stop ? `; ${stop}` : ""}`;
  if (!head) { console.log(`${line}; suite not run`); return 1; }

  // the lead's checkout, when it sits on the run branch, follows it (stack.md)
  if (lib.gitTry(["rev-parse", "--abbrev-ref", "HEAD"], root).out === base) lib.gitTry(["merge", "--ff-only", `origin/${base}`], root, 60000);

  const dir = path.join(lib.worktreesDir(root), "_run");
  const log = path.join(lib.stateDir(common), "merge", `${run}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "");
  const at = (sha) => (fs.existsSync(dir)
    ? lib.gitTry(["checkout", "--detach", "-q", sha], dir, 120000)
    : lib.gitTry(["worktree", "add", "--detach", dir, sha], root, 120000));
  const passes = (sha) => {
    const c = at(sha);
    if (!c.ok) throw new Error(`.worktrees/_run cannot check out ${sha.slice(0, 12)} (${last(c.err)})`);
    fs.appendFileSync(log, `== ${sha} ==\n`);
    const fd = fs.openSync(log, "a");
    try { return spawnSync(process.execPath, [CACHE, suite], { cwd: dir, stdio: ["ignore", fd, fd], windowsHide: true }).status === 0; }
    finally { fs.closeSync(fd); }
  };
  try {
    if (passes(head)) { console.log(`${line}; suite green`); return stop ? 1 : 0; }
    // bisect the batch's merges: pre passed (the last batch ended green), head failed
    const shas = lib.gitTry(["rev-list", "--first-parent", "--reverse", `${pre}..${head}`], root, 30000).out.split(/\s+/).filter(Boolean);
    let lo = -1, hi = shas.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (passes(shas[mid])) lo = mid; else hi = mid;
    }
    const bad = shas[hi] || head;
    const p = merged.find((x) => x.sha === bad);
    line += `; suite red; first bad ${p ? name(p) : "merge"} (${bad.slice(0, 12)}); log ${log}`;
    at(head);
  } catch (e) {
    line += `; suite not run: ${e.message}`;
  }
  console.log(line);
  return 1;
}

module.exports = { mergeOrder, green };
if (require.main === module) process.exitCode = main();
