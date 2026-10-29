#!/usr/bin/env node
// The merge batch of flow.md step 7: node <hooks>/proteus-merge.js [run] --suite "<suite command>" [--result pass|fail]
// Picks the open PRs into proteus/<run> whose checks and statuses are all green, proteus/verdict among them (the
// verifier posts it green only for MERGE), and merges them in dependency order (the "Depends on:" line of each
// ticket's issue; a PR whose depends-on ticket is open and not in the batch waits) with `gh pr merge --merge`; a
// conflict or any other failed merge stops the batch. Then it moves .worktrees/_run to the merged tip and prints the
// suite command for the lead to run there, sandboxed, through proteus-gates-cache.js: this script never runs
// anything from _run or a PR (#226). `--result pass|fail` reports that run: pass ends the batch; fail on the tip
// starts a bisect over the batch's merges (first parent), each step moving _run and printing the command again,
// until it names the first bad merge and moves _run back to the tip. The batch's state between calls is
// <git-common-dir>/proteus/merge/<run>.json. It removes no worktree and deletes no branch: the end names the merged
// branches whose worktree and branch are left for the lead. Opening tickets, routing a conflict and stopping agents
// stay the lead's. Exit 0 when a step is printed, green, or nothing to merge; 1 on a stop, a red end, a refusal, or
// a git or tracker failure; 2 on usage or no run.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

// printed for the lead to run in _run, never run here
const CACHE = path.join(__dirname, "proteus-gates-cache.js");

const USAGE = "usage: node proteus-merge.js [run] --suite \"<suite command>\" [--result pass|fail]";
const HELP = `${USAGE}
Merges the ready PRs into proteus/<run> and prints the suite command for .worktrees/_run:
  run       the run; defaults to the open proteus/<run> branch
  --suite   the full suite command (the gate commands in AGENTS.md ## Learned); printed, never run here
  --result  pass or fail: what the printed command did in .worktrees/_run. Fail on the tip bisects the
            batch's merges, one printed step at a time, to the first bad one
A PR is ready when every check and status on its head is green and proteus/verdict is among them;
it merges after the PRs of the tickets its own depends on; a conflict stops the batch. No worktree
or branch is removed: the end names the merged branches left for the lead.
State between calls: <git-common-dir>/proteus/merge/<run>.json.
Exit 0 a step printed, green or nothing to merge; 1 on a stop, a red end or a failure; 2 on usage.`;

const last = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";
// a statusCheckRollup entry: a commit status (StatusContext) or a check run
const green = (c) => (c.__typename === "StatusContext"
  ? c.state === "SUCCESS"
  : c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion));

// <root>/.worktrees/_run by its lexical path, never a real path a link leads to (#226): every component below root a
// real directory (lstat: no link, no junction) and exactly one admin dir under <common>/worktrees whose gitdir names
// <dir>/.git. { dir, gitDir } with gitDir "" when _run does not exist yet; throws on anything else
function runCheckout(common, root) {
  const dir = path.join(lib.worktreesDir(root), "_run");
  let d = root;
  for (const part of path.relative(root, dir).split(path.sep)) {
    d = path.join(d, part);
    let st;
    try { st = fs.lstatSync(d); } catch (e) { if (e.code === "ENOENT") return { dir, gitDir: "" }; throw e; }
    if (!st.isDirectory()) throw new Error(`${d} is not a real directory (a link or a file)`);
  }
  const key = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  const want = key(path.join(dir, ".git"));
  let ids = [];
  try { ids = fs.readdirSync(path.join(common, "worktrees")); } catch {}
  const own = ids.filter((id) => {
    try { return key(path.resolve(fs.readFileSync(path.join(common, "worktrees", id, "gitdir"), "utf8").trim())) === want; } catch { return false; }
  });
  if (own.length !== 1) throw new Error(`${dir} is not a worktree of this project`);
  return { dir, gitDir: path.join(common, "worktrees", own[0]) };
}

// the batch's state <common>/proteus/merge/<run>.json, never through a link (#226): merge/ a real directory, an old
// file unlinked and the new one opened exclusive (wx); read only as a regular file (O_NOFOLLOW)
const stateFile = (common, run) => path.join(lib.stateDir(common), "merge", `${run}.json`);
function writeState(common, run, state) {
  const dir = path.dirname(stateFile(common, run));
  fs.mkdirSync(lib.stateDir(common), { recursive: true });
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a real directory (a link or a file)`);
  const file = stateFile(common, run);
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const fd = fs.openSync(file, "wx");
  try { fs.writeSync(fd, JSON.stringify(state)); } finally { fs.closeSync(fd); }
}
// null when there is none; throws on a link at merge/ or at the file, or anything unreadable
function readState(common, run) {
  const file = stateFile(common, run);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!fs.lstatSync(path.dirname(file)).isDirectory() || !st.isFile()) throw new Error(`${file} is not a regular file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}
const dropState = (common, run) => { try { fs.unlinkSync(stateFile(common, run)); } catch {} };

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
  let arg = "", suite = "", result = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suite") suite = argv[++i] || "";
    else if (argv[i].startsWith("--suite=")) suite = argv[i].slice(8);
    else if (argv[i] === "--result") result = argv[++i] || "-";
    else if (argv[i].startsWith("--result=")) result = argv[i].slice(9) || "-";
    else if (!arg && !argv[i].startsWith("-")) arg = argv[i];
    else { console.error(`${USAGE}\nunknown argument ${argv[i]} (--help explains them)`); return 2; }
  }
  if (!suite.trim()) { console.error(`${USAGE}\n--suite is required (--help explains it)`); return 2; }
  if (result && !["pass", "fail"].includes(result)) { console.error(`${USAGE}\n--result is pass or fail`); return 2; }

  // git runs on the project's common dir, pinned (#215); a working tree only through its checkout's root and index
  const common = lib.repoCommon();
  const root = common && lib.mainRoot(common);
  if (!root) { console.error("not in a project checkout"); return 2; }
  const lead = lib.checkoutOf(root);
  const runBranches = common ? lib.runBranches(common) : [];
  const run = lib.runName(arg || runBranches[0] || "");
  if (!run) { console.error(`no run named and no open ${lib.CURRENT.branch}<run> branch`); return 2; }
  const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
  const base = `${names.branch}${run}`;
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const fail = (why) => { console.log(`run ${run}: ${why}`); return 1; };
  const name = (p) => `PR #${p.n}${p.ticket ? ` for #${p.ticket}` : ""}`;
  const fw = (p) => p.split(path.sep).join("/");

  // _run at sha: made by worktree add, then moved by read-tree on its own index and its HEAD set by update-ref, as
  // git on the common dir cannot check out in a linked worktree (its HEAD would be the main checkout's). Throws on
  // a _run that fails runCheckout
  const at = (sha) => {
    const co = runCheckout(common, root);
    const r = !co.gitDir ? lib.gitTry(common, ["worktree", "add", "--detach", co.dir, sha], { cwd: root, timeout: 120000 })
      : lib.gitTry(common, ["read-tree", "-u", "--reset", sha], { cwd: co.dir, workTree: co.dir, index: path.join(co.gitDir, "index"), timeout: 120000 });
    const h = r.ok && co.gitDir ? lib.gitTry(common, ["update-ref", "--no-deref", `worktrees/${path.basename(co.gitDir)}/HEAD`, sha]) : r;
    if (!h.ok) throw new Error(`.worktrees/_run cannot check out ${sha.slice(0, 12)} (${last(h.err)})`);
  };
  // the command the lead runs in _run, sandboxed, then this script's next call
  const runDir = path.join(lib.worktreesDir(root), "_run");
  const next = `suite: in .worktrees/_run run node ${fw(path.relative(runDir, CACHE))} ${JSON.stringify(suite)}, then node ${fw(path.relative(root, __filename))} ${run} --suite ${JSON.stringify(suite)} --result pass|fail`;
  const leftFor = (left) => (left.length ? `; worktree and branch left for the lead: ${left.join(", ")}` : "");
  const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

  // --result: the lead's run of the printed command on the commit _run holds; the tip's, then each bisect step's
  if (result) {
    try {
      const st = readState(common, run);
      if (!st) { console.error(`run ${run}: no batch awaits a result (run it without --result first)`); return 2; }
      if (!SHA.test(st.pre) || !SHA.test(st.head) || !Array.isArray(st.merged) || !Array.isArray(st.left)) return fail(`refused: ${stateFile(common, run)} is not a batch's state`);
      if (st.mid === null) {
        if (result === "pass") { dropState(common, run); console.log(`run ${run}: suite green at ${st.head.slice(0, 12)}${leftFor(st.left)}`); return 0; }
        // bisect the batch's merges: pre passed (the last batch ended green), head failed
        st.shas = lib.gitTry(common, ["rev-list", "--first-parent", "--reverse", `${st.pre}..${st.head}`], { timeout: 30000 }).out.split(/\s+/).filter(Boolean);
        st.lo = -1;
        st.hi = st.shas.length - 1;
      } else if (result === "pass") st.lo = st.mid;
      else st.hi = st.mid;
      if (!Array.isArray(st.shas) || !st.shas.every((x) => SHA.test(x))) return fail(`refused: ${stateFile(common, run)} is not a batch's state`);
      if (st.hi - st.lo > 1) {
        st.mid = (st.lo + st.hi) >> 1;
        at(st.shas[st.mid]);
        writeState(common, run, st);
        console.log(`run ${run}: bisecting, ${st.hi - st.lo - 1} merge(s) left to test; ${next}`);
        return 0;
      }
      const bad = st.shas[st.hi] || st.head;
      const p = st.merged.find((x) => x.sha === bad);
      at(st.head);
      dropState(common, run);
      console.log(`run ${run}: suite red; first bad ${p ? name(p) : "merge"} (${bad.slice(0, 12)})${leftFor(st.left)}`);
      return 1;
    } catch (e) {
      return fail(`refused: ${e.message}`);
    }
  }
  try { if (readState(common, run)) return fail(`a batch awaits --result pass|fail (${stateFile(common, run)})`); } catch (e) { return fail(`refused: ${e.message}`); }

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

  // fetch with the human's config (credentials, proxy), as lib's release fetch
  const tip = () => (lib.gitTry(common, ["fetch", "origin", base], { user: true, timeout: 120000 }).ok && lib.gitTry(common, ["rev-parse", "--verify", "-q", `origin/${base}^{commit}`]).out) || "";
  const pre = tip();
  if (!pre) return fail(`cannot fetch origin/${base}`);
  // _run checked before anything merges: a link or a stranger's admin dir there refuses the batch
  try { runCheckout(common, root); } catch (e) { return fail(`refused: ${e.message}`); }
  // each linked worktree's branch, its HEAD read as a file
  const worktrees = {};
  for (const wt of lib.registeredWorktrees(common)) { const b = lib.branchOf(wt); if (b) worktrees[b] = wt; }

  // no worktree is removed here (#226): the merged branches that still have one are named for the lead to remove
  const merged = [];
  let stop = "";
  for (const p of batch) {
    const m = lib.ghTry(["pr", "merge", String(p.n), "--merge"], root, 120000);
    if (!m.ok) {
      const state = lib.gh(["pr", "view", String(p.n), "--json", "mergeable", "-q", ".mergeable"], root, 30000);
      stop = state === "CONFLICTING" ? `conflict PR #${p.n}${p.ticket ? ` for #${p.ticket}` : ""}` : `PR #${p.n} not merged (${last(m.err || m.out)})`;
      break;
    }
    merged.push({ ...p, sha: tip() });
  }
  const head = merged.length ? tip() : "";
  const left = merged.flatMap((p) => (worktrees[p.head] ? [p.head] : []));
  const line = `merged ${merged.length ? merged.map(name).join(", ") : "none"}${stop ? `; ${stop}` : ""}`;
  if (!head) { console.log(`${line}; suite not run`); return 1; }

  // the lead's checkout, when it sits on the run branch, follows it (stack.md)
  if (lib.branchOf(root) === base) lib.gitTry(common, ["merge", "--ff-only", `origin/${base}`], { cwd: root, workTree: root, index: lead.index, timeout: 60000 });

  try {
    at(head);
    writeState(common, run, { pre, head, merged: merged.map((p) => ({ n: p.n, ticket: p.ticket, head: p.head, sha: p.sha })), left, mid: null });
  } catch (e) {
    console.log(`${line}; suite not run: ${e.message}${leftFor(left)}`);
    return 1;
  }
  console.log(`${line}; ${next}`);
  return stop ? 1 : 0;
}

module.exports = { mergeOrder, green, writeState };
if (require.main === module) process.exitCode = main();
