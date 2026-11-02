// Delegation tests: node tests/delegate.test.js (needs git). proteus-delegate.js runs one bounded headless call through
// the harness adapter; a fake claude on PATH records what it was given and answers by FAKE_MODE. No model calls.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const DELEGATE = path.join(HOOKS, "proteus-delegate.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("delegate");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

const LOG = path.join(W, "calls.jsonl");
lib.fakeCli(lib.BIN, "claude", `
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), input, depth: process.env.PROTEUS_DELEGATE_DEPTH, keep: process.env.PROTEUS_KEEP }) + "\\n");
const mode = process.env.FAKE_MODE || "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "junk") console.log("not json at all");
else {
  process.stderr.write("warning: noise on stderr\\n");
  const r = { type: "result", subtype: mode === "budget" ? "error_max_budget_usd" : "success", is_error: mode === "budget", result: mode === "ctrl" ? "a\\u001b[31mred\\u0007\\nline\\tend" : "done", total_cost_usd: 0.0123, modelUsage: { "claude-haiku-test": {} } };
  console.log(JSON.stringify(r));
  process.exit(mode === "budget" ? 1 : 0);
}
`);

const PROMPT = path.join(W, "prompt.txt");
fs.writeFileSync(PROMPT, "summarise the file\n");
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(LOG, { force: true });
const go = (args, env = {}) => {
  const r = lib.run(DELEGATE, "", { cwd: REPO, env: { FAKE_LOG: LOG, ...env }, args });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch {}
  return { ...r, j };
};
const base = ["--tier", "haiku", "--budget", "0.5", "--prompt-file", PROMPT];

// ---- usage
for (const [name, args] of [
  ["no budget", ["--tier", "haiku", "--prompt-file", PROMPT]],
  ["zero budget", ["--tier", "haiku", "--budget", "0", "--prompt-file", PROMPT]],
  ["negative budget", ["--tier", "haiku", "--budget", "-1", "--prompt-file", PROMPT]],
  ["budget not a number", ["--tier", "haiku", "--budget", "lots", "--prompt-file", PROMPT]],
  ["no tier", ["--budget", "1", "--prompt-file", PROMPT]],
  ["tier not on the ladder", ["--tier", "gpt-9", "--budget", "1", "--prompt-file", PROMPT]],
  ["no prompt file", ["--tier", "haiku", "--budget", "1"]],
  ["missing prompt file", ["--tier", "haiku", "--budget", "1", "--prompt-file", path.join(W, "nope")]],
  ["unknown flag", [...base, "--bare"]],
]) {
  reset();
  const r = go(args);
  ok(`usage: ${name} exits 2 and starts no call`, r.code === 2 && r.out === "" && calls().length === 0, `${r.code} ${r.out} ${r.err}`);
}

// ---- a good call: the command, stdin, depth, stdout only
reset();
let r = go(base, { FAKE_MODE: "ok", PROTEUS_KEEP: "inherited" });
const c = calls()[0] || { argv: [] };
ok("call: exit 0 and one JSON line with ok, result, cost, model, tier, depth", r.code === 0 && r.j && r.j.ok === true && r.j.result === "done" && r.j.costUsd === 0.0123 && r.j.model === "claude-haiku-test" && r.j.tier === "haiku" && r.j.depth === 0 && r.out.trim().split("\n").length === 1, r.out + r.err);
ok("call: stderr noise never reaches stdout", !/noise/.test(r.out));
ok("call: the command is claude -p with the model, json output, the budget cap and no session", c.argv[0] === "-p" && c.argv[c.argv.indexOf("--model") + 1] === "haiku" && c.argv[c.argv.indexOf("--output-format") + 1] === "json" && c.argv.includes("--no-session-persistence"), c.argv.join(" "));
ok("budget: --max-budget-usd carries the budget", c.argv[c.argv.indexOf("--max-budget-usd") + 1] === "0.5", c.argv.join(" "));
ok("call: never --bare and never a permission bypass", !c.argv.some((a) => /bare|bypass|dangerously|permission-mode/i.test(a)), c.argv.join(" "));
ok("call: the prompt is on stdin, not argv", c.input === "summarise the file\n" && !c.argv.some((a) => /summarise/.test(a)));
ok("call: the child's depth is one higher and its environment is otherwise inherited", c.depth === "1" && c.keep === "inherited", JSON.stringify(c));
ok("tools: default is read-only, and --tools limits the available set to exactly that list", c.argv[c.argv.indexOf("--tools") + 1] === "Read,Grep,Glob" && c.argv[c.argv.indexOf("--allowedTools") + 1] === "Read,Grep,Glob" && !c.argv.includes("--json-schema"), c.argv.join(" "));

// ---- tools and schema
reset();
go([...base, "--tools", "Read, Agent,Bash,Task,Agent(worker)"]);
let tools = (calls()[0] || { argv: [] }).argv;
ok("tools: Agent is stripped from a given list, the rest kept", tools[tools.indexOf("--tools") + 1] === "Read,Bash" && tools[tools.indexOf("--allowedTools") + 1] === "Read,Bash", tools.join(" "));
ok("tools: the Agent tool is also denied outright", tools[tools.indexOf("--disallowedTools") + 1] === "Agent", tools.join(" "));
reset();
go([...base, "--tools", "Agent"]);
tools = (calls()[0] || { argv: [] }).argv;
ok("tools: a list of only Agent falls back to the read-only default", tools[tools.indexOf("--tools") + 1] === "Read,Grep,Glob", tools.join(" "));
const SCHEMA = path.join(W, "schema.json");
fs.writeFileSync(SCHEMA, '{\n "type": "object"\n}\n');
reset();
go([...base, "--schema", SCHEMA]);
ok("schema: --json-schema carries the file's JSON", (calls()[0] || { argv: [] }).argv.includes('{"type":"object"}'));
fs.writeFileSync(SCHEMA, "{not json");
r = go([...base, "--schema", SCHEMA]);
ok("schema: a file that is not JSON is a usage error", r.code === 2, r.err);

// ---- depth
reset();
r = go(base, { PROTEUS_DELEGATE_DEPTH: "3" });
ok("depth: 3 is refused with exit 1 and no call", r.code === 1 && r.j && r.j.ok === false && /depth/.test(r.j.result) && calls().length === 0, r.out + r.err);
reset();
r = go(base, { PROTEUS_DELEGATE_DEPTH: "2" });
ok("depth: 2 runs and hands the child depth 3", r.code === 0 && r.j.depth === 2 && calls()[0].depth === "3", r.out + r.err);

// ---- failures
r = go(base, { FAKE_MODE: "junk" });
ok("output: unparseable stdout is ok:false, exit 1", r.code === 1 && r.j && r.j.ok === false, r.out + r.err);
r = go(base, { FAKE_MODE: "budget" });
ok("budget: a spent budget is ok:false, exit 1, with its cost", r.code === 1 && r.j && r.j.ok === false && r.j.costUsd === 0.0123, r.out + r.err);
r = go(base, { FAKE_MODE: "ctrl" });
ok("result: control characters are stripped but newlines and tabs are kept", r.code === 0 && r.j.result === "a[31mred\nline\tend", JSON.stringify(r.j));
r = go(base, { FAKE_MODE: "hang", PROTEUS_DELEGATE_TIMEOUT_MS: "300" });
ok("timeout: a hung child is killed and reported ok:false, exit 1", r.code === 1 && r.j && r.j.ok === false && /timed out/.test(r.j.result), r.out + r.err);
r = lib.run(DELEGATE, "", { cwd: REPO, env: { FAKE_LOG: LOG, PATH: path.dirname(process.execPath) }, args: base });
ok("missing claude: ok:false, exit 1", r.code === 1 && /"ok":false/.test(r.out), r.out + r.err);

// ---- harness neutrality
r = go(base, { PROTEUS_HARNESS: "codex" });
ok("codex: delegation is reported unsupported, exit 1", r.code === 1 && r.j && r.j.ok === false && /not supported/.test(r.j.result), r.out + r.err);
const claudeH = require(path.join(HOOKS, "proteus-harness-claude.js")), codexH = require(path.join(HOOKS, "proteus-harness-codex.js"));
ok("harness: both adapters export delegate; codex returns an error, claude a command",
  typeof claudeH.delegate === "function" && !!codexH.delegate({}).error && claudeH.delegate({ tier: "haiku", budget: 1 }).cmd === "claude");

// ---- ledger
const common = path.join(REPO, ".git");
const LEDGER = path.join(common, "proteus", "scratch", "r7", "delegate-ledger.jsonl");
reset();
r = go([...base, "--run", "r7"]);
const rows = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
ok("ledger: one line in the run's scratch dir with time, tier, model, cost, ok and depth", rows.length === 1 && rows[0].tier === "haiku" && rows[0].model === "claude-haiku-test" && rows[0].costUsd === 0.0123 && rows[0].ok === true && rows[0].depth === 0 && !Number.isNaN(Date.parse(rows[0].time)), JSON.stringify(rows) + r.err);
r = go([...base, "--run", "r7"], { FAKE_MODE: "junk" });
ok("ledger: a failed call is ledgered too", fs.readFileSync(LEDGER, "utf8").trim().split("\n").length === 2 && /"ok":false/.test(fs.readFileSync(LEDGER, "utf8")));
r = go([...base, "--run", "../escape"]);
ok("ledger: a run name that is not a scratch key writes nothing", r.code === 0 && !fs.existsSync(path.join(common, "proteus", "escape")) && !fs.existsSync(path.join(REPO, "escape")));
const bare = path.join(W, "norepo");
fs.mkdirSync(bare);
r = lib.run(DELEGATE, "", { cwd: bare, env: { FAKE_LOG: LOG }, args: [...base, "--run", "r7"] });
ok("ledger: with no repo to resolve the run in, it is skipped silently", r.code === 0 && r.err === "" && !fs.existsSync(path.join(bare, "proteus")), r.out + r.err);

lib.summary();
