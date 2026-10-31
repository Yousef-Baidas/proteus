#!/usr/bin/env node
// The lead's loop: node <hooks>/proteus-cli.js next [run] [--json]
//                  node <hooks>/proteus-cli.js result pass|fail --at <sha> [run]
//                  node <hooks>/proteus-cli.js brief worker <n> [run] | brief verifier <pr> [run]
// next does the mechanical steps that are due and run in this script's context, proteus-merge.js's (outside the
// sandbox, #226), then prints what is left for the lead, one line per action, in this order:
//   ASK <issue url> <title>                                  an open needs-human issue (the inbox cache)
//   ASK human #<n> <issue url>                               a ready step:human ticket: the human does it, opens the PR
//   ASK human merge PR#<n> <url>                             a green PR under merge: human (#307): the human merges it
//   ASK human PR#<n> <url>[ policy:<id>] reply: ACCEPT <sha12>  a green PR held by ask: every, or ask: risky naming
//                                                             the ask rule it hits, until the human posts that line
//   STOP <agent> <reason> / NUDGE <agent> <reason>            a STALL-AGAIN / STALL agent (the watchdog's read)
//   MERGE PR#<n> <head sha12> verdict=<state> by=<login>       a PR proteus-merge.js would pick, when no suite is known
//   MERGED PR#<n> <head sha12> verdict=<state> by=<login>      evidence: a PR this call merged (proteus-merge.js's batch)
//   RUN <command>                                            a sandboxed step for the lead's own shell: the batch's
//                                                             proteus-run-tree.js <sha> and suite in .worktrees/_run,
//                                                             printed again while the batch awaits its result
//   DECIDE suite|merge: <reason>                             no gate command in ## Learned, or a batch that stopped
//   DECIDE #<n> owned line differs from record                an open ticket whose Owned: line is not its record's
//   DECIDE #<n> slice: tier <t> too large                     a ready slice ticket (a slice: label) that is hard or full
//   SPAWN verifier PR#<n> #<ticket> head=<sha12> brief: <cmd>  an open PR with no proteus/verdict and no verifier
//                                                             spawn recorded for its head
//   SPAWN worker #<n> team=<team> difficulty=<d>[ speculative] worktree=<path> brief: <cmd>
//                                                             a ready ticket, its worktree prepared here; under a
//                                                             sandbox profile a RUN line that prepares it instead
//   BLOCKED #<n> <reason>                                     a blocked ticket, or `prep: <why>` when its prep failed,
//                                                             or `owned record pending PR#<m>` until its record merges
//   WAIT node <hooks>/proteus-watchdog.js --wait              when nothing but BLOCKED is due
// What it executes: the wave's owned-path record PR (#281) when an open ticket with an Owned: line has no
// .proteus/owned/<n> on proteus/<run> and no record PR is open: one commit of git objects alone (no worktree, index or
// checkout, #212) on proteus-work/<run>/owned-<k>, a push of that one ref and gh pr create; records are add-only.
// `git worktree add` and proteus-worktree.js for a ready ticket with no worktree (hooks.md: it runs
// outside the sandbox; under install.js --sandbox it runs inside it, so a profile turns the prep into a RUN line), and
// proteus-merge.js's batch when one is due and none awaits a result. Never proteus-run-tree.js, the suite, or the
// watchdog's --forget, which run sandboxed. result forwards to proteus-merge.js --result with the same suite and prints
// its line; a bisect step as a RUN line; on a pass, STOP <agent> for the spawn records of the merged PRs' verifiers and
// tickets' workers, then their --forget as a RUN line. --json prints next's lines as an array of { kind, ... }.
// brief renders the ## Worker or ## Verifier block of references/roles.md, read at run time, every <slot> filled from
// the tracker, the owned record, the repo and AGENTS.md ## Learned, into <scratch>/brief-<n>.md or verify-<pr>.md
// (proteus-scratch.js --path <run>), and prints `PROMPT <the spawn prompt>`; a slot with no source prints
// `DECIDE #<n> brief: no source for <slot>` and exits 1. It writes where agents can, so it runs in the lead's
// sandboxed shell: a SPAWN line names its brief command and next never runs it. A step:human ticket has no worker
// brief: `DECIDE #<n> human step: no worker brief`, exit 1.
// Exit 0 with the list; 1 when the tracker cannot be read (result: proteus-merge.js's code; brief: also a DECIDE);
// 2 on usage or no run.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
const { fromTracker, ticketOf } = require(path.join(__dirname, "proteus-ready.js"));
const { spawnSync } = require("child_process");
const { pick, held, batch, readState, originOf } = require(path.join(__dirname, "proteus-merge.js"));
const Policy = require(path.join(__dirname, "proteus-policy.js"));
const C = require(path.join(__dirname, "proteus-confine.js"));
const { stalls } = require(path.join(__dirname, "proteus-watchdog.js"));

const USAGE = "usage: node proteus-cli.js next [run] [--json] | result pass|fail --at <sha> [run] | brief worker <n>|verifier <pr> [run]";
const HELP = `${USAGE}
next prepares the ready tickets' worktrees and starts the merge batch, then prints the lead's next
actions, one line each: ASK, STOP, NUDGE, MERGE or MERGED, RUN, DECIDE, SPAWN verifier, SPAWN worker,
BLOCKED, then WAIT when nothing but BLOCKED is due. A RUN line is the lead's to run, sandboxed.
Open tickets with an Owned: line and no record on proteus/<run> get one record PR per wave, from
proteus-work/<run>/owned-<k>; they stay BLOCKED until it merges. A record is never rewritten:
a changed Owned: line prints DECIDE #<n>. A slice: label on a hard or full ticket prints DECIDE #<n> slice.
A ready step:human ticket prints ASK human #<n> <url>, never SPAWN worker: the human opens its PR.
The policy (proteus-policy.js show) holds green PRs: merge human prints ASK human merge PR#<n> <url>;
ask every, or ask risky for a PR an ask rule covers, ASK human PR#<n> <url> [policy:<id>]
reply: ACCEPT <sha12>, until the human's comment on the PR is that line for its current head.
  run      the run; defaults to the open proteus/<run> branch
  --json   the same as a JSON array of { kind, ... }
result reports the suite the RUN line printed: pass ends the batch and prints STOP for the merged
tickets' agents; fail bisects, printing the next RUN line. --at is the sha the RUN line named.
The suite is the gate command of AGENTS.md ## Learned.
brief writes the worker's (or the PR's verifier's) brief from roles.md into the run's scratch dir and
prints PROMPT <the spawn prompt>; a slot with no source prints DECIDE #<n> brief: ... and exits 1.
Exit 0 with the list; 1 when the tracker cannot be read (result: proteus-merge.js's code); 2 on usage or no run.`;
const VERDICT = "proteus/verdict";
// a human-operated step (#82): no worker, no contracts, no brief; the human commits the evidence and opens the PR
const isHuman = (issue) => ((issue || {}).labels || []).some((l) => l.name === "step:human");
// what reaches the lead's output: no control character (terminal escapes, a second line)
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const last = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";
// one shell word for a RUN line: owned globs stay unexpanded and a path from the tracker runs nothing
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const fw = (p) => p.split(path.sep).join("/");
const WORKTREE = path.join(__dirname, "proteus-worktree.js");
const RUN_TREE = path.join(__dirname, "proteus-run-tree.js");
const WATCHDOG = path.join(__dirname, "proteus-watchdog.js");
const SCRATCH = path.join(__dirname, "proteus-scratch.js");
const CLI = path.join(__dirname, "proteus-cli.js");

// an issue's web URL on the project's repo (lib.ghRepo: owner/name on github.com, else host/owner/name)
function issueUrl(root, n, kind = "issues") {
  const repo = lib.ghRepo(root);
  if (!repo) return `#${n}`;
  return repo.split("/").length === 3 ? `https://${repo}/${kind}/${n}` : `https://github.com/${repo}/${kind}/${n}`;
}

// the newest proteus/verdict status on sha with its poster, { verdict, by }; the rollup's state and "?" when the API fails
function verdictOf(root, sha, rollup) {
  const list = parse(lib.gh(["api", `repos/{owner}/{repo}/commits/${sha}/statuses`], root, 30000));
  const s = Array.isArray(list) ? list.find((x) => x && x.context === VERDICT) : null; // newest first
  if (s) return { verdict: String(s.state || "?"), by: String((s.creator && s.creator.login) || "?") };
  const r = rollup.find((c) => (c.context || c.name) === VERDICT) || {};
  return { verdict: String(r.state || "?").toLowerCase(), by: "?" };
}

// the spawn records the lead's guard wrote (lib.recordSpawn): a verifier's PR and head sha12 from the prompt's PR#<n> and
// head=<sha12>, a worker's ticket from its `worker #<n>`; each { name, type, pr?, head?, ticket? }
function spawns(common) {
  const dir = lib.leadPath(common, "spawns");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  return files.flatMap((f) => {
    const r = lib.readJSON(path.join(dir, f), null);
    return r && typeof r.name === "string" && typeof r.type === "string" ? [r] : [];
  });
}
// the commits on branch past the refs in not, newest first, each { sha, contract }: contract when its subject is the
// contract's for #n (`test(<scope>): contract for #<n>`); null when git cannot read the branch
function commitsPast(common, branch, n, not) {
  const log = lib.gitTry(common, ["log", "--format=%H%x09%s", `refs/heads/${branch}`, "--not", ...not]);
  if (!log.ok) return null;
  const re = new RegExp(`^test(?:\\([^)]*\\))?: contract for #${n}$`);
  return log.out.split("\n").filter(Boolean).map((l) => { const [sha, s] = l.split("\t"); return { sha, contract: re.test(s || "") }; });
}
const isWorker = (type) => /^proteus-(?:[a-z0-9-]+-)?worker$/.test(lib.agentName(type));

// the gate command(s) on the gate line of AGENTS.md ## Learned (`- gate: \`<command>\``); [] when there is none
function gates(root) {
  let text = "";
  try { text = fs.readFileSync(path.join(lib.docRoot(root), "AGENTS.md"), "utf8"); } catch {}
  const learned = /^##[ \t]+Learned[ \t]*$([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(text);
  const m = learned && /^[ \t]*(?:[-*][ \t]*)?gates?:[ \t]*(.+)$/im.exec(learned[1]);
  if (!m) return [];
  const ticks = [...m[1].matchAll(/`([^`]+)`/g)].flatMap((t) => (t[1].trim() ? [t[1].trim()] : []));
  return ticks.length ? ticks : [m[1].trim()];
}
// the suite: the gate commands joined with &&; "" when there is none
const gateCommand = (root) => gates(root).join(" && ");
// the batch's two sandboxed commands for sha, as proteus-merge.js prints them
const suiteRun = (root, suite, sha) => `node ${fw(path.relative(root, RUN_TREE))} ${sha}, then in .worktrees/_run: ${suite}`;
// proteus-merge.js's line without its own suite commands, which the RUN line carries
const mergeSaid = (said) => said.map((l) => l.replace(/; suite: run node .*$/, "")).join("; ");

// a ready ticket's worktree <root>/.worktrees/<n> on proteus-work/<run>/<n>, made and prepared here; "" or why not.
// The base is the run branch's commit, origin's first, by full ref name
function prep(root, common, base, wt, branch, tier, owned) {
  if (!fs.existsSync(wt)) {
    const add = lib.gitTry(common, ["worktree", "add", "-q", "-b", branch, wt, base], { timeout: 120000 });
    if (!add.ok) return last(add.err || add.out) || "git worktree add failed";
  } else if (lib.branchOf(wt) !== branch) return `${wt} exists and is not a worktree on ${branch}`;
  const r = spawnSync(process.execPath, [WORKTREE, wt, "--tier", tier, ...owned], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return r.status === 0 ? "" : last(r.stderr || r.stdout) || `proteus-worktree.js exited ${r.status}`;
}
const prepared = (wt, branch) => fs.existsSync(lib.ownedFile(wt)) && lib.branchOf(wt) === branch;

// a ticket body's Owned: line, and a record's lines, as their entries
const ownedLine = (body) => { const m = /^Owned:[ \t]*(.+)$/im.exec(body || ""); return m ? m[1].split(/[,\s]+/).filter(Boolean) : []; };
const entries = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const same = (a, b) => a.length === b.length && a.every((e) => b.includes(e));
// a tree's entries from ls-tree -z, each { mode, type, obj, name, line }; null when spec names no tree
function treeOf(common, spec) {
  const r = lib.gitTry(common, ["ls-tree", "-z", spec]);
  if (!r.ok) return null;
  return r.out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t"), [mode, type, obj] = line.slice(0, tab).split(" ");
    return { mode, type, obj, name: line.slice(tab + 1), line };
  });
}
// the records on commit sha: { <ticket>: blob sha }
function recordsAt(common, sha) {
  const out = {};
  for (const e of (sha && treeOf(common, `${sha}:${lib.OWNED_RECORDS}`)) || []) if (e.type === "blob" && /^\d+$/.test(e.name)) out[e.name] = e.obj;
  return out;
}
// tree (a tree-ish, "" for none) with the blobs add ([name, sha]) put under dir parts, as git's objects alone: hash-object,
// ls-tree and mktree, no index and no checkout; the new tree's sha, "" on a failure or a file where a dir should be
function treeWith(common, tree, parts, add) {
  const list = tree ? treeOf(common, tree) : [];
  if (!list) return "";
  let lines = list.map((e) => e.line);
  if (!parts.length) lines = [...lines.filter((l) => !add.some(([n]) => l.endsWith(`\t${n}`))), ...add.map(([n, sha]) => `100644 blob ${sha}\t${n}`)];
  else {
    const cur = list.find((e) => e.name === parts[0]);
    if (cur && cur.type !== "tree") return "";
    const sub = treeWith(common, cur ? cur.obj : "", parts.slice(1), add);
    if (!sub) return "";
    lines = [...lines.filter((l) => l !== (cur && cur.line)), `040000 tree ${sub}\t${parts[0]}`];
  }
  return lib.gitIn(common, ["mktree", "-z"], 30000, { input: lines.map((l) => `${l}\0`).join("") });
}
// the commit message: every ticket on the subject while it fits commit-msg.js's 72, else listed in the body
function recordMessage(ns) {
  const tickets = ns.map((n) => `#${n}`).join(", ");
  const subject = `chore(proteus): record owned paths for ${tickets}`;
  if (subject.length <= 72) return subject;
  const body = [];
  for (const t of ns.map((n) => `#${n}`)) {
    if (body.length && `${body[body.length - 1]}, ${t}`.length <= 72) body[body.length - 1] += `, ${t}`;
    else body.push(t);
  }
  return `chore(proteus): record owned paths for ${ns.length} tickets\n\n${body.join(",\n")}`;
}

// the wave's owned-path records (#281): every open ticket with an Owned: line and no record on the run branch gets one,
// all in one commit on proteus-work/<run>/owned-<k>, cut from origin's tip of the run branch, and one PR into it, made
// here with git's objects alone (no worktree, checkout or index: this runs outside the sandbox, #212 r5) and one push
// of that ref. Records are add-only, and one record PR is open at a time; a ticket added meanwhile waits for the next.
// { at, has: Set of recorded tickets, wait: Map ticket -> why, out: [action], pr: the PR opened here or null }
function records(root, common, run, names, issues, prs, local) {
  const branch = `${names.branch}${run}`, prefix = `${lib.CURRENT.work}${run}/owned-`;
  const res = { at: local, has: new Set(), wait: new Map(), out: [], pr: null };
  const open = lib.runTickets(issues, run, names).filter((i) => String(i.state).toUpperCase() === "OPEN" && ownedLine(i.body).length);
  let recs = recordsAt(common, local);
  let missing = open.filter((i) => !(i.number in recs));
  // a record the local refs lack may be on origin already: its tip, fetched, is what counts and what a batch is cut from
  const origin = missing.length ? originOf(common) : null;
  const tip = origin ? origin.tip(branch) : "";
  if (tip) {
    res.at = tip;
    recs = recordsAt(common, tip);
    missing = open.filter((i) => !(i.number in recs));
  }
  for (const n of Object.keys(recs)) res.has.add(+n);
  for (const i of open.filter((x) => x.number in recs)) {
    const r = lib.gitTry(common, ["cat-file", "blob", recs[i.number]]);
    if (r.ok && !same(entries(r.out), ownedLine(i.body))) res.out.push({ kind: "DECIDE", ticket: i.number, reason: "owned line differs from record" });
  }
  if (!missing.length) return res;
  const waitAll = (why) => { for (const i of missing) res.wait.set(i.number, why); return res; };
  const pending = prs.find((p) => String(p.headRefName || "").startsWith(prefix));
  if (pending) {
    const listed = new Set([...String(pending.body || "").matchAll(/^- #(\d+)\b/gm)].map((m) => +m[1]));
    for (const i of missing) res.wait.set(i.number, listed.has(i.number) ? `owned record pending PR#${pending.number}` : `owned record waits for the batch after PR#${pending.number}`);
    return res;
  }
  if (!tip) return waitAll(`owned record: cannot fetch origin/${branch}`);
  const heads = origin.refs([`refs/heads/${prefix}*`]);
  if (!heads) return waitAll(`owned record: cannot list origin's ${prefix}* branches`);
  const k = 1 + Math.max(0, ...Object.keys(heads).map((r) => +(/-(\d+)$/.exec(r) || [0, 0])[1]));
  const head = `${prefix}${k}`;
  const add = [];
  for (const i of missing) {
    const blob = lib.gitIn(common, ["hash-object", "-w", "--stdin"], 30000, { input: `${ownedLine(i.body).join("\n")}\n` });
    if (!blob) return waitAll("owned record: git hash-object failed");
    add.push([String(i.number), blob]);
  }
  const tree = treeWith(common, tip, lib.OWNED_RECORDS.split("/"), add);
  if (!tree) return waitAll(`owned record: cannot add ${lib.OWNED_RECORDS}/ to ${branch}'s tree`);
  const ns = missing.map((i) => i.number), msg = recordMessage(ns);
  const commit = lib.gitTry(common, ["commit-tree", tree, "-p", tip, "-m", msg], { user: true, timeout: 60000 });
  if (!commit.ok) return waitAll(`owned record: git commit-tree failed (${last(commit.err)})`);
  const push = lib.gitTry(common, ["push", "-q", origin.url, `${commit.out}:refs/heads/${head}`], { user: true, timeout: 120000 });
  if (!push.ok) return waitAll(`owned record: push ${head} failed (${last(push.err)})`);
  const body = ["Tier: full", "", "The wave's owned-path records, one per ticket, add-only:", ...missing.map((i) => `- #${i.number} ${ownedLine(i.body).join(" ")}`)].join("\n");
  const made = lib.ghTry(["pr", "create", "--base", branch, "--head", head, "--title", msg.split("\n")[0], "--body", body], root, 60000);
  const n = made.ok ? +(/\/pull\/(\d+)\s*$/.exec(made.out) || [0, 0])[1] : 0;
  if (!n) return waitAll(`owned record: gh pr create for ${head} failed (${last(made.err || made.out)})`);
  res.pr = { number: n, headRefName: head, headRefOid: commit.out, body, statusCheckRollup: [] };
  return waitAll(`owned record pending PR#${n}`);
}

// the project and the run: { root, common, refs, run, names }, or { code, err }
function where(arg) {
  const root = path.resolve(lib.projectRoot());
  const common = lib.gitCommonDir(root);
  const refs = common ? lib.runRefs(common) : [];
  const runBranches = common ? lib.runBranches(common) : [];
  const run = lib.runName(arg || runBranches[0] || "");
  if (!run) return { code: 2, err: `no run named and no open ${lib.CURRENT.branch}<run> branch` };
  const names = lib.schemeOf(arg) || lib.schemeOf(runBranches.find((b) => lib.runName(b) === run) || "") || lib.CURRENT;
  return { root, common, refs, run, names };
}

// the other teams a slice ticket's slice:<team>[,<team>] labels name, [] for any other ticket
const sliceTeams = (labels) => [...new Set(labels.filter((l) => l.startsWith("slice:")).flatMap((l) => l.slice(6).split(",")).map((t) => t.trim()).filter(Boolean))];

// the actions, in print order, after the due steps ran; { code, err } when there are none to give
function next(arg) {
  const w = where(arg);
  if (w.err) return w;
  const { root, common, run, names } = w;

  const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,title,state,milestone,labels,body", "--limit", "500"], root, 30000));
  if (!Array.isArray(issues)) return { code: 1, err: `run ${run}: tracker unreachable (gh issue list failed)` };
  const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "open", "--json", "number,headRefName,headRefOid,body,isDraft,statusCheckRollup", "--limit", "200"], root, 30000));
  if (!Array.isArray(prs)) return { code: 1, err: `run ${run}: tracker unreachable (gh pr list failed)` };
  const reviews = parse(lib.gh(["issue", "list", "--label", names.review, "--state", "open", "--json", "milestone", "--limit", "50"], root, 10000)) || [];

  const out = [];
  // the cache as the inbox keeps it; gh's answer, unwritten, only when there is no cache
  const inbox = (common && lib.readInbox(common)) || lib.queryInbox(root);
  if (inbox) for (const i of [...inbox.questions, ...inbox.reviews]) out.push({ kind: "ASK", n: i.n, url: issueUrl(root, i.n), title: i.title });
  const askAt = out.length;

  if (common) {
    const { stalled } = stalls(common, Date.now());
    for (const s of stalled.filter((x) => x.again)) out.push({ kind: "STOP", agent: s.agent, reason: `${s.why}, cwd ${s.cwd}` });
    for (const s of stalled.filter((x) => !x.again)) out.push({ kind: "NUDGE", agent: s.agent, reason: `${s.why}, cwd ${s.cwd}` });
  }

  // the merge batch: while one awaits its result, its RUN line again and no new batch; else proteus-merge.js's own
  // batch over the PRs it picks, each merged one's evidence read before the merge
  const suite = gateCommand(root);
  let waiting = null;
  try { waiting = common ? readState(common, run) : null; } catch (e) { waiting = { refused: e.message }; }
  const merged = new Set();
  const byN = new Map(prs.map((p) => [p.number, p]));
  // the policy's holds (#307): the batch's own when it runs, else read here for the MERGE lines
  const green = waiting ? [] : pick(prs, issues, run, names);
  let holds = green.length && !suite ? held(green, root, Policy.load({ root }).policy) : [];
  const picked = green.filter((m) => !holds.some((h) => h.n === m.n)).map((m) => {
    const p = byN.get(m.n), head = String(p.headRefOid || "");
    return { pr: m.n, head, ...verdictOf(root, head, p.statusCheckRollup || []) };
  });
  if (waiting && waiting.refused) out.push({ kind: "DECIDE", about: "merge", reason: `refused: ${waiting.refused}` });
  else if (waiting) out.push(suite ? { kind: "RUN", command: suiteRun(root, suite, waiting.at) } : { kind: "DECIDE", about: "suite", reason: "no gate command in ## Learned" });
  else if (picked.length && !suite) {
    for (const m of picked) out.push({ kind: "MERGE", ...m });
    out.push({ kind: "DECIDE", about: "suite", reason: "no gate command in ## Learned" });
  } else if (picked.length) {
    const said = [], res = {};
    const code = batch({ arg: arg || run, suite, result: "", at: "" }, { say: (l) => said.push(l), err: (l) => said.push(l) }, res);
    holds = res.held || [];
    const ev = new Map(picked.map((m) => [m.pr, m]));
    for (const m of res.merged || []) {
      merged.add(m.n);
      out.push({ kind: "MERGED", ...(ev.get(m.n) || { pr: m.n, head: "?", verdict: "?", by: "?" }) });
    }
    if (res.at) out.push({ kind: "RUN", command: suiteRun(root, suite, res.at) });
    if (code !== 0) out.push({ kind: "DECIDE", about: "merge", reason: mergeSaid(said) });
  }

  // the run branch's commit as the local refs have it, origin's first, by full ref name
  const local = [`refs/remotes/origin/${names.branch}${run}`, `refs/heads/${names.branch}${run}`]
    .map((r) => lib.gitTry(common, ["rev-parse", "--verify", "-q", `${r}^{commit}`]).out).find((x) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(x)) || "";
  const owned = common ? records(root, common, run, names, issues, prs, local) : { at: local, has: null, wait: new Map(), out: [], pr: null };
  out.push(...owned.out);

  // the brief's command, for the lead's sandboxed shell (it writes in scratch): printed, never run here
  const briefCmd = (role, k) => `node ${CLI} brief ${role} ${k}${arg ? ` ${run}` : ""}`;
  const recs = common ? spawns(common) : [];
  const spawned = new Set(recs.filter((r) => lib.isVerifier(r.type) && Number.isInteger(r.pr) && typeof r.head === "string").map((r) => `${r.pr} ${r.head}`));
  for (const p of owned.pr ? [...prs, owned.pr] : prs) {
    const head = String(p.headRefOid || "");
    if (merged.has(p.number) || (p.statusCheckRollup || []).some((c) => (c.context || c.name) === VERDICT) || spawned.has(`${p.number} ${head.slice(0, 12)}`)) continue;
    out.push({ kind: "SPAWN", role: "verifier", pr: p.number, ticket: ticketOf(run, names, String(p.headRefName || ""), p.body || ""), head, brief: briefCmd("verifier", p.number) });
  }

  // a ticket's worker branch counts as in flight; but one this script prepared, whose worker is not spawned yet, with
  // nothing but the ticket's contract committed past the base its owned list records, leaves the ticket the lead's to
  // spawn (an open PR keeps it in flight through fromTracker)
  const workers = new Set(recs.filter((r) => isWorker(r.type) && Number.isInteger(r.ticket)).map((r) => r.ticket));
  const wtOf = (n) => path.join(root, ".worktrees", String(n));
  const branchOf = (n) => `${lib.CURRENT.work}${run}/${n}`;
  const unstarted = (n, b) => {
    let list = "";
    try { list = fs.readFileSync(lib.ownedFile(wtOf(n)), "utf8"); } catch { return false; }
    const at = /^# tier \S+(?: human)? ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/m.exec(list);
    const past = at && commitsPast(common, b, n, [at[1]]);
    return !!past && past.every((c) => c.contract);
  };
  const refs = w.refs.filter((b) => {
    const n = ticketOf(run, names, b);
    return !(n && b === branchOf(n) && !workers.has(n) && lib.branchOf(wtOf(n)) === b && unstarted(n, b));
  });
  const { ready, blocked } = fromTracker(root, run, names, { issues, prs, reviews, refs, at: owned.at });
  const byIssue = new Map(issues.map((i) => [i.number, i]));
  // under install.js --sandbox the in-repo proteus-worktree.js runs inside the sandbox and its copy outside it
  // (flow.md step 3): the prep is a RUN line then
  const copy = common ? path.join(C.sandboxBin(common), "proteus-worktree.js") : "";
  const profile = !!copy && fs.existsSync(copy);
  const base = owned.at;
  const failed = [], humans = [];
  for (const t of ready) {
    const wt = wtOf(t.n), branch = branchOf(t.n);
    // dispatched only once its record is on the run branch, which CI checks its PR against
    if (owned.has && !owned.has.has(t.n)) { failed.push({ kind: "BLOCKED", ticket: t.n, reason: owned.wait.get(t.n) || "owned record pending" }); continue; }
    if (isHuman(byIssue.get(t.n))) { humans.push({ kind: "ASK", human: true, n: t.n, url: issueUrl(root, t.n) }); continue; }
    const tierLine = /^Tier:[ \t]*(\S+)/im.exec((byIssue.get(t.n) || {}).body || "");
    const tier = tierLine ? tierLine[1].toLowerCase() : "standard";
    // a slice ticket (teams.md, Routing) is Quick or Standard only
    const big = t.difficulty === "hard" ? "hard" : tier === "full" ? "full" : "";
    if (big && sliceTeams(((byIssue.get(t.n) || {}).labels || []).map((l) => l.name)).length) { out.push({ kind: "DECIDE", ticket: t.n, reason: `slice: tier ${big} too large` }); continue; }
    if (!prepared(wt, branch)) {
      const why = !lib.TIERS.includes(tier) ? `Tier: ${tier} is not one of ${lib.TIERS.join(", ")}`
        : !fs.existsSync(wt) && !base ? `no ${names.branch}${run} to cut the worktree from` : "";
      if (why) { failed.push({ kind: "BLOCKED", ticket: t.n, reason: `prep: ${why}` }); continue; }
      if (profile) {
        const add = fs.existsSync(wt) ? [] : [`git worktree add -b ${sq(branch)} ${sq(wt)} ${base}`];
        out.push({ kind: "RUN", command: [...add, `node ${sq(WORKTREE)} ${sq(wt)} --tier ${tier} ${t.owned.map(sq).join(" ")}`, `node ${sq(copy)} ${sq(root)}`].join(" && ") });
        continue;
      }
      const err = prep(root, common, base, wt, branch, tier, t.owned);
      if (err) { failed.push({ kind: "BLOCKED", ticket: t.n, reason: `prep: ${err}` }); continue; }
    }
    out.push({ kind: "SPAWN", role: "worker", ticket: t.n, team: t.team, difficulty: t.difficulty, speculative: t.speculative, worktree: wt, brief: briefCmd("worker", t.n) });
  }
  const asked = holds.map((h) => ({ kind: "ASK", human: true, pr: h.n, url: issueUrl(root, h.n, "pull"), why: h.why, sha: h.sha || "" }));
  out.splice(askAt, 0, ...asked, ...humans);
  out.push(...failed);
  for (const b of blocked) out.push({ kind: "BLOCKED", ticket: b.n, reason: b.reason });
  if (out.every((a) => a.kind === "BLOCKED")) out.push({ kind: "WAIT", command: `node ${WATCHDOG} --wait` });
  return { code: 0, out };
}

// result pass|fail --at <sha>: proteus-merge.js --result with the gate command as the suite; its lines, a bisect step
// as a RUN line, and on a pass that ends the batch the STOP lines and their --forget; { code, out: [line] }
function result(arg, verdict, at) {
  const w = where(arg);
  if (w.err) return w;
  const { root, common, run, names } = w;
  const suite = gateCommand(root);
  if (!suite) return { code: 0, out: ["DECIDE suite: no gate command in ## Learned"] };
  const said = [], res = {};
  const code = batch({ arg: arg || run, suite, result: verdict, at }, { say: (l) => said.push(l), err: (l) => said.push(l) }, res);
  const out = [mergeSaid(said)];
  if (res.at) out.push(`RUN ${suiteRun(root, suite, res.at)}`);
  if (verdict !== "pass" || code !== 0 || !res.done) return { code, out };
  // the merged PRs as gh reports them, never as the state names them (an agent can write it), and their tickets
  const prs = new Set(), tickets = new Set();
  for (const n of res.done) {
    const v = parse(lib.gh(["pr", "view", String(n), "--json", "headRefName,state"], root, 30000));
    if (!v || v.state !== "MERGED") continue;
    prs.add(n);
    const t = ticketOf(run, names, String(v.headRefName || ""));
    if (t) tickets.add(t);
  }
  const stop = spawns(common).filter((r) => (lib.isVerifier(r.type) && prs.has(r.pr)) || (isWorker(r.type) && tickets.has(r.ticket))).map((r) => r.name);
  for (const a of stop) out.push(`STOP ${a}`);
  if (stop.length) out.push(`RUN node ${WATCHDOG} --forget ${stop.map(sq).join(" ")}`);
  return { code, out };
}

// ---- brief worker <n> | brief verifier <pr>: the role's block of roles.md, read here at run time (never copied into
// this script), every slot filled from the tracker, the owned record and the repo; a slot with no source is a DECIDE

// roles.md: the skill dirs the harness loads (project, user, plugin), then the skill beside this hooks dir's plugin root
function rolesFile(root) {
  let dirs = [];
  try { dirs = require(path.join(__dirname, "proteus-harness.js")).skillDirs(root); } catch {}
  return [...dirs, path.join(__dirname, "..", "..", "skills", "proteus")].map((d) => path.join(d, "references", "roles.md")).find((f) => fs.existsSync(f)) || "";
}
// the fenced block under `## <role>`, "" when there is none
function roleBlock(text, role) {
  const m = new RegExp(`^## ${role}[ \\t]*\\r?\\n\`\`\`\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`[ \\t]*$`, "m").exec(String(text || "").replace(/\r\n/g, "\n"));
  return m ? m[1] : "";
}
// a whole line `<label: text>` (or `<a: x | b: y>`) is conditional: its first alternative whose label holds, else dropped
const COND = /^<([A-Za-z][\w =-]*?): (.*)>$/;
const alts = (inner) => inner.split(/ \| (?=[A-Za-z][\w =-]*?: )/).map((a) => { const i = a.indexOf(": "); return [a.slice(0, i), a.slice(i + 2)]; });
// a block's slots: { lines: [conditional labels], inline: [slot names] }
function slotsOf(block) {
  const lines = [], inline = [];
  for (const l of block.split("\n")) {
    const c = COND.exec(l.trim());
    const text = c ? alts(`${c[1]}: ${c[2]}`).map(([label, t]) => (lines.push(label), t)).join(" ") : l;
    for (const m of text.matchAll(/<([^<>\n]+)>/g)) inline.push(m[1]);
  }
  return { lines: [...new Set(lines)], inline: [...new Set(inline)] };
}
// the slots the agent fills itself (the report's own placeholders), left as they are
const KEPT = ["name", "WORD", "file:line", "one paragraph"];
// a whole-line slot that is dropped when its source is empty
const OPTIONAL = ["safety"];
class Decide extends Error {}
const need = (slot, v) => { if (v === "" || v == null) throw new Decide(slot); return v; };
const FILL = {
  hooks: (c) => c.hooks,
  "gate commands": (c) => need("gate commands", c.gates.map((g) => `\`${g}\``).join(", ")),
  team: (c) => need("team", c.team),
  n: (c) => need("n", c.n && String(c.n)),
  id: (c) => need("id", c.n && String(c.n)),
  run: (c) => c.run,
  pr: (c) => need("pr", c.pr && String(c.pr)),
  "absolute path": (c) => need("absolute path", c.worktree()),
  "the ticket's tier": (c) => c.tier,
  "slice profiles": (c) => sliceTeams(c.labels).map((t) => `teams/${t}/PROFILE.md`).join(", "),
  "contract sha": (c) => need("contract sha", c.contract()),
  "file:line pointers": (c) => need("file:line pointers", c.checkFiles().join(", ")),
  "file::name or command": (c) => need("file::name or command", c.check),
  paths: (c) => need("paths", c.owned().join(" ")),
  safety: (c) => c.safety(),
  d: (c) => need("d", c.debt()),
  "fallow dupes | vulture": (c) => need("dupes tool", c.dupes()),
  sha: (c) => need("sha", c.head),
};
const WHEN = {
  Codex: (c) => c.codex,
  "Quick or mechanical": (c) => c.tier === "quick" || c.difficulty === "mechanical",
  "standard or hard": (c) => need("difficulty", ["standard", "hard"].includes(c.difficulty) ? c.difficulty : ""),
  "needs-research": (c) => c.labels.includes("needs-research"),
  slice: (c) => sliceTeams(c.labels).length > 0,
  "isolation=container": (c) => c.container,
};
// the block with every slot filled; throws Decide(slot) for one with no source
function render(block, ctx) {
  const fill = (text) => text.replace(/<([^<>\n]+)>/g, (all, s) => {
    if (KEPT.includes(s)) return all;
    if (!FILL[s]) throw new Decide(s);
    return FILL[s](ctx);
  });
  const out = [];
  for (const l of block.split("\n")) {
    const c = COND.exec(l.trim());
    if (c) {
      const pick = alts(`${c[1]}: ${c[2]}`).find(([label]) => { if (!WHEN[label]) throw new Decide(label); return WHEN[label](ctx); });
      if (pick) out.push(fill(pick[1]));
      continue;
    }
    const whole = /^<([^<>]+)>$/.exec(l.trim());
    if (whole && OPTIONAL.includes(whole[1])) { const v = fill(l); if (v.trim()) out.push(v); continue; }
    // a run ticket's branch and PR base are the run's (next cuts it from proteus/<run>), so the Quick ones go
    out.push(fill(l.replace(/ \(Quick: [^)]*\)/g, "")));
  }
  return out.join("\n") + "\n";
}
const memo = (f) => { let v, done = false; return () => (done ? v : ((done = true), (v = f()))); };

// the context the fillers read, for ticket n (and, for a verifier, PR pr with its head); lazy where it costs a call
function briefContext(w, issues, n, extra = {}) {
  const { root, common, run, names } = w;
  const issue = issues.find((i) => i.number === n) || {};
  const labels = (issue.labels || []).map((l) => l.name);
  const label = (p) => (labels.find((l) => l.startsWith(p)) || "").slice(p.length);
  const tierLine = /^Tier:[ \t]*(\S+)/im.exec(issue.body || "");
  const checkLine = /^Check:[ \t]*(.+)$/im.exec(issue.body || "");
  const branch = `${lib.CURRENT.work}${run}/${n}`, wt = path.join(root, ".worktrees", String(n));
  const runRefs = [`refs/remotes/origin/${names.branch}${run}`, `refs/heads/${names.branch}${run}`].filter((r) => lib.gitTry(common, ["rev-parse", "--verify", "-q", r]).ok);
  const team = label("profile:");
  const ctx = {
    hooks: lib.realNative(__dirname), gates: gates(root), run, n: issue.number ? n : 0, team, labels,
    difficulty: label("difficulty:"), tier: tierLine ? tierLine[1].toLowerCase() : "standard",
    check: checkLine ? checkLine[1].trim() : "",
    codex: require(path.join(__dirname, "proteus-harness.js")).name === "codex",
    container: (lib.agentsLine(root, "isolation") || "").trim() === "container",
    worktree: () => (lib.branchOf(wt) === branch ? wt : ""),
    // the oldest commit on the worker branch, past the run branch, whose subject is the contract's
    contract: memo(() => {
      return (commitsPast(common, branch, n, runRefs) || []).filter((c) => c.contract).map((c) => c.sha).pop() || "";
    }),
    // the Check line's words that name a file in the contract commit's tree, each as file[:line]
    checkFiles: memo(() => {
      const sha = ctx.contract();
      const words = ctx.check.split(/\s+/).map((t) => t.replace(/^[`'"(]+|[`'",.;)]+$/g, "").split("::")[0]);
      return [...new Set(sha ? words : [])].filter((t) => t && lib.gitTry(common, ["cat-file", "-e", `${sha}:${t.replace(/:\d+(?:-\d+)?$/, "")}`]).ok);
    }),
    // the record on the run branch, else the ticket's Owned: line
    owned: memo(() => {
      const at = runRefs.map((r) => lib.gitTry(common, ["rev-parse", r]).out).find(Boolean) || "";
      const blob = recordsAt(common, at)[n];
      const r = blob ? lib.gitTry(common, ["cat-file", "blob", blob]) : null;
      return r && r.ok ? entries(r.out) : ownedLine(issue.body);
    }),
    safety: () => {
      let text = "";
      try { text = fs.readFileSync(path.join(lib.docRoot(root), "teams", team, "PROFILE.md"), "utf8"); } catch {}
      return team ? text.split(/\r?\n/).filter((l) => l.startsWith("Safety:")).join("\n") : "";
    },
    // the open debt issue of the ticket's milestone, when there is exactly one
    debt: memo(() => {
      const ms = issue.milestone && issue.milestone.title;
      const list = ms ? parse(lib.gh(["issue", "list", "--label", names.debt, "--state", "open", "--json", "number,milestone", "--limit", "50"], root, 30000)) : null;
      const mine = (Array.isArray(list) ? list : []).filter((d) => d && d.milestone && d.milestone.title === ms);
      return mine.length === 1 ? String(mine[0].number) : "";
    }),
    // stack.md's dupes tool per language the repo's manifests name
    dupes: () => [["fallow dupes", ["package.json"]], ["vulture", ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]]]
      .flatMap(([t, files]) => (files.some((f) => fs.existsSync(path.join(root, f))) ? [t] : [])).join(" and "),
    ...extra,
  };
  return ctx;
}

// brief worker <n> | verifier <pr>: { code, out: [line] } or { code, err }
function brief(role, target, arg) {
  const w = where(arg);
  if (w.err) return w;
  const { root, run, names } = w;
  const num = /^#?(\d+)$/.exec(target || "");
  if (!num) return { code: 2, err: `${USAGE}\nbrief ${role} needs a ${role === "worker" ? "ticket" : "PR"} number` };
  const file = rolesFile(root);
  const block = roleBlock(file ? fs.readFileSync(file, "utf8") : "", role === "worker" ? "Worker" : "Verifier");
  if (!block) return { code: 1, err: `no ## ${role === "worker" ? "Worker" : "Verifier"} block in ${file || "references/roles.md (not found)"}` };
  const issues = parse(lib.gh(["issue", "list", "--label", names.label, "--state", "all", "--json", "number,title,state,milestone,labels,body", "--limit", "500"], root, 30000));
  if (!Array.isArray(issues)) return { code: 1, err: `run ${run}: tracker unreachable (gh issue list failed)` };
  let ctx, name, prompt, n = +num[1];
  if (role === "verifier") {
    const prs = parse(lib.gh(["pr", "list", "--base", `${names.branch}${run}`, "--state", "open", "--json", "number,headRefName,headRefOid,body,isDraft,statusCheckRollup", "--limit", "200"], root, 30000));
    if (!Array.isArray(prs)) return { code: 1, err: `run ${run}: tracker unreachable (gh pr list failed)` };
    const pr = n, p = prs.find((x) => x.number === pr);
    const head = p && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(p.headRefOid)) ? p.headRefOid : "";
    if (!head) return { code: 1, out: [`DECIDE PR#${pr} brief: no source for ${p ? "sha" : "pr"}`] };
    n = ticketOf(run, names, String(p.headRefName || ""), p.body || "") || 0;
    ctx = briefContext(w, issues, n, { pr, head });
    name = `verify-${pr}.md`;
    prompt = `verifier PR#${pr} head=${head.slice(0, 12)}`;
  } else {
    if (isHuman(issues.find((i) => i.number === n))) return { code: 1, out: [`DECIDE #${n} human step: no worker brief`] };
    ctx = briefContext(w, issues, n);
    name = `brief-${n}.md`;
    prompt = `worker #${n}`;
  }
  let text;
  try {
    text = render(block, ctx);
    // the worker's guards bind it to the worktree its spawn prompt names (lib.briefWorktree); a verifier names none
    if (role === "worker") prompt += ` worktree ${FILL["absolute path"](ctx)}`;
  } catch (e) {
    if (!(e instanceof Decide)) throw e;
    return { code: 1, out: [`DECIDE ${n ? `#${n}` : `PR#${ctx.pr}`} brief: no source for ${e.message}`] };
  }
  const r = spawnSync(process.execPath, [SCRATCH, "--path", run], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  const dir = r.status === 0 ? last(r.stdout) : "";
  if (!dir) return { code: 1, err: `proteus-scratch.js --path ${run} failed: ${last(r.stderr) || `exit ${r.status}`}` };
  const out = path.join(dir, name);
  // scratch is agent-writable: unlink what is there (a link goes, never its target), then create, never through a link
  try { fs.rmSync(out, { force: true }); fs.writeFileSync(out, text, { flag: "wx" }); } catch (e) { return { code: 1, err: `${out} not written: ${e.message}` }; }
  return { code: 0, out: [`PROMPT Your brief is ${out}; read it first. ${prompt}`] };
}

const line = (a) => {
  switch (a.kind) {
    case "ASK": return a.pr ? `ASK human ${a.why === "merge" ? "merge " : ""}PR#${a.pr} ${a.url}${a.why.startsWith("policy:") ? ` ${a.why}` : a.why === "unread" ? " policy: changed paths unreadable" : ""}${a.why !== "merge" && a.sha ? ` reply: ACCEPT ${a.sha}` : ""}`
      : a.human ? `ASK human #${a.n} ${a.url}` : `ASK ${a.url} ${a.title}`;
    case "STOP": case "NUDGE": return `${a.kind} ${a.agent} ${a.reason}`;
    case "MERGE": case "MERGED": return `${a.kind} PR#${a.pr} ${a.head.slice(0, 12)} verdict=${a.verdict} by=${a.by}`;
    case "RUN": return `RUN ${a.command}`;
    case "DECIDE": return a.ticket ? `DECIDE #${a.ticket} ${a.reason}` : `DECIDE ${a.about}: ${a.reason}`;
    case "SPAWN": return a.role === "verifier"
      ? `SPAWN verifier PR#${a.pr} #${a.ticket || "?"} head=${a.head.slice(0, 12)} brief: ${a.brief}`
      : `SPAWN worker #${a.ticket} team=${a.team} difficulty=${a.difficulty}${a.speculative ? " speculative" : ""} worktree=${a.worktree} brief: ${a.brief}`;
    case "BLOCKED": return `BLOCKED #${a.ticket} ${a.reason}`;
    default: return `WAIT ${a.command}`;
  }
};

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return argv.length ? 0 : 2; }
  if (argv[0] === "result") {
    const verdict = argv[1] || "";
    let arg = "", at = "";
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--at") at = argv[++i] || "";
      else if (argv[i].startsWith("--at=")) at = argv[i].slice(5);
      else if (!arg && !argv[i].startsWith("-")) arg = argv[i];
      else { console.error(`${USAGE}\nunknown argument ${plain(argv[i])}`); return 2; }
    }
    if (!["pass", "fail"].includes(verdict)) { console.error(`${USAGE}\nresult is pass or fail`); return 2; }
    if (!at) { console.error(`${USAGE}\nresult needs --at <sha>, the commit the RUN line named`); return 2; }
    const r = result(arg, verdict, at);
    if (r.err) { console.error(plain(r.err)); return r.code; }
    for (const l of r.out) console.log(plain(l));
    return r.code;
  }
  if (argv[0] === "brief") {
    const [role, target, ...rest] = argv.slice(1);
    if (!["worker", "verifier"].includes(role) || !target || rest.length > 1 || rest.some((a) => a.startsWith("-"))) { console.error(`${USAGE}\nbrief is worker <n> or verifier <pr>`); return 2; }
    const r = brief(role, target, rest[0] || "");
    if (r.err) { console.error(plain(r.err)); return r.code; }
    for (const l of r.out) console.log(plain(l));
    return r.code;
  }
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

module.exports = { next, result, brief, gateCommand, recordMessage, roleBlock, slotsOf, sliceTeams, FILL, WHEN, KEPT, OPTIONAL };
if (require.main === module) process.exitCode = main();
