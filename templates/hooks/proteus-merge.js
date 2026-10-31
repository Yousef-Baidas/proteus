#!/usr/bin/env node
// The merge batch of flow.md step 7:
// node <hooks>/proteus-merge.js [run] --suite "<suite command>" [--result pass|fail --at <sha>]
// Picks the open PRs into proteus/<run> whose checks and statuses are all green, proteus/verdict among them (the
// verifier posts it green only for MERGE), and merges them in dependency order (the "Depends on:" line of each
// ticket's issue; a PR whose depends-on ticket is open and not in the batch waits) with `gh pr merge --merge
// --match-head-commit <the head it checked>`, so a head pushed since waits a round, held as "head moved"; a
// conflict or any other failed merge stops the batch. The project policy (proteus-policy.js, #307) holds some back,
// each named on a line: every one under merge human; under ask every each, and under ask risky each whose changed
// paths an ask rule covers, until the human's newest verdict on the PR (Policy.held) is ACCEPT <sha12> for its head.
// It runs outside the sandbox, so it does only that, an
// ls-remote, a fetch that writes objects only, and its state file: no git call with a work tree, no ref read by a
// short name, nothing run from .worktrees/_run or a PR (#226). The fetch writes no ref, reflog or FETCH_HEAD, fetches
// no submodule, and runs no auto maintenance, whose worktree prune would follow a link an agent plants under
// <common>/worktrees. It prints the commit to test and two commands for the lead to run sandboxed:
// proteus-run-tree.js <sha>, which checks that commit out in .worktrees/_run, then the suite in _run, bare.
// `--result pass|fail --at <sha>` reports that run on sha, refused unless sha is the commit the state names: pass ends
// the batch, printing origin's tip for the lead's fast-forward only when it is that commit; fail on the tip starts a
// bisect over the batch's merges,
// each step printing the next commit and both commands again, until it names the first bad merge. The batch's state
// between calls is <git-common-dir>/proteus/merge/<run>.json, which a sandboxed agent can write: every read checks
// it, and the branch names the end prints come from the tracker, never from it. It removes no worktree and deletes
// no branch: the end names the merged branches whose worktree and branch are left for the lead. Opening tickets,
// routing a conflict and stopping agents stay the lead's. Exit 0 when a step is printed, green, or nothing to merge;
// 1 on a stop, a red end, a refusal, or a git or tracker failure; 2 on usage or no run.
// Run from any dir but the session's hooks dir (proteus-lead/hooks-root, #277): exit 1, naming that dir.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const Policy = require(path.join(__dirname, "proteus-policy.js"));
lib.hooksRootOnly(__filename); // #277: never a copy but the session's hooks dir
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir

// printed for the lead to run sandboxed, never run here
const RUN_TREE = path.join(__dirname, "proteus-run-tree.js");

const USAGE = "usage: node proteus-merge.js [run] --suite \"<suite command>\" [--result pass|fail --at <sha>]";
const HELP = `${USAGE}
Merges the ready PRs into proteus/<run> and prints the commands that test the result in .worktrees/_run:
  run       the run; defaults to the open proteus/<run> branch
  --suite   the full suite command (the gate commands in AGENTS.md ## Learned); printed, never run here
  --result  pass or fail: what the printed suite did in .worktrees/_run. Fail on the tip bisects the
            batch's merges, one printed step at a time, to the first bad one
  --at      the full sha the suite ran on, as printed; a result for any other commit is refused
A PR is ready when every check and status on its head is green and proteus/verdict is among them;
it merges after the PRs of the tickets its own depends on, pinned to the head checked (a head pushed
since waits a round: "held: its head moved"); a conflict stops the batch.
The project policy holds a PR for the human: merge human always; ask every, or ask risky when
an ask rule covers a changed path, until the human's comment on the PR is ACCEPT <head sha12>. No worktree
or branch is removed: the end names the merged branches left for the lead.
State between calls: <git-common-dir>/proteus/merge/<run>.json.
Exit 0 a step printed, green or nothing to merge; 1 on a stop, a red end or a failure; 2 on usage.`;

// a run name, and the worker branches of run: proteus-work/<run>/<ticket>
const RUN = /^[A-Za-z0-9][\w.-]*$/;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORK = (run) => new RegExp(`^${literal(`${lib.CURRENT.work}${run}/`)}\\d+$`);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// what reaches the lead's output: no control character (terminal escapes, a second line)
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");
const last = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";
// a statusCheckRollup entry: a commit status (StatusContext) or a check run
const green = (c) => (c.__typename === "StatusContext"
  ? c.state === "SUCCESS"
  : c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion));

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
// a batch's state as this script writes it, else false: { head, at, merged: [{ n, ticket?, head?, sha }], left, mid,
// lo?, hi? }. head and at (the commit the lead tests) and every sha full ids; n and ticket positive integers; a head
// only on a merged PR whose worktree is left, and left only those heads, each a worker branch of run; mid null while
// the tip is tested, else lo < mid < hi, all within merged, with at that merge's sha
function checkState(st, run) {
  const work = WORK(run);
  const int = (x, min) => Number.isInteger(x) && x >= min;
  const sha = (x) => typeof x === "string" && SHA.test(x);
  if (!st || typeof st !== "object" || !sha(st.head) || !sha(st.at) || !Array.isArray(st.merged) || !st.merged.length || !Array.isArray(st.left)) return false;
  if (!st.merged.every((p) => p && typeof p === "object" && int(p.n, 1) && (p.ticket === undefined || int(p.ticket, 1)) && sha(p.sha)
    && (p.head === undefined || (typeof p.head === "string" && work.test(p.head))))) return false;
  if (!st.left.every((b) => typeof b === "string" && work.test(b) && st.merged.some((p) => p.head === b))) return false;
  const top = st.merged.length - 1;
  if (st.mid === null) return st.lo === undefined && st.hi === undefined && st.at === st.head;
  return int(st.lo, -1) && int(st.mid, 0) && int(st.hi, 0) && st.lo < st.mid && st.mid < st.hi && st.hi <= top && st.at === st.merged[st.mid].sha;
}
// null when there is none; throws on a link at merge/ or at the file, anything unreadable, or a state checkState refuses
function readState(common, run) {
  const file = stateFile(common, run);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!fs.lstatSync(path.dirname(file)).isDirectory() || !st.isFile()) throw new Error(`${file} is not a regular file`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let state;
  try { state = JSON.parse(fs.readFileSync(fd, "utf8")); } catch { state = null; } finally { fs.closeSync(fd); }
  if (!checkState(state, run)) throw new Error(`${file} is not a batch's state`);
  return state;
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

// the merge batch from the tracker's answers: the open PRs into the run branch (number,headRefName,headRefOid,body,
// isDraft,statusCheckRollup) whose checks are all green with proteus/verdict among them, in mergeOrder over issues
// (number,state,body). Each [{ n, head, oid, ticket, deps }]: oid is the head commit's full sha, "" when gh gave none
function pick(prs, issues, run, names) {
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
    return Number.isInteger(p.number) && p.number > 0 && !p.isDraft && checks.length && checks.every(green) && checks.some((c) => (c.context || c.name) === "proteus/verdict");
  }).map((p) => {
    const ticket = ticketOf(String(p.headRefName || ""), p.body || "");
    const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(p.headRefOid)) ? String(p.headRefOid) : "";
    return { n: p.number, head: String(p.headRefName || ""), oid, ticket, deps: ticket && byN.has(ticket) ? deps(byN.get(ticket).body) : [] };
  });
  return mergeOrder(ready, open);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  let arg = "", suite = "", result = "", at = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suite") suite = argv[++i] || "";
    else if (argv[i].startsWith("--suite=")) suite = argv[i].slice(8);
    else if (argv[i] === "--result") result = argv[++i] || "-";
    else if (argv[i].startsWith("--result=")) result = argv[i].slice(9) || "-";
    else if (argv[i] === "--at") at = argv[++i] || "";
    else if (argv[i].startsWith("--at=")) at = argv[i].slice(5);
    else if (!arg && !argv[i].startsWith("-")) arg = argv[i];
    else { console.error(`${USAGE}\nunknown argument ${plain(argv[i])} (--help explains them)`); return 2; }
  }
  if (!suite.trim()) { console.error(`${USAGE}\n--suite is required (--help explains it)`); return 2; }
  if (result && !["pass", "fail"].includes(result)) { console.error(`${USAGE}\n--result is pass or fail`); return 2; }
  if (at && !result) { console.error(`${USAGE}\n--at goes with --result`); return 2; }
  return batch({ arg, suite, result, at });
}

// origin as this script reads it, for common: { url, refs, ls, tip }. The URL from the project's own config only, never
// <common>/remotes/origin or branches/origin, which an agent can write (#226)
function originOf(common) {
  const url = lib.gitTry(common, ["config", "--file", path.join(common, "config"), "--get", "remote.origin.url"]).out;
  const user = { user: true, timeout: 120000 };
  // refs(patterns): { <ref>: sha } as origin has them (ls-remote, so no local ref can shadow one); null when it fails
  const refs = (patterns) => {
    if (!url || url.startsWith("-")) return null;
    const r = lib.gitTry(common, ["ls-remote", url, ...patterns], user);
    if (!r.ok) return null;
    const out = {};
    for (const [sha, ref] of r.out.split("\n").map((l) => l.split("\t"))) if (SHA.test(sha) && ref) out[ref] = sha;
    return out;
  };
  // branch's tip as origin has it; "" when there is none
  const ls = (branch) => (refs([`refs/heads/${branch}`]) || {})[`refs/heads/${branch}`] || "";
  // then its objects fetched, with the human's config (credentials, proxy) as lib's release fetch: no ref, reflog or
  // FETCH_HEAD written, no maintenance, no submodule fetched (git would read an agent-written <common>/.gitmodules and
  // <common>/modules/<p>/config), and no `git for-each-ref` run in an alternate an agent lists in
  // <common>/objects/info/alternates, which would read that repo's config without GIT_SAFE
  const tip = (branch) => {
    const sha = ls(branch);
    if (!sha) return "";
    const fetched = lib.gitTry(common, ["-c", "core.alternateRefsCommand=true", "fetch", "-q", "--no-auto-maintenance", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", url, `refs/heads/${branch}`], user).ok;
    return fetched && lib.gitTry(common, ["cat-file", "-t", sha]).out === "commit" ? sha : "";
  };
  return { url, refs, ls, tip };
}

// the batch's step for { arg, suite, result, at }, checked as main checks them; its exit code. io.say and io.err take
// its stdout and stderr lines (default the console's); out gets what proteus-cli.js reads back: merged, the PRs this
// call merged ({ n, ticket?, sha }), at, the commit the lead tests next, and done, the batch's PRs once a pass ends it
function batch({ arg, suite, result, at }, io = {}, out = {}) {
  const say = io.say || ((s) => console.log(plain(s)));
  const warn = io.err || ((s) => console.error(s));

  // git runs on the project's common dir, pinned (#215), and never with a working tree (#226)
  const common = lib.repoCommon();
  const root = common && lib.mainRoot(common);
  if (!root) { warn("not in a project checkout"); return 2; }
  const runBranches = common ? lib.runBranches(common) : [];
  const run = lib.runName(arg || runBranches[0] || "");
  if (!run) { warn(`no run named and no open ${lib.CURRENT.branch}<run> branch`); return 2; }
  if (!RUN.test(run)) { warn(`run ${plain(run)}: not a run name (a letter or digit, then letters, digits, _ . -)`); return 2; }
  const work = WORK(run);
  const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
  const base = `${names.branch}${run}`;
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const fail = (why) => { say(`run ${run}: ${why}`); return 1; };
  const name = (p) => `PR #${p.n}${p.ticket ? ` for #${p.ticket}` : ""}`;
  const fw = (p) => p.split(path.sep).join("/");

  // the commands the lead runs from the project, sandboxed: _run filled with sha's tree, the suite there; then this
  // script's next call
  const next = (sha) => `suite: run node ${fw(path.relative(root, RUN_TREE))} ${sha}, then in .worktrees/_run run ${suite}, both sandboxed; then node ${fw(path.relative(root, __filename))} ${run} --suite ${JSON.stringify(suite)} --result pass|fail --at ${sha}`;
  // the merged branches whose worktree is left, each named as the tracker has it: a merged PR's head, a worker branch
  const leftFor = (st) => {
    const out = st.merged.filter((p) => p.head && st.left.includes(p.head)).flatMap((p) => {
      const v = parse(lib.gh(["pr", "view", String(p.n), "--json", "headRefName,state"], root, 30000));
      return v && v.state === "MERGED" && typeof v.headRefName === "string" && work.test(v.headRefName) ? [v.headRefName] : [];
    });
    return out.length ? `; worktree and branch left for the lead: ${out.join(", ")}` : "";
  };

  // the run branch's tip as origin has it, and that tip with its objects fetched
  const origin = originOf(common), url = origin.url;
  const lsTip = () => origin.ls(base);
  const tip = () => origin.tip(base);

  // --result: the lead's run of the printed suite on the commit the state names; the tip's, then each bisect step's
  if (result) {
    try {
      const st = readState(common, run);
      if (!st) { warn(`run ${plain(run)}: no batch awaits a result (run it without --result first)`); return 2; }
      // the result is for the commit the lead tested, named by the lead: a state an agent rewrote between the print
      // and the result (a bisect collapsed back to the tip, #226) names another, and is refused, printing no sha
      if (!at) return fail("refused: --result needs --at <sha>, the commit the suite ran on, as printed");
      if (at !== st.at) return fail("refused: --at is not the commit this batch awaits a result for (the state changed, or another step's sha); test the commit the last step printed");
      if (st.mid === null) {
        // the state is an agent's to write: the sha printed for the lead's fast-forward is origin's tip, never the state's
        if (result === "pass") {
          dropState(common, run);
          out.done = st.merged.map((p) => p.n);
          if (lsTip() !== st.head) return fail("refused: origin's run branch is not the commit the state names (the branch moved or the state changed); no commit to fast-forward to");
          say(`run ${run}: suite green at ${st.head}${leftFor(st)}`);
          return 0;
        }
        // bisect the batch's merges: the last batch ended green, the tip failed
        st.lo = -1;
        st.hi = st.merged.length - 1;
      } else if (result === "pass") st.lo = st.mid;
      else st.hi = st.mid;
      if (st.hi - st.lo > 1) {
        st.mid = (st.lo + st.hi) >> 1;
        st.at = st.merged[st.mid].sha;
        writeState(common, run, st);
        out.at = st.at;
        say(`run ${run}: bisecting, ${st.hi - st.lo - 1} merge(s) left to test; ${next(st.at)}`);
        return 0;
      }
      const p = st.merged[st.hi];
      dropState(common, run);
      say(`run ${run}: suite red; first bad ${name(p)} (${p.sha.slice(0, 12)})${leftFor(st)}`);
      return 1;
    } catch (e) {
      return fail(`refused: ${e.message}`);
    }
  }
  try { if (readState(common, run)) return fail(`a batch awaits --result pass|fail (${stateFile(common, run)})`); } catch (e) { return fail(`refused: ${e.message}`); }

  const prs = parse(lib.gh(["pr", "list", "--base", base, "--state", "open", "--json", "number,headRefName,headRefOid,body,isDraft,statusCheckRollup", "--limit", "200"], root, 30000));
  if (!Array.isArray(prs)) return fail("tracker unreachable (gh pr list failed)");
  const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,state,body", "--limit", "500"], root, 30000));
  if (!Array.isArray(issues)) return fail("tracker unreachable (gh issue list failed)");

  const ready = pick(prs, issues, run, names);
  const hold = Policy.held(ready, root, Policy.load({ root }).policy);
  for (const p of ready) if (!p.oid && !hold.some((h) => h.n === p.n)) hold.push({ n: p.n, why: "unknown" });
  out.held = hold;
  const holding = (h) => say(Policy.heldLine(h));
  for (const h of hold) holding(h);
  const picked = ready.filter((p) => !hold.some((h) => h.n === p.n));
  if (!picked.length) { say("merged none; suite not run"); return 0; }

  if (!url) return fail("refused: <common>/config names no remote.origin.url");
  if (!tip()) return fail(`cannot fetch origin/${base}`);
  // each linked worktree's branch, its HEAD read as a file
  const worktrees = {};
  for (const wt of lib.registeredWorktrees(common)) { const b = lib.branchOf(wt); if (b) worktrees[b] = wt; }

  // no worktree is removed here (#226): the merged branches that still have one are named for the lead to remove
  const merged = [];
  let stop = "";
  for (const p of picked) {
    // pinned to the head the pick or the hold check read: a push since fails the merge, and the PR waits a round
    const m = lib.ghTry(["pr", "merge", String(p.n), "--merge", "--match-head-commit", p.oid], root, 120000);
    const now = m.ok ? "" : lib.gh(["pr", "view", String(p.n), "--json", "headRefOid", "-q", ".headRefOid"], root, 30000);
    if (now && now !== p.oid) {
      const h = { n: p.n, why: "moved" };
      hold.push(h);
      holding(h);
      continue;
    }
    if (!m.ok) {
      const state = lib.gh(["pr", "view", String(p.n), "--json", "mergeable", "-q", ".mergeable"], root, 30000);
      stop = state === "CONFLICTING" ? `conflict ${name(p)}` : `PR #${p.n} not merged (${last(m.err || m.out)})`;
      break;
    }
    const sha = tip();
    if (!sha) { stop = `cannot fetch origin/${base} after PR #${p.n}`; break; }
    merged.push({ n: p.n, ...(p.ticket && { ticket: p.ticket }), ...(worktrees[p.head] && work.test(p.head) && { head: p.head }), sha });
  }
  const line = `merged ${merged.length ? merged.map(name).join(", ") : "none"}${stop ? `; ${stop}` : ""}`;
  out.merged = merged.map((p) => ({ n: p.n, ...(p.ticket && { ticket: p.ticket }), sha: p.sha }));
  if (!merged.length) { say(`${line}; suite not run`); return 1; }
  const head = merged[merged.length - 1].sha;
  try {
    writeState(common, run, { head, at: head, merged, left: merged.flatMap((p) => (p.head ? [p.head] : [])), mid: null });
  } catch (e) {
    say(`${line}; suite not run: ${e.message}`);
    return 1;
  }
  out.at = head;
  say(`${line}; ${next(head)}`);
  return stop ? 1 : 0;
}

module.exports = { mergeOrder, green, writeState, checkState, readState, pick, held: Policy.held, batch, originOf };
if (require.main === module) process.exitCode = main();
