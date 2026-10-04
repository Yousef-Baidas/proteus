// Model routing tests: node tests/models.test.js (needs git). The ladder's aliases (Mythos on Fable's rung).
// Temp HOME and repo; never touches ~/.claude or the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("models");
const plib = require(path.join(SRC, "proteus-lib.js"));

const REPO = path.join(W, "repo");
fs.mkdirSync(REPO);
g(REPO, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(REPO, "AGENTS.md"), "## Learned\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

const LG = path.join(SRC, "proteus-lead-guard.js");
const T = path.join(W, "t"); fs.mkdirSync(T);
// a transcript whose newest main-thread reply ran on model m, at n tokens of context
const tr = (m, n = 10000) => {
  const f = path.join(T, `${m.replace(/\W/g, "_")}-${n}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: "assistant", message: { role: "assistant", model: m, content: [{ type: "text", text: "x" }], usage: { input_tokens: n } } }) + "\n");
  return f;
};
const spawn = (model, tp, opts = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", transcript_path: tp, cwd: REPO, tool_name: "Agent",
  tool_input: { model, subagent_type: "proteus-worker", prompt: "x" } }, { cwd: REPO, ...opts });

// ---- aliases: a Mythos id sits on Fable's rung
const L = ["haiku", "sonnet", "opus", "fable"];
ok("rungOf: an id matches its rung, the longest rung wins", plib.rungOf(L, "claude-opus-5-5[1m]") === 2 && plib.rungOf(["gpt-6", "gpt-6-mini"], "gpt-6-mini") === 1);
ok("rungOf: a Mythos id is off the ladder without an alias, on Fable's rung with one",
  plib.rungOf(L, "claude-mythos-5-1") === -1 && plib.rungOf(L, "claude-mythos-5-1", { mythos: "fable" }) === 3 && plib.rungOf(L, "mythos", { mythos: "fable" }) === 3);
ok("rungOf: an alias to a rung the ladder lacks matches nothing", plib.rungOf(["sonnet", "opus"], "claude-mythos-5-1", { mythos: "fable" }) === -1);
{
  const TM = tr("claude-mythos-5-1"), TO = tr("claude-opus-5-5");
  let r = spawn("claude-mythos-5-1", TM);
  ok("ladder: a Mythos lead is the once-per-project instance", r.code === 2 && /fable runs once per project and the lead is it/.test(r.err), r.err);
  ok("ladder: a Mythos lead staffs Opus", spawn("opus", TM).code === 0 && spawn("sonnet", TM).code === 0);
  r = spawn("mythos", TO);
  ok("ladder: an Opus lead may not spawn Mythos", r.code === 2 && /fable runs once per project/.test(r.err), r.err);
  const MH = path.join(W, "alias-home"); fs.mkdirSync(path.join(MH, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(MH, ".claude", "proteus.json"), JSON.stringify({ models: { solo: [], aliases: { mythos: "opus" } } }));
  ok("ladder: machine config aliases merge over the harness's", spawn("claude-mythos-5-1", TO, { env: lib.homeEnv(MH) }).code === 0);
}

lib.summary();
