// Stall watchdog tests: node tests/watchdog.test.js (needs git). The lead's guard stamps a worker's beat on each
// tool call, proteus-stall.js marks a stop without a report and drops the beat on a report, and
// proteus-watchdog.js prints STALL only for an agent idle or stopped too long. Only agents the lead's own
// spawns recorded are tracked, a stop that hands a final message back is a report, and --forget is for good.
// Timestamps are written into the beat files, so nothing waits on the clock. No network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("watchdog");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

const LG = path.join(SRC, "proteus-lead-guard.js");
const ST = path.join(SRC, "proteus-stall.js");
const WD = path.join(SRC, "proteus-watchdog.js");
const BEATS = path.join(REPO, ".git", "proteus-lead", "beats");
const beatFile = (a) => path.join(BEATS, `${a}.json`);
const beat = (a) => { try { return JSON.parse(fs.readFileSync(beatFile(a), "utf8")); } catch { return null; } };
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const setBeat = (a, patch) => fs.writeFileSync(beatFile(a), JSON.stringify({ ...beat(a), ...patch }));

// the lead's spawns, recorded by its guard: only an agent with a lead spawn record is tracked (#179)
const TP = path.join(W, "lead.jsonl");
fs.writeFileSync(TP, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1000 } } }) + "\n");
const spawn = (type, name) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, transcript_path: TP, tool_name: "Agent", tool_input: { model: "sonnet", subagent_type: type, prompt: "x", ...(name && { name }) } }, { cwd: REPO });
for (const t of ["proteus-worker", "proteus-verifier", "proteus-backend-worker", "proteus-scout"]) {
  const s = spawn(t);
  if (s.code !== 0) ok(`spawn: the lead's ${t} spawn passes`, false, s.err);
}
const tool = (agent, type = "proteus-worker", env = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Bash", tool_input: { command: "ls" }, agent_id: agent, agent_type: type }, { cwd: REPO, env });
const stop = (agent, msg, extra = {}) => lib.run(ST, { hook_event_name: "SubagentStop", session_id: "s1", cwd: REPO, agent_id: agent, agent_type: "proteus-worker", stop_hook_active: false, last_assistant_message: msg, ...extra }, { cwd: REPO });
const wd = (...args) => lib.run(WD, "", { cwd: REPO, args });

// beats
let r = tool("a1");
let b = beat("a1");
ok("beat: a worker's tool call through the lead's guard stamps its file", r.code === 0 && b && b.type === "proteus-worker" && b.cwd === REPO && Date.now() - Date.parse(b.last) < 60000, JSON.stringify(b) + r.err);
tool("s9", "proteus-scout");
lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Bash", tool_input: { command: "ls" } }, { cwd: REPO });
ok("beat: a scout and the lead's own calls are not tracked", !beat("s9") && fs.readdirSync(BEATS).length === 1, fs.readdirSync(BEATS).join(" "));
r = lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Bash", tool_input: { command: "git push origin main" }, agent_id: "a3", agent_type: "proteus-verifier" }, { cwd: REPO });
ok("beat: a refused call still counts as alive", r.code === 2 && beat("a3") && beat("a3").type === "proteus-verifier", r.err);
fs.rmSync(beatFile("a3"));
tool("c1", "proteus-backend-worker", { PROTEUS_HARNESS: "codex" });
ok("beat: Codex's events stamp the same file", beat("c1") && beat("c1").type === "proteus-backend-worker", JSON.stringify(beat("c1")));
fs.rmSync(beatFile("c1"));

// one-shot check
r = wd();
ok("check: a fresh beat is ok, exit 0, one line", r.code === 0 && /^watchdog: ok, 1 agent tracked, newest tool call 0m ago\n$/.test(r.out), r.out + r.err);
setBeat("a1", { last: ago(45) });
r = wd();
ok("check: no tool call for 40 minutes is a STALL naming agent, type, idle time and cwd, exit 1",
  r.code === 1 && r.out.includes(`STALL a1 proteus-worker no tool call for 45m, cwd ${REPO}`) && /message the agent/.test(r.out), r.out + r.err);
r = wd();
ok("check: a flagged agent stays quiet for the grace period", r.code === 0 && /ok, 1 agent/.test(r.out), r.out);
setBeat("a1", { flagged: ago(21) });
r = wd();
ok("check: still stalled past the grace is STALL-AGAIN", r.code === 1 && /^STALL-AGAIN a1 proteus-worker no tool call for 45m/m.test(r.out), r.out);
r = wd("--idle", "50");
ok("check: --idle raises the threshold", r.code === 0, r.out);
tool("a1");
ok("beat: the agent's next tool call clears the flag", beat("a1") && !beat("a1").flagged && wd().code === 0, JSON.stringify(beat("a1")));

// stops
r = stop("a1", "DONE #4 contract green, PR #12");
ok("stop: a report removes the beat", r.code === 0 && !beat("a1"), r.out);
tool("h1");
r = stop("h1", "Here is what I looked at so far.");
ok("stop: a hand-back, a passing stop with a final message, is a report and removes the beat (#179)", r.code === 0 && !/block/.test(r.out) && !beat("h1"), r.out + JSON.stringify(beat("h1")));
const H2 = path.join(W, "h2.jsonl");
fs.writeFileSync(H2, JSON.stringify({ isSidechain: true, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Summary: fixed it." }] } }) + "\n");
tool("h2");
r = stop("h2", undefined, { agent_transcript_path: H2 });
ok("stop: a final message read from the agent's own transcript counts too", r.code === 0 && !beat("h2"), r.out + JSON.stringify(beat("h2")));
tool("a2");
r = stop("a2", "");
b = beat("a2");
ok("stop: a stop with no final message passes and marks the beat ended", r.code === 0 && !/block/.test(r.out) && b && b.ended && b.last, r.out + JSON.stringify(b));
ok("check: an ended agent is quiet for 10 minutes", wd().code === 0);
setBeat("a2", { ended: ago(12) });
r = wd();
ok("check: ended 10 minutes ago without a report is a STALL", r.code === 1 && /^STALL a2 proteus-worker stopped 12m ago without a report/m.test(r.out), r.out);
tool("a2");
ok("beat: a resumed agent's tool call clears ended and the flag", beat("a2") && !beat("a2").ended && !beat("a2").flagged);
r = stop("a2", "Rendering. Waiting on the background render to finish.");
ok("stop: a blocked wait keeps the beat alive, not ended", /"decision":"block"/.test(r.out) && !beat("a2").ended, r.out);
r = stop("a2", "Rendering. Waiting on the background render to finish.", { stop_hook_active: true });
ok("stop: the second stop after a block hands its message back, a report", r.code === 0 && !beat("a2"), JSON.stringify(beat("a2")));
tool("a2");
r = stop("a2", "", { stop_hook_active: true });
ok("stop: the second stop after a block with no message is ended", beat("a2") && beat("a2").ended, JSON.stringify(beat("a2")));

// only the lead's own spawns (#179)
tool("n1", "proteus-qa-verifier");
stop("n2", "", { agent_type: "proteus-frontend-worker" });
ok("dispatch: a worker or verifier type the lead never spawned (nested, foreign) is not tracked, by call or stop", !beat("n1") && !beat("n2"));
tool("n3", "work-9");
ok("dispatch: an unrecorded name is not tracked", !beat("n3"));
r = spawn("proteus-backend-worker", "work-9");
tool("n3", "work-9");
ok("dispatch: a named lead spawn is tracked under its subagent_type", r.code === 0 && beat("n3") && beat("n3").type === "proteus-backend-worker", r.err + JSON.stringify(beat("n3")));
lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, transcript_path: TP, tool_name: "Agent", tool_input: { model: "sonnet", subagent_type: "proteus-worker", name: "nested-1", prompt: "x" }, agent_id: "n3", agent_type: "work-9" }, { cwd: REPO });
tool("n5", "nested-1");
ok("dispatch: an agent a worker spawned itself is not tracked", !beat("n5"));
tool("n4", "proteus-scout");
ok("dispatch: a lead-spawned scout is still not tracked", !beat("n4"));

// --wait
fs.rmSync(BEATS, { recursive: true });
tool("a4");
r = wd("--wait", "--every", "0.05", "--max", "0.005");
ok("wait: nothing stalled until --max, then exits 0 with one line", r.code === 0 && r.out.startsWith("watchdog: nothing stalled in 0.005 minutes"), r.out + r.err);
setBeat("a4", { last: ago(41) });
r = wd("--wait", "--every", "0.05");
ok("wait: exits 1 on the first stall, printing only it", r.code === 1 && r.out.startsWith("STALL a4 "), r.out + r.err);

// housekeeping
setBeat("a4", { last: ago(25 * 60), flagged: undefined });
r = wd();
ok("check: a beat a day old is removed", r.code === 0 && !beat("a4") && /no agent tracked/.test(r.out), r.out);
tool("a5"); tool("a6"); tool("a7");
r = wd("--forget", "a5");
ok("forget: one agent", r.code === 0 && !beat("a5") && beat("a6") && /forgot 1 agent$/m.test(r.out), r.out);
r = wd("--forget", "all");
ok("forget: all", r.code === 0 && !beat("a6") && !beat("a7") && /forgot 2 agents/.test(r.out), r.out);
stop("a6", ""); stop("a7", "Halfway there."); tool("a6"); stop("a9", "");
ok("forget: a later stop or call of a forgotten agent, or of one spawned before --forget all, does not re-add it (#179)",
  !beat("a5") && !beat("a6") && !beat("a7") && !beat("a9") && /no agent tracked/.test(wd().out), fs.readdirSync(BEATS).join(" "));
spawn("proteus-worker");
tool("b1");
stop("a5", ""); stop("a6", "");
ok("forget: an agent spawned after --forget all is tracked; the forgotten ids stay forgotten", beat("b1") && !beat("a5") && !beat("a6"), fs.readdirSync(BEATS).join(" "));
wd("--forget", "b1");
stop("b1", "");
ok("forget: one agent stays forgotten after its stop", !beat("b1"), JSON.stringify(beat("b1")));
ok("usage: an unknown flag, a bad number or --forget with nothing exits 2",
  wd("--nope").code === 2 && wd("--idle", "x").code === 2 && wd("--forget").code === 2);

// installs
const cx = require(path.join(SRC, "proteus-harness-codex.js"));
const CX = path.join(W, "cx");
fs.mkdirSync(CX);
cx.registerLead(CX);
ok("codex: the rules let the lead's watchdog write its flags outside the sandbox",
  fs.readFileSync(path.join(CX, ".codex", "rules", "proteus.rules"), "utf8").includes(JSON.stringify(path.join(CX, ".codex", "hooks", "proteus-watchdog.js").split(path.sep).join("/"))));

lib.summary();
