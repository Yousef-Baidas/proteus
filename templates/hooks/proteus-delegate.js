#!/usr/bin/env node
// One bounded headless agent call, so a higher-level agent can hand a small job to a cheaper model:
//   node <hooks>/proteus-delegate.js --tier <rung> --budget <usd> --prompt-file <file> [--cwd <dir>]
//                                    [--tools <comma list>] [--schema <json file>] [--run <run>]
// Prints one JSON line on stdout: { ok, result, costUsd, model, tier, depth }. Exit 0 on success, 1 on a failed call,
// a spent budget, a refused depth or a harness with no delegation, 2 on usage.
// --tier is a rung of the harness's model ladder (proteus-lib.js modelPolicy); --budget is required, a positive number
// of dollars, handed to the CLI as its spend cap. The harness adapter builds the command (delegate in
// proteus-harness-<name>.js); it never uses a bare mode or a permission bypass, so hooks and deny rules still apply.
// The prompt goes in on stdin, never argv. Tools default to Read, Grep and Glob; the Agent tool is never allowed.
// The child's environment is inherited, plus PROTEUS_DELEGATE_DEPTH one higher than here; at depth 3 this refuses.
// Only the child's stdout is parsed (its stderr can carry warnings and is dropped); output that does not parse is
// ok:false, and so is a child still running after 10 minutes (PROTEUS_DELEGATE_TIMEOUT_MS overrides, for tests): the
// child and everything it started are killed, and output over 64 MB is cut the same way.
// The child's text is data: control characters are stripped from result (its newlines and tabs kept) and from model.
// --run <run> appends { time, tier, model, costUsd, ok, depth } as one line to delegate-ledger.jsonl in that run's
// scratch dir (proteus-scratch.js --path <run>); with no run it resolves to, nothing is written.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
const { spawn } = require("child_process");
const harness = require(path.join(__dirname, "proteus-harness.js"));

const USAGE = "usage: node proteus-delegate.js --tier <rung> --budget <usd> --prompt-file <file> [--cwd <dir>] [--tools <comma list>] [--schema <json file>] [--run <run>]";
const MAX_DEPTH = 3;
const TIMEOUT_MS = Number(process.env.PROTEUS_DELEGATE_TIMEOUT_MS) > 0 ? Number(process.env.PROTEUS_DELEGATE_TIMEOUT_MS) : 10 * 60e3;
const MAX_OUT = 64 << 20;
const KILL_GRACE_MS = 2000;
const DEFAULT_TOOLS = ["Read", "Grep", "Glob"];
const KEY = /^\w[\w.-]*$/;
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");
// the child's answer keeps its line breaks and tabs; every other control character goes
const plainText = (s) => String(s).replace(/(?![\n\t])\p{Cc}/gu, "");

const usage = (why) => { console.error(`${USAGE}${why ? `\n${plain(why)}` : ""}`); process.exit(2); };
const answer = (o, code) => { console.log(JSON.stringify(o)); process.exit(code); };

function parse(argv) {
  const o = {};
  const flags = { "--tier": "tier", "--budget": "budget", "--prompt-file": "promptFile", "--cwd": "cwd", "--tools": "tools", "--schema": "schema", "--run": "run" };
  for (let i = 0; i < argv.length; i++) {
    const k = flags[argv[i]];
    if (!k) usage(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length) usage(`${argv[i]} needs a value`);
    o[k] = argv[++i];
  }
  return o;
}

// the tools the child may use: the list given (default Read, Grep, Glob) without the Agent tool in any form
function toolList(spec) {
  const list = String(spec || "").split(",").map((t) => t.trim()).filter((t) => t && !/^(agent|task)\b/i.test(t));
  return list.length ? list : DEFAULT_TOOLS;
}

// the run's scratch dir as proteus-scratch.js --path hands it out; "" when there is no such run or repo
function scratchFor(run, cwd) {
  if (!run || !KEY.test(run)) return "";
  try {
    const common = lib.gitCommonDir(path.resolve(cwd));
    return common ? path.join(lib.scratchDir(common), run) : "";
  } catch { return ""; }
}
function ledger(run, cwd, row) {
  const dir = scratchFor(run, cwd);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "delegate-ledger.jsonl"), JSON.stringify({ time: new Date().toISOString(), ...row }) + "\n");
  } catch {}
}

// The call: the prompt on stdin, stdout collected up to the cap, stderr dropped. The child leads its own process group
// (a job tree on win32), and a timeout or an over-cap output kills the whole tree, so nothing it started keeps running
// and spending. A win32 .cmd shim, which spawn cannot start directly, is retried through cmd.exe as spawnArgv does.
// Resolves { error, status, stdout }; error.code is ETIMEDOUT, EMAXBUF or the spawn's own.
function call(spec, input, cwd, env, retry = false) {
  return new Promise((resolve) => {
    let [cmd, args, extra] = [spec.cmd, spec.args, {}];
    if (retry) [cmd, args, extra] = lib.cmdShimCall(spec.cmd, spec.args);
    const c = spawn(cmd, args, { cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "ignore"], ...extra });
    let stdout = "", size = 0, error = null, status = null, finished = false, grace;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(grace); resolve({ error, status, stdout }); };
    const stop = (code) => { if (error) return; error = { code }; lib.killTree(c); grace = setTimeout(finish, KILL_GRACE_MS); };
    const timer = setTimeout(() => stop("ETIMEDOUT"), TIMEOUT_MS);
    c.on("error", (e) => {
      if (!retry && process.platform === "win32" && ["ENOENT", "EINVAL"].includes(e.code)) { finished = true; clearTimeout(timer); resolve(call(spec, input, cwd, env, true)); return; }
      error = error || e; finish();
    });
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => { size += Buffer.byteLength(d); if (size > MAX_OUT) stop("EMAXBUF"); else if (!error) stdout += d; });
    c.stdin.on("error", () => {});
    c.stdin.end(input);
    c.on("exit", (n) => { status = n; grace = grace || setTimeout(finish, KILL_GRACE_MS); });
    c.on("close", (n) => { if (status === null) status = n; finish(); });
  });
}

async function main() {
  const a = parse(process.argv.slice(2));
  if (!a.budget || !(Number(a.budget) > 0) || !Number.isFinite(Number(a.budget))) usage("--budget is required and must be a positive number of dollars");
  if (!a.tier) usage("--tier is required");
  if (!a.promptFile) usage("--prompt-file is required");
  const budget = Number(a.budget);
  const cwd = a.cwd || process.cwd();
  if (a.cwd && !fs.existsSync(a.cwd)) usage(`--cwd ${a.cwd} does not exist`);
  let prompt, schema = "";
  try { prompt = fs.readFileSync(a.promptFile, "utf8"); } catch (e) { usage(`cannot read --prompt-file: ${e.code || e.message}`); }
  if (a.schema) {
    try { schema = JSON.stringify(JSON.parse(fs.readFileSync(a.schema, "utf8"))); } catch (e) { usage(`--schema is not a readable JSON file: ${e.code || e.message}`); }
  }
  const tier = a.tier.toLowerCase();
  const raw = process.env.PROTEUS_DELEGATE_DEPTH;
  const depth = raw === undefined || raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(depth) || depth < 0) usage("PROTEUS_DELEGATE_DEPTH must be a whole number, 0 or more");
  const base = { ok: false, result: "", costUsd: 0, model: "", tier, depth };
  if (depth >= MAX_DEPTH) answer({ ...base, result: `refused: delegation depth ${depth} is at the limit of ${MAX_DEPTH}` }, 1);

  const spec = harness.delegate({ tier, budget, tools: toolList(a.tools), schema });
  if (spec.error) answer({ ...base, result: plain(spec.error) }, 1);
  const ladder = lib.modelPolicy(cwd).ladder;
  if (!ladder.includes(tier)) usage(`--tier ${a.tier} is not a rung of the model ladder (${ladder.join(", ") || "none"})`);

  const r = await call(spec, prompt, cwd, { ...process.env, PROTEUS_DELEGATE_DEPTH: String(depth + 1) });
  let out = { ...base };
  if (r.error) out.result = r.error.code === "ETIMEDOUT" ? `timed out after ${Math.round(TIMEOUT_MS / 1000)}s` : r.error.code === "EMAXBUF" ? "the call's output was over the size cap" : `could not run ${spec.cmd}: ${r.error.code || r.error.message}`;
  else {
    let j = null;
    try { j = JSON.parse(String(r.stdout || "").trim()); } catch {}
    if (!j || typeof j !== "object" || Array.isArray(j)) out.result = "the call's output was not JSON";
    else {
      const text = j.structured_output !== undefined && j.structured_output !== null ? JSON.stringify(j.structured_output) : typeof j.result === "string" ? j.result : "";
      const used = j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage)[0] : "";
      const cost = Number(j.total_cost_usd ?? j.cost_usd);
      out = { ok: r.status === 0 && j.is_error !== true && !String(j.subtype || "").startsWith("error"), result: text, costUsd: Number.isFinite(cost) ? cost : 0, model: used || tier, tier, depth };
      if (!out.ok && !text) out.result = String(j.subtype || "the call failed");
    }
  }
  out.result = plainText(out.result);
  out.model = plain(out.model);
  ledger(a.run, cwd, { tier, model: out.model, costUsd: out.costUsd, ok: out.ok, depth });
  answer(out, out.ok ? 0 : 1);
}

main().catch((e) => { console.error(plain(e && e.message)); process.exit(1); });
