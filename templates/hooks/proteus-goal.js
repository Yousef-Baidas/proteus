#!/usr/bin/env node
// The goal loop's round (#196, operations.md Goal loop): runs the frozen scorecard once and decides the next step.
//   node <hooks>/proteus-goal.js round --run <run> --scorecard <path> --goal "<name> <min|max> <target>" [--budget <n>]
//        [--worktree <wt>]
// Refuses (exit 2) unless lib.sandboxState is on: the loop runs only under the sandbox. The scorecard (a path relative
// to the repo root, frozen in AGENTS.md as `scorecard: <path>`) runs with cwd .worktrees/_run, which
// proteus-run-tree.js has set to proteus/<run>'s tip; under AGENTS.md `isolation: container` it runs instead through
// `proteus-container.js check --worktree <wt> --ref <_run's HEAD>`, <wt> a linked worktree whose branch reaches that
// commit, and SCORE is read from the check log. The past rounds are the run log's `goal-round: <k> score <v>` lines
// (the issue titled `Run: <run>`, read with gh). Round k is the highest logged plus one.
// Prints `goal-round: <k> score <v>` for the lead to append to the run log when the scorecard gave a score, then one
// decision line, last: `STOP budget` (k over the budget, the scorecard not run), `STOP error <reason>`,
// `STOP target <v>`, `STOP falling <prev> -> <v>` (worse than round k-1, by the goal's direction), else
// `NEXT <k> score <v>`. Writes nothing. Exit 0 on NEXT, 1 on STOP, 2 on usage or the sandbox refusal.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const HELP = `usage: node proteus-goal.js round --run <run> --scorecard <path> --goal "<name> <min|max> <target>" [--budget <n>] [--worktree <wt>]
One goal-loop round: runs the frozen scorecard in .worktrees/_run (proteus-run-tree.js first) and decides.
  --run <run>         the run; its log is the issue titled "Run: <run>", read for "goal-round: <k> score <v>" lines
  --scorecard <path>  the scorecard, relative to the repo root (AGENTS.md "scorecard: <path>"); its last stdout
                      line is "SCORE <number>" and it exits 0
  --goal "<name> <min|max> <target>"  min: lower is better; max: higher is better
  --budget <n>        rounds, 1..50, default 10
  --worktree <wt>     isolation: container only: a linked worktree whose branch reaches _run's HEAD, for
                      proteus-container.js check (git worktree add .worktrees/_goal proteus/<run>)
Prints "goal-round: <k> score <v>" for the run log when the scorecard gave a score, then one decision line:
  STOP target <v> | STOP budget | STOP falling <prev> -> <v> | STOP error <reason> | NEXT <k> score <v>
Runs only with the sandbox on. Writes nothing. Exit 0 on NEXT, 1 on STOP, 2 on usage or the sandbox refusal.`;

const NUM = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const ROUND = /^goal-round: (\d+) score (\S+)\s*$/gm;
const BUDGET_DEFAULT = 10, BUDGET_MAX = 50;
// a scorecard gets an hour on the host; the container check has its own --timeout
const RUN_MS = 3600000;

// { run, scorecard, goal: { name, dir, target }, budget, worktree } or { error }
function parseArgs(args) {
  if (args[0] !== "round") return { error: "the subcommand is round" };
  const o = { budget: BUDGET_DEFAULT };
  for (let i = 1; i < args.length; i++) {
    const k = args[i], v = args[i + 1];
    if (!["--run", "--scorecard", "--goal", "--budget", "--worktree"].includes(k)) return { error: `unknown argument ${k}` };
    if (v === undefined || v.startsWith("--")) return { error: `${k} needs a value` };
    o[k.slice(2)] = v;
    i++;
  }
  if (!o.run || !o.scorecard || !o.goal) return { error: "--run, --scorecard and --goal are required" };
  const g = String(o.goal).trim().split(/\s+/);
  if (g.length !== 3 || !["min", "max"].includes(g[1]) || !NUM.test(g[2])) return { error: `--goal "${o.goal}" is not "<name> <min|max> <target>"` };
  o.goal = { name: g[0], dir: g[1], target: +g[2] };
  const b = String(o.budget);
  if (!/^\d+$/.test(b) || +b < 1 || +b > BUDGET_MAX) return { error: `--budget ${b} is not a round count from 1 to ${BUDGET_MAX}` };
  o.budget = +b;
  if (path.isAbsolute(o.scorecard) || o.scorecard.split(/[\\/]/).includes("..")) return { error: `--scorecard ${o.scorecard} is not a path inside the repo` };
  return o;
}

// [{ k, v }] from the run log's body and comments, in order
function parseRounds(text) {
  const out = [];
  for (const m of String(text).matchAll(ROUND)) if (NUM.test(m[2])) out.push({ k: +m[1], v: +m[2] });
  return out;
}

// the text of the run log issue titled "Run: <run>", or { error }
function runLog(root, run) {
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const list = parse(lib.gh(["issue", "list", "--label", lib.CURRENT.log, "--state", "all", "--json", "number,title", "--limit", "100"], root, 15000));
  if (!Array.isArray(list)) return { error: "run log unreachable (gh issue list failed)" };
  const issue = list.find((i) => String(i.title).trim() === `Run: ${run}`);
  if (!issue) return { error: `no run log titled "Run: ${run}"` };
  const view = parse(lib.gh(["issue", "view", String(issue.number), "--json", "body,comments"], root, 15000));
  if (!view) return { error: `run log #${issue.number} unreadable` };
  return { text: [view.body || "", ...(view.comments || []).map((c) => (c && c.body) || "")].join("\n") };
}

// the argv that runs the scorecard: node for JavaScript, bash for a shell script, else the file itself
function scoreArgv(rel) {
  const p = rel.split(/[\\/]/).join("/");
  if (/\.[cm]?js$/.test(p)) return ["node", p];
  if (/\.sh$/.test(p)) return ["bash", p];
  return [p];
}

// the last "SCORE <n>" as a number, or { error }; host: it must be the last stdout line
function scoreOf(text, lastOnly) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cand = lastOnly ? lines.slice(-1) : lines.filter((l) => /^SCORE\b/.test(l)).slice(-1);
  const m = cand.length ? /^SCORE (\S+)$/.exec(cand[0]) : null;
  return m && NUM.test(m[1]) ? { v: +m[1] } : { error: "the scorecard printed no SCORE line" };
}

// runs the scorecard on _run's HEAD: { v } or { error }
function score(root, o) {
  const run = path.join(lib.worktreesDir(root), "_run");
  let sha = "";
  try { sha = fs.readFileSync(path.join(run, ".git", "HEAD"), "utf8").trim(); } catch {}
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { error: "no commit in .worktrees/_run; run proteus-run-tree.js on proteus/" + o.run + "'s tip first" };
  if (!fs.existsSync(path.join(run, o.scorecard))) return { error: `${o.scorecard} is not in .worktrees/_run` };
  const argv = scoreArgv(o.scorecard);
  if ((lib.agentsLine(root, "isolation") || "").trim() === "container") {
    if (!o.worktree) return { error: "isolation: container needs --worktree <wt> for proteus-container.js check" };
    const r = lib.spawnArgv(process.execPath, [path.join(__dirname, "proteus-container.js"), "check", "--worktree", o.worktree, "--ref", sha, "--", ...argv], { cwd: root, maxBuffer: 1 << 24 });
    const lines = String(r.stdout || "").split(/\r?\n/);
    const last = lines.filter(Boolean).pop() || "";
    if (r.status !== 0) return { error: `container check failed: ${last || String(r.stderr || "").trim().split(/\r?\n/).pop() || `exit ${r.status}`}` };
    const at = lines.map((l) => /^check: log at (.+)$/.exec(l)).filter(Boolean).pop();
    let log = "";
    try { log = at ? fs.readFileSync(at[1], "utf8") : ""; } catch {}
    return log ? scoreOf(log, false) : { error: "the container check left no readable log" };
  }
  const cmd = argv[0] === "node" ? process.execPath : argv[0];
  const r = lib.spawnArgv(cmd, argv.slice(1), { cwd: run, timeout: RUN_MS, maxBuffer: 1 << 24 });
  if (r.error) return { error: `the scorecard did not run: ${r.error.code || r.error.message}` };
  if (r.status !== 0) return { error: `the scorecard exited ${r.status === null ? r.signal : r.status}` };
  return scoreOf(r.stdout, true);
}

const better = (dir, a, b) => (dir === "min" ? a < b : a > b);

// one round: { code, out: [lines], err }. deps.root and deps.sandbox (lib.sandboxState's options) are for tests
function main(args, deps = {}) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: [HELP] };
  const o = parseArgs(args);
  if (o.error) return { code: 2, err: `${HELP}\n${o.error}` };
  const common = deps.root ? null : lib.repoCommon();
  const root = deps.root || (common && lib.mainRoot(common));
  if (!root) return { code: 2, err: "not in a project checkout" };
  const sb = lib.sandboxState(root, deps.sandbox || {});
  if (sb !== "on") return { code: 2, err: `proteus-goal: refused: the goal loop runs only under the sandbox, and it is ${sb} (${lib.sandboxLaunch(root)})` };
  const log = runLog(root, o.run);
  if (log.error) return { code: 1, out: [`STOP error ${log.error}`] };
  const rounds = parseRounds(log.text);
  const k = Math.max(0, ...rounds.map((r) => r.k)) + 1;
  if (k > o.budget) return { code: 1, out: ["STOP budget"] };
  const s = score(root, o);
  if (s.error) return { code: 1, out: [`STOP error ${s.error}`] };
  const v = s.v, line = `goal-round: ${k} score ${v}`;
  const prev = rounds.filter((r) => r.k < k).sort((a, b) => a.k - b.k).pop();
  const { dir, target } = o.goal;
  if (v === target || better(dir, v, target)) return { code: 1, out: [line, `STOP target ${v}`] };
  if (prev && better(dir, prev.v, v)) return { code: 1, out: [line, `STOP falling ${prev.v} -> ${v}`] };
  return { code: 0, out: [line, `NEXT ${k} score ${v}`] };
}

if (require.main === module) {
  let r;
  try { r = main(process.argv.slice(2)); } catch (e) { r = { code: 1, out: [`STOP error ${e.message}`] }; }
  if (r.out) console.log(r.out.join("\n"));
  if (r.err) console.error(r.err);
  process.exitCode = r.code;
}
module.exports = { main, parseArgs, parseRounds, scoreOf };
