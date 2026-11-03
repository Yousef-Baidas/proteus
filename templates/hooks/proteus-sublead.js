#!/usr/bin/env node
// Optional sub-leads (#344): a slice too large for one ticket handed to a lead of its own, a nested run.
//   node <hooks>/proteus-sublead.js start <ticket> [run] --budget <usd> [--minutes <m>] [--model <id>]
//   node <hooks>/proteus-sublead.js pr [run]
//   node <hooks>/proteus-sublead.js depth [run]
// A sub-run is named <run>.<ticket>: its run branch proteus/<run>.<ticket> is cut from proteus/<run>, and it has its
// own milestones, tickets, owned records and loop (proteus-cli.js next/drive with the sub-run named), under the same
// rules, hooks, verifiers and gates. The depth is the run's place in the tree: 1 for a run of its own, one more per
// sub-run; it is the larger of the count of .<digits> suffixes on the name and the depth recorded in
// <common>/proteus/subleads/<run>.json (agent-writable, so it can only raise the name's count). At most three levels:
// a run at depth 3 gets no sub-lead; start refuses with exit 1 and next prints no sub-lead command.
// start, from the lead's shell, run in the background: the checkout <root>/.worktrees/<sub-run> on the new branch,
// the branch pushed to origin, the depth and caps recorded, the main checkout's .claude/settings.local.json copied in
// (its hooks name the main checkout's hooks dir by absolute path), then one headless Claude Code session there:
// `claude -p --output-format stream-json --verbose --max-budget-usd <usd>`, with --model when given, never in a
// mode more permissive than the lead's: the lead guard stores the lead's mode as this shell call arrives, where
// neither agents nor a sandboxed shell can write (lib.saveLeadMode). Lead on bypassPermissions with the repo's
// sandbox profile (install.js --sandbox): that profile and bypassPermissions; lead on auto: auto; any other mode, or
// none recorded for this checkout in the last 5 minutes: refused, exit 1 (permArgs). Never a bare mode, a credential or a credential file: the session inherits this process's
// environment, the prompt goes in on stdin. Its runtime is bounded by --minutes (default 240, at most 1440;
// PROTEUS_SUBLEAD_TIMEOUT_MS overrides, for tests): past it, or on SIGINT/SIGTERM to this process, the session and all
// it started are killed. The CLI checks the budget between turns, so a session can overshoot it by one turn.
// A headless session fires no SubagentStop and the lead guard stamps no beat for it, so this process writes the beat
// proteus-watchdog.js reads, <common>/proteus-lead/beats/sublead-<sub-run>.json (type proteus-sublead): stamped as the
// session streams output, at most every 30 s, removed when it ends. A STALL for it comes back from next as NUDGE (no
// message reaches a headless session: wait) or STOP (stop this background shell, then --forget the agent). Where the
// lead's shell cannot write proteus-lead (a sandbox profile, #236) no beat is written and --minutes is the bound.
// Prints `SUBLEAD <sub-run> started depth=<d> branch=<branch> checkout=<dir> budget=$<usd> minutes=<m>`, then
// `SUBLEAD <sub-run> done $<cost>: <the session's last line>` (exit 0) or `SUBLEAD <sub-run> failed: <why>` (exit 1).
// pr, the sub-lead's step 8 in place of the PR to main, from its checkout: the sub-run's result as one PR into the
// parent run, from proteus-work/<parent>/<ticket>, so it is verified, owned-checked and merged like a worker's PR:
// origin's tip of the sub-run, plus one commit, when needed, that puts .proteus/owned back as the parent had it (the
// sub-run's own records stay on its branch; CI refuses records outside a record PR), force-pushed to that branch; the
// body's Closes, Owned: and Tier: lines from the parent's record and the ticket. Prints `PR#<n> <url>`.
// depth prints `depth <d> of 3` and exits 0, or 1 at the limit.
// Exit 0 done; 1 refused or failed (reason on stdout or stderr); 2 usage or no run.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
const { spawn } = require("child_process");
const { originOf } = require(path.join(__dirname, "proteus-merge.js"));

const USAGE = "usage: node proteus-sublead.js start <ticket> [run] --budget <usd> [--minutes <m>] [--model <id>] | pr [run] | depth [run]";
const MAX_DEPTH = 3;
const RUN = /^[A-Za-z0-9][\w.-]*$/;
const SUB = /^(.+)\.(\d+)$/;
const DEFAULT_MINUTES = 240, MAX_MINUTES = 1440;
const BEAT_EVERY = 30e3;
const KILL_GRACE_MS = 2000;
const MODEL = /^[\w.[\]:-]+$/;
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");
const last = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const subName = (run, n) => `${run}.${n}`;
const stateFile = (common, run) => path.join(lib.stateDir(common), "subleads", `${run}.json`);
const readState = (common, run) => (common ? lib.readUntrustedJSON(stateFile(common, run), null) : null);
// run's depth: 1 for a run of its own, one more per sub-run level; the record can only raise the name's count
function depthOf(common, run) {
  let byName = 1;
  for (let r = String(run); SUB.test(r); r = SUB.exec(r)[1]) byName++;
  const rec = readState(common, run);
  return Math.max(byName, rec && Number.isInteger(rec.depth) && rec.depth > 0 ? rec.depth : 1);
}
// why run may not hand a ticket to a sub-lead; "" when it may
function refusal(common, run) {
  const d = depthOf(common, run);
  return d >= MAX_DEPTH ? `run ${run} is at depth ${d}, the limit of ${MAX_DEPTH} (orchestrator, sub-lead, sub-sub-lead): split the ticket instead` : "";
}
// the command next's DECIDE #<n> slice line names; "" at the depth limit
const startCmd = (common, run, n) => (refusal(common, run) ? "" : `node ${path.join(__dirname, "proteus-sublead.js")} start ${n} ${run} --budget <usd>`);

// the project and the run: the named one, else this checkout's run branch, else the first open run branch
function where(arg) {
  const root = path.resolve(lib.projectRoot());
  const common = lib.gitCommonDir(root);
  if (!common) return { code: 2, err: "not in a git repo" };
  const own = lib.branchOf(root);
  const mine = own && own.startsWith(lib.CURRENT.branch) ? own : "";
  const run = lib.runName(arg || mine || lib.runBranches(common)[0] || "");
  if (!run) return { code: 2, err: `no run named and no open ${lib.CURRENT.branch}<run> branch` };
  if (!RUN.test(run)) return { code: 2, err: `run ${plain(run)}: not a run name (a letter or digit, then letters, digits, _ . -)` };
  return { root, common, run };
}

// d made if missing, then checked: a real dir, never a link an agent planted
function realDir(d) {
  try { fs.mkdirSync(d, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a real directory`);
}
function saveState(common, run, rec) {
  realDir(lib.stateDir(common));
  realDir(path.dirname(stateFile(common, run)));
  const file = stateFile(common, run);
  // agent-writable: unlink what is there (a link goes, never its target), then create, never through a link
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", { flag: "wx" });
}

// the main checkout's lead settings into the sub-run's checkout: the hooks they name are the main checkout's, by
// absolute path, so the session runs the same ones. Nothing to copy under the plugin, whose hooks are global
function copySettings(main, checkout) {
  let text;
  try { text = fs.readFileSync(path.join(main, ".claude", "settings.local.json"), "utf8"); } catch { return; }
  const dst = path.join(checkout, ".claude", "settings.local.json");
  realDir(path.dirname(dst));
  fs.rmSync(dst, { force: true });
  fs.writeFileSync(dst, text, { flag: "wx" });
}

// what the sub-lead is told; its rules come from the skill the session starts with
function prompt({ sub, run, n, depth, budget, minutes }) {
  const me = `node ${path.join(__dirname, "proteus-sublead.js")}`;
  return [
    `You are the lead of Proteus run ${sub}, a sub-lead under run ${run} (depth ${depth} of ${MAX_DEPTH}). Work as the proteus skill's lead, on run ${sub} only: name ${sub} as the run in every proteus-cli.js call.`,
    `Your goal is ticket #${n} of run ${run}; read it with gh issue view ${n}. Plan it as your own run: milestones ${sub}/<m>, tickets, contracts, and the same loop, rules, hooks, verifiers and gates. Every ticket's Owned: paths stay inside #${n}'s Owned: line; CI checks your result against it.`,
    `Your run branch is proteus/${sub}, cut from proteus/${run}; this checkout is on it. Never push to proteus/${run} or main, and never edit, close or comment on #${n}.`,
    `At step 8, after the close passes, open no PR to main: run ${me} pr ${sub}. It opens the one PR from your run into proteus/${run}, which the parent run verifies and merges.`,
    `Caps: $${budget} of spend, ${minutes} minutes. A question only the human can answer goes to the tracker as usual; then end.`,
    `End with one final line: DONE ${sub} PR#<n>, NEEDS ${sub} #<issue>, or RED ${sub} <why>.`,
  ].join("\n\n") + "\n";
}

// the beat proteus-watchdog.js reads; every write best effort (a sandboxed shell cannot write proteus-lead)
function beater(common, agent, rec) {
  const file = path.join(lib.beatsDir(common), `${agent.replace(/[^\w.-]/g, "_")}.json`);
  let at = 0;
  const stamp = (force = false) => {
    const now = Date.now();
    if (!force && now - at < BEAT_EVERY) return;
    at = now;
    try { lib.leadJSON(common, file, { ...rec, last: new Date(now).toISOString() }); } catch {}
  };
  const drop = () => { try { lib.leadRemove(common, file); } catch {} };
  return { stamp, drop };
}

// the session: stream-json on stdout, each line a beat; resolves { error, status, result } where result is the
// stream's last `result` object. A win32 .cmd shim is retried through cmd.exe as lib.spawnArgv does
function session(cmd, args, input, o, retry = false) {
  return new Promise((resolve) => {
    let [file, argv, extra] = [cmd, args, {}];
    if (retry) [file, argv, extra] = lib.cmdShimCall(cmd, args);
    const c = spawn(file, argv, { cwd: o.cwd, env: o.env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "ignore"], ...extra });
    let buf = "", result = null, error = null, status = null, finished = false, grace;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(grace);
      for (const s of ["SIGINT", "SIGTERM"]) process.removeListener(s, onSignal);
      resolve({ error, status, result });
    };
    const stop = (code) => { if (error) return; error = { code }; lib.killTree(c); grace = setTimeout(finish, KILL_GRACE_MS); };
    const timer = setTimeout(() => stop("ETIMEDOUT"), o.timeout);
    const onSignal = () => stop("ESTOPPED");
    for (const s of ["SIGINT", "SIGTERM"]) process.on(s, onSignal);
    c.on("error", (e) => {
      if (!retry && process.platform === "win32" && ["ENOENT", "EINVAL"].includes(e.code)) {
        finished = true; clearTimeout(timer);
        for (const s of ["SIGINT", "SIGTERM"]) process.removeListener(s, onSignal);
        resolve(session(cmd, args, input, o, true));
        return;
      }
      error = error || e; finish();
    });
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => {
      o.beat();
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      if (buf.length > 1 << 20) buf = ""; // one line past 1 MB is no result line
      for (const l of lines) { const j = parse(l.trim()); if (j && j.type === "result") result = j; }
    });
    c.stdin.on("error", () => {});
    c.stdin.end(input);
    c.on("exit", (n) => { status = n; grace = grace || setTimeout(finish, KILL_GRACE_MS); });
    c.on("close", (n) => {
      if (status === null) status = n;
      const j = parse(buf.trim());
      if (j && j.type === "result") result = j;
      finish();
    });
  });
}

// the sub-lead's permission flags, never more permissive than the lead's mode as the lead guard recorded it; a
// string (the refusal) when that mode has no headless equivalent: a session started with -p answers no prompt
function permArgs(mode, profile) {
  if (mode === "bypassPermissions" && profile) return ["--settings", profile, "--permission-mode", "bypassPermissions"];
  if (mode === "auto") return ["--permission-mode", "auto"];
  if (mode === "bypassPermissions") return "the lead runs bypassPermissions without the repo's sandbox profile (install.js --sandbox); a sub-lead runs only under it";
  return `the lead's permission mode is ${mode ? plain(mode) : "unknown"}; a headless sub-lead cannot answer permission prompts, so it runs only when the lead runs auto, or bypassPermissions with the sandbox profile. Start it from the lead's own shell`;
}

async function start(o) {
  const w = where(o.run);
  if (w.err) return w;
  const { root, common, run } = w;
  const why = refusal(common, run);
  if (why) return { code: 1, out: [`SUBLEAD refused: ${why}`] };
  const modeArgs = permArgs(lib.leadModeSeen(common, process.cwd()), lib.profileFile(common));
  if (typeof modeArgs === "string") return { code: 1, out: [`SUBLEAD refused: ${modeArgs}`] };
  const sub = subName(run, o.ticket), branch = `${lib.CURRENT.branch}${sub}`, parent = `${lib.CURRENT.branch}${run}`;
  const depth = depthOf(common, run) + 1;
  const main = lib.mainRoot(common) || root;
  const checkout = path.join(lib.worktreesDir(main), sub);
  const origin = originOf(common);
  const fail = (msg) => ({ code: 1, out: [`SUBLEAD ${sub} failed: ${msg}`] });
  if (!fs.existsSync(checkout)) {
    const have = lib.gitTry(common, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]).out;
    const base = have ? "" : origin.tip(parent) || lib.gitTry(common, ["rev-parse", "--verify", "-q", `refs/heads/${parent}^{commit}`]).out;
    if (!have && !base) return fail(`no ${parent} to cut ${branch} from`);
    const add = lib.gitTry(common, ["worktree", "add", "-q", ...(have ? [checkout, branch] : ["-b", branch, checkout, base])], { timeout: 120000 });
    if (!add.ok) return fail(last(add.err || add.out) || "git worktree add failed");
  } else if (lib.branchOf(checkout) !== branch) return fail(`${checkout} exists and is not a checkout on ${branch}`);
  if (!origin.ls(branch)) {
    const push = lib.gitTry(common, ["push", "-q", origin.url, `refs/heads/${branch}:refs/heads/${branch}`], { user: true, timeout: 120000 });
    if (!push.ok) return fail(`push ${branch} failed (${last(push.err) || "no origin"})`);
  }
  const started = new Date().toISOString();
  try {
    saveState(common, sub, { run: sub, parent: run, ticket: o.ticket, depth, branch, checkout, budget: o.budget, minutes: o.minutes, started });
    copySettings(main, checkout);
  } catch (e) { return fail(e.message); }

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--max-budget-usd", String(o.budget)];
  if (o.model) args.push("--model", o.model);
  args.push(...modeArgs);
  const agent = `sublead-${sub}`;
  const beat = beater(common, agent, { agent, type: "proteus-sublead", spawn: started, session: "", cwd: checkout, first: started });
  console.log(`SUBLEAD ${sub} started depth=${depth} branch=${branch} checkout=${checkout} budget=$${o.budget} minutes=${o.minutes}`);
  beat.stamp(true);
  const env = Number(process.env.PROTEUS_SUBLEAD_TIMEOUT_MS) > 0 ? Number(process.env.PROTEUS_SUBLEAD_TIMEOUT_MS) : o.minutes * 60e3;
  const r = await session("claude", args, prompt({ sub, run, n: o.ticket, depth, budget: o.budget, minutes: o.minutes }),
    { cwd: checkout, env: process.env, timeout: env, beat: () => beat.stamp() });
  beat.drop();
  const j = r.result;
  const cost = j ? Number(j.total_cost_usd ?? j.cost_usd) : NaN;
  const said = plain(last(j && typeof j.result === "string" ? j.result : ""));
  const ok = !r.error && r.status === 0 && j && j.is_error !== true && !String(j.subtype || "").startsWith("error");
  try { saveState(common, sub, { ...readState(common, sub), ended: new Date().toISOString(), ok: !!ok, costUsd: Number.isFinite(cost) ? cost : null }); } catch {}
  if (ok) return { code: 0, out: [`SUBLEAD ${sub} done $${Number.isFinite(cost) ? cost.toFixed(2) : "?"}: ${said.slice(0, 300)}`] };
  const reason = r.error ? (r.error.code === "ETIMEDOUT" ? `past its ${o.minutes} minutes, stopped` : r.error.code === "ESTOPPED" ? "stopped" : `could not run claude: ${r.error.code || r.error.message}`)
    : !j ? `claude exited ${r.status} with no result` : `${plain(j.subtype || "error")}${said ? `: ${said.slice(0, 300)}` : ""}`;
  return { code: 1, out: [`SUBLEAD ${sub} failed: ${reason}`] };
}

// a tree's entries from ls-tree -z, each { type, obj, name, line }; null when spec names no tree
function treeOf(common, spec) {
  const r = lib.gitTry(common, ["ls-tree", "-z", spec]);
  if (!r.ok) return null;
  return r.out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t"), [, type, obj] = line.slice(0, tab).split(" ");
    return { type, obj, name: line.slice(tab + 1), line };
  });
}
// tree (a tree-ish, "" for none) with the entry at parts set to the tree sub, or removed when sub is "", as git's
// objects alone (ls-tree, mktree); an emptied dir goes too. The new tree's sha, "" when empty, null on a failure
function setPath(common, tree, parts, sub) {
  const list = tree ? treeOf(common, tree) : [];
  if (!list) return null;
  const cur = list.find((e) => e.name === parts[0]);
  if (cur && parts.length > 1 && cur.type !== "tree") return null;
  const inner = parts.length > 1 ? setPath(common, cur ? cur.obj : "", parts.slice(1), sub) : sub;
  if (inner === null) return null;
  const lines = list.filter((e) => e !== cur).map((e) => e.line);
  if (inner) lines.push(`040000 tree ${inner}\t${parts[0]}`);
  if (!lines.length) return "";
  return lib.gitIn(common, ["mktree", "-z"], 30000, { input: lines.map((l) => `${l}\0`).join("") }) || null;
}

function pr(arg) {
  const w = where(arg);
  if (w.err) return w;
  const { root, common, run } = w;
  const m = SUB.exec(run);
  if (!m) return { code: 2, err: `run ${run} is not a sub-run (<parent run>.<ticket>)` };
  const [, parent, n] = m;
  const fail = (msg) => ({ code: 1, err: `pr ${run}: ${msg}` });
  const origin = originOf(common), B = lib.CURRENT.branch;
  const tip = origin.tip(`${B}${run}`), base = origin.tip(`${B}${parent}`);
  if (!tip) return fail(`cannot fetch origin/${B}${run}`);
  if (!base) return fail(`cannot fetch origin/${B}${parent}`);
  const mb = lib.gitTry(common, ["merge-base", base, tip]).out;
  if (!mb) return fail(`${B}${run} shares no history with ${B}${parent}`);
  const rec = lib.gitTry(common, ["cat-file", "blob", `${base}:${lib.OWNED_RECORDS}/${n}`]);
  if (!rec.ok) return fail(`${B}${parent} has no ${lib.OWNED_RECORDS}/${n}, the record CI checks the result against`);
  const owned = rec.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  // the records as the parent had them where the sub-run began
  const had = lib.gitTry(common, ["rev-parse", "--verify", "-q", `${mb}:${lib.OWNED_RECORDS}`]).out;
  const tipTree = lib.gitTry(common, ["rev-parse", `${tip}^{tree}`]).out;
  const tree = setPath(common, tipTree, lib.OWNED_RECORDS.split("/"), had);
  if (!tree) return fail(`cannot rebuild ${lib.OWNED_RECORDS} in ${B}${run}'s tree`);
  let head = tip;
  if (tree !== tipTree) {
    const c = lib.gitTry(common, ["commit-tree", tree, "-p", tip, "-m", "chore(proteus): keep the parent run's owned records"], { user: true, timeout: 60000 });
    if (!c.ok) return fail(`git commit-tree failed (${last(c.err)})`);
    head = c.out;
  }
  const work = `${lib.CURRENT.work}${parent}/${n}`;
  const push = lib.gitTry(common, ["push", "-q", origin.url, `+${head}:refs/heads/${work}`], { user: true, timeout: 120000 });
  if (!push.ok) return fail(`push ${work} failed (${last(push.err)})`);
  const open = parse(lib.gh(["pr", "list", "--head", work, "--base", `${B}${parent}`, "--state", "open", "--json", "number,url"], root, 30000));
  if (Array.isArray(open) && open.length) return { code: 0, out: [`PR#${open[0].number} ${open[0].url}`] };
  const issue = parse(lib.gh(["issue", "view", n, "--json", "title,body"], root, 30000)) || {};
  const tierLine = /^Tier:[ \t]*(\S+)/im.exec(String(issue.body || ""));
  const tier = tierLine ? tierLine[1].toLowerCase() : "standard";
  const body = [`Closes #${n}`, `Owned: ${owned.join(" ")}`, `Tier: ${tier}`, "", `The result of sub-lead run ${run} (branch ${B}${run}), one PR into ${B}${parent}.`].join("\n");
  const title = plain(issue.title || `#${n}: sub-lead run ${run}`);
  const made = lib.ghTry(["pr", "create", "--base", `${B}${parent}`, "--head", work, "--title", title, "--body", body], root, 60000);
  const num = made.ok ? +(/\/pull\/(\d+)\s*$/.exec(made.out) || [0, 0])[1] : 0;
  if (!num) return fail(`gh pr create failed (${last(made.err || made.out)})`);
  try { saveState(common, run, { ...readState(common, run), pr: num }); } catch {}
  return { code: 0, out: [`PR#${num} ${last(made.out)}`] };
}

function parseStart(argv) {
  const o = { ticket: 0, run: "", budget: NaN, minutes: DEFAULT_MINUTES, model: "" };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--budget") o.budget = Number(val());
    else if (a === "--minutes") o.minutes = Number(val());
    else if (a === "--model") o.model = val();
    else if (a.startsWith("-")) throw new Error(`unknown argument ${a}`);
    else pos.push(a);
  }
  if (pos.length < 1 || pos.length > 2 || !/^\d+$/.test(pos[0]) || !(+pos[0] > 0)) throw new Error("start needs a ticket number, then the run if not the open one");
  o.ticket = +pos[0];
  o.run = pos[1] || "";
  if (!(o.budget > 0) || !Number.isFinite(o.budget)) throw new Error("--budget is required and must be a positive number of dollars");
  if (!(o.minutes > 0) || o.minutes > MAX_MINUTES) throw new Error(`--minutes must be more than 0 and at most ${MAX_MINUTES}`);
  if (o.model && !MODEL.test(o.model)) throw new Error("--model is not a model id");
  return o;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return argv.length ? 0 : 2; }
  const [cmd, ...rest] = argv;
  let r;
  if (cmd === "start") {
    let o;
    try { o = parseStart(rest); } catch (e) { console.error(`${USAGE}\n${plain(e.message)}`); return 2; }
    r = await start(o);
  } else if (cmd === "pr" || cmd === "depth") {
    if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) { console.error(USAGE); return 2; }
    if (cmd === "pr") r = pr(rest[0] || "");
    else {
      const w = where(rest[0] || "");
      if (w.err) r = w;
      else { const d = depthOf(w.common, w.run); r = { code: d >= MAX_DEPTH ? 1 : 0, out: [`depth ${d} of ${MAX_DEPTH}`] }; }
    }
  } else { console.error(`${USAGE}\nunknown command ${plain(cmd)}`); return 2; }
  for (const l of r.out || []) console.log(plain(l));
  if (r.err) console.error(plain(r.err));
  return r.code;
}

module.exports = { depthOf, refusal, permArgs, startCmd, subName, prompt, MAX_DEPTH };
if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(plain(e && e.message)); process.exitCode = 1; });
