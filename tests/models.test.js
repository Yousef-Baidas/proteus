// Model routing tests: node tests/models.test.js (needs git). The ladder's aliases (Mythos on Fable's rung)
// and the handoff lines scaled to the lead's context window.
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

// ---- context window: the handoff lines are 75% and 90% of the lead's window, a configured cap first
const cl = require(path.join(SRC, "proteus-harness-claude.js"));
ok("modelWindow: 1M for [1m], Fable, Mythos, Opus 4.7+, Sonnet 5+ and bare aliases", ["claude-opus-5-5", "claude-sonnet-4-6[1m]", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-4-7", "claude-sonnet-5", "opus", "sonnet"].every((m) => cl.modelWindow(m) === 1000000));
ok("modelWindow: 200k for Haiku and older Opus and Sonnet, 0 for an unknown id", ["claude-haiku-4-5-20251001", "haiku", "claude-opus-4-6", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022"].every((m) => cl.modelWindow(m) === 200000) &&
  cl.modelWindow("gpt-6") === 0 && cl.modelWindow("") === 0);
{
  const T190 = tr("claude-opus-5-5", 190000), T280 = tr("claude-opus-5-5", 280000), TU = path.join(T, "unknown-190k.jsonl"), TS = tr("claude-sonnet-4-6", 190000), TS1 = tr("claude-sonnet-4-6[1m]", 190000);
  fs.writeFileSync(TU, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [], usage: { input_tokens: 190000 } } }) + "\n");
  const hard = (r) => r.code === 2 && /context at \d+k: \/handoff/.test(r.err);
  ok("handoff: an Opus 5.5 lead at 190k with no cap may spawn (1M window)", spawn("sonnet", T190).code === 0);
  ok("handoff: an unknown model or a 200k model at 190k may not (200k window)", hard(spawn("sonnet", TU)) && hard(spawn("sonnet", TS)) && spawn("sonnet", TS1).code === 0);
  const CH = path.join(W, "cap-home"); fs.mkdirSync(path.join(CH, ".claude"), { recursive: true });
  const userSettings = (o) => fs.writeFileSync(path.join(CH, ".claude", "settings.json"), JSON.stringify(o));
  const capped = (tp, env = {}) => spawn("sonnet", tp, { env: { ...lib.homeEnv(CH), ...env } });
  userSettings({ autoCompactWindow: 200000 });
  ok("handoff: autoCompactWindow 200k in the user settings caps a 1M lead", hard(capped(T190)));
  ok("handoff: PROTEUS_HANDOFF_HARD still overrides", capped(T190, { PROTEUS_HANDOFF_HARD: "950000" }).code === 0);
  userSettings({ autoCompactWindow: 200000, modelSettings: { "claude-opus-5-5": { autoCompactWindow: 300000 } } });
  ok("handoff: a modelSettings entry for the lead's model comes before the plain key", capped(T190).code === 0 && hard(capped(T280)));
  userSettings({});
  const PS = path.join(REPO, ".claude", "settings.local.json"); fs.mkdirSync(path.dirname(PS), { recursive: true });
  fs.writeFileSync(PS, JSON.stringify({ autoCompactWindow: 200000 }));
  ok("handoff: the project's settings.local.json caps it too", hard(capped(T190)));
  fs.rmSync(PS);
  ok("handoff: CLAUDE_CODE_AUTO_COMPACT_WINDOW and CLAUDE_CODE_DISABLE_1M_CONTEXT cap it",
    hard(capped(T190, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" })) && hard(capped(T190, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" })) && capped(T190, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" }).code === 0);
  fs.writeFileSync(path.join(CH, ".claude", "proteus.json"), JSON.stringify({ contextWindow: 200000 }));
  ok("handoff: contextWindow in ~/.claude/proteus.json caps it", hard(capped(T190)));
  fs.rmSync(path.join(CH, ".claude", "proteus.json"));
  // the journal's meter warns at 75%
  const J = path.join(SRC, "proteus-journal.js");
  const T160 = tr("claude-opus-5-5", 160000);
  const meter = (env = {}) => lib.run(J, { hook_event_name: "UserPromptSubmit", session_id: "s1", transcript_path: T160, cwd: REPO, prompt: "go" }, { cwd: REPO, env: { ...lib.homeEnv(CH), ...env } }).out;
  ok("journal: no handoff warning at 160k on a 1M window, a warning under a 200k cap", !/context at 160k/.test(meter()) && /context at 160k/.test(meter({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" })));
  ok("journal: PROTEUS_HANDOFF_AT still overrides", /context at 160k/.test(meter({ PROTEUS_HANDOFF_AT: "150000" })));
}
{ // Codex: the rollout's model_context_window, and the caps in config.toml
  process.env.CODEX_HOME = path.join(W, "codex-home"); fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const cx = require(path.join(SRC, "proteus-harness-codex.js"));
  const RO = path.join(T, "rollout.jsonl");
  fs.writeFileSync(RO, JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 }, model_context_window: 272000 } } }) + "\n");
  ok("codex modelWindow: the newest token_count's model_context_window", cx.modelWindow("gpt-6", { raw: { transcript_path: RO } }) === 272000 && cx.modelWindow("gpt-6", { raw: {} }) === 0);
  const CR = path.join(W, "cx-repo"); fs.mkdirSync(path.join(CR, ".codex"), { recursive: true });
  ok("codex contextCap: 0 with no config", cx.contextCap({ root: CR }) === 0);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "model = \"gpt-6\"\nmodel_context_window = 400000\n");
  fs.writeFileSync(path.join(CR, ".codex", "config.toml"), "model_auto_compact_token_limit = 180_000 # tokens\n[profiles.x]\nmodel_auto_compact_token_limit = 9\n");
  ok("codex contextCap: the project's root keys first, the smallest of them", cx.contextCap({ root: CR }) === 180000);
  fs.rmSync(path.join(CR, ".codex", "config.toml"));
  ok("codex contextCap: else $CODEX_HOME/config.toml", cx.contextCap({ root: CR }) === 400000);
}

lib.summary();
