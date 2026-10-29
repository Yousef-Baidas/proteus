// #140: node tests/staleflights.test.js (needs git). A subagent's shell-call records end with the subagent
// (SubagentStop) or after the watchdog's idle window; a lead notice lists each path once, capped; the lead's
// install.js and the session-start sync are named as the likely cause, and the sync is a lead window.
// Temp repo; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("staleflights");
const slash = (p) => p.split(path.sep).join("/");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
fs.writeFileSync(path.join(REPO, "src", "a.js"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const WT1 = path.join(REPO, ".worktrees", "r1-1");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT1, "main");
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT1, "src/**"] });
const STATE = path.join(REPO, ".git", "proteus-lead");
const LG = path.join(SRC, "proteus-lead-guard.js"), SC = path.join(SRC, "proteus-shell-check.js"), ST = path.join(SRC, "proteus-stall.js");
const AGENTS = path.join(REPO, ".claude", "agents");
fs.mkdirSync(AGENTS, { recursive: true });

let n = 0;
const sub = (id) => ({ agent_id: id, agent_type: "proteus-backend-worker" });
const evOf = (who, cwd, command) => ({ session_id: "s1", cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_${++n}`, ...who });
const pre = (b) => lib.run(LG, { hook_event_name: "PreToolUse", ...b }, { cwd: REPO });
const post = (b) => {
  const p = lib.run(SC, { hook_event_name: "PostToolUse", ...b, tool_response: { stdout: "", stderr: "" } }, { cwd: REPO });
  let j = null;
  try { j = JSON.parse(p.out); } catch {}
  return { blocked: !!(j && j.decision === "block"), why: (j && j.reason) || "", ctx: (j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || "" };
};
const stop = (id, msg) => lib.run(ST, { hook_event_name: "SubagentStop", session_id: "s1", cwd: REPO, ...sub(id), stop_hook_active: false, last_assistant_message: msg }, { cwd: REPO });
const ls = (d) => { try { return fs.readdirSync(path.join(STATE, d)); } catch { return []; } };
const keysIn = (d) => ls(d).map((f) => (JSON.parse(fs.readFileSync(path.join(STATE, d, f), "utf8")) || {}).key);
const write = (f, body = "x") => fs.writeFileSync(path.join(AGENTS, f), body);
const clear = () => lib.run(SC, "", { cwd: REPO, args: ["--clear", "all"] });

// 1. SubagentStop ends the agent's calls: a call whose PostToolUse never came no longer overlaps the lead's
let a = evOf(sub("a1"), WT1, "npm test");
ok("setup: a1's call is let through and snapshotted", pre(a).code === 0 && keysIn("scratch-snap").includes("agent-a1") && keysIn("guard-flight").includes("agent-a1"));
const s = stop("a1", "Waiting for the background build to finish.");
ok("stop: a stop the stall hook blocks keeps the agent's calls", /Poll it now/.test(s.out + s.err) && keysIn("scratch-snap").includes("agent-a1"), s.out + s.err);
stop("a1", "DONE #1 merged");
ok("stop: a stop that passes drops the agent's markers and snapshots", !keysIn("scratch-snap").includes("agent-a1") && !keysIn("guard-flight").includes("agent-a1"), JSON.stringify(keysIn("scratch-snap")));
let l = evOf({}, REPO, "node -e ...");
pre(l); write("lead1.md");
let lp = post(l);
ok("stop: the lead's later call gets no notice for the stopped agent", !lp.ctx && ls("unattributed").length === 0, lp.ctx);

// 2. a call silent past the watchdog's idle window (its agent crashed) is not in flight
a = evOf(sub("a2"), WT1, "npm test");
pre(a);
const old = Date.now() - 41 * 60e3;
for (const d of ["scratch-snap", "guard-flight"]) for (const f of ls(d)) {
  const p = path.join(STATE, d, f), j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (j.key === "agent-a2") fs.writeFileSync(p, JSON.stringify({ ...j, at: old }));
}
l = evOf({}, REPO, "node -e ...");
pre(l); write("lead2.md");
lp = post(l);
ok("stale: a snapshot older than the idle window gives no notice", !lp.ctx && ls("unattributed").length === 0, lp.ctx);
ok("stale: ...and stays until it is an hour old (its call may still end)", keysIn("scratch-snap").includes("agent-a2"));
stop("a2", "DONE #2");

// 3. a notice lists each path once with every agent that overlapped, capped in size
const a3 = evOf(sub("a3"), WT1, "npm test"), a4 = evOf(sub("a4"), WT1, "npm test");
pre(a3); pre(a4);
l = evOf({}, REPO, "node -e ...");
pre(l);
for (let i = 0; i < 400; i++) write(`many-${String(i).padStart(3, "0")}-${"x".repeat(40)}.md`);
lp = post(l);
const first = slash(path.join(AGENTS, `many-000-${"x".repeat(40)}.md`));
ok("group: the lead is shown one notice naming both agents", lp.ctx.includes("a3") && lp.ctx.includes("a4") && ls("unattributed").length === 1, lp.ctx.slice(0, 400));
ok("group: ...each path once, with both agents beside it", lp.ctx.split(first).length === 2 && lp.ctx.includes(`${first} (a3 on proteus-work/r1/1, a4 on proteus-work/r1/1)`), lp.ctx.slice(0, 400));
ok("group: ...capped at a few KB with \"and N more\"", lp.ctx.length < 6000 && /; and \d+ more\./.test(lp.ctx), String(lp.ctx.length));
ok("group: the agents' own calls then end without a block", !post(a3).blocked && !post(a4).blocked);
const one = JSON.parse(fs.readFileSync(path.join(STATE, "unattributed", ls("unattributed")[0]), "utf8"));
ok("group: ...and each agent keeps one entry in the notice", one.agents.length === 2, JSON.stringify(one.agents.map((x) => x.key)));
clear();

// 4. the lead's install.js: named as the likely cause when an agent overlapped; never flagged when none did
a = evOf(sub("a5"), WT1, "npm test");
pre(a);
l = evOf({}, REPO, "node ~/proteus/install.js --project");
pre(l); write("installed.md", "v2");
lp = post(l);
ok("install: an overlapping agent's call gives a notice naming install.js as the likely cause", lp.ctx.includes("installed.md") && /ran install\.js/.test(lp.ctx), lp.ctx);
ok("install: ...and the agent is not blocked", !post(a).blocked);
clear();
l = evOf({}, REPO, "node ~/proteus/install.js --verifier-app");
pre(l); write("installed.md", "v3");
lp = post(l);
a = evOf(sub("a5"), WT1, "npm test");
pre(a);
ok("install: with no agent call overlapping, the lead's run is neither noticed nor blamed", !lp.ctx && !post(a).blocked && ls("unattributed").length === 0, lp.ctx);
l = evOf({}, REPO, `node ${slash(SC)} --list`);
pre(l);
ok("shell-check: the lead's own --list/--clear run gives no notice", !post(l).ctx);

// 5. the session-start sync is a lead window: an agent's call in flight across it gets a notice, not a block
a = evOf(sub("a6"), WT1, "npm test");
pre(a);
const sync = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(SC)}).leadRun({ root: ${JSON.stringify(REPO)}, session: "s1" }, () => require("fs").writeFileSync(${JSON.stringify(path.join(AGENTS, "synced.md"))}, "v2")).then((t) => process.stdout.write(t))`], { cwd: REPO, encoding: "utf8", env: { ...lib.ENV, CLAUDE_PROJECT_DIR: REPO } });
ok("sync: the sync's write is shown to the lead as a notice naming the sync", sync.stdout.includes("synced.md") && sync.stdout.includes("the session-start sync"), sync.stdout + sync.stderr);
let ap = post(a);
ok("sync: ...and the agent's call is not blocked for it", !ap.blocked, ap.why);
clear();

// detection is not weakened: an agent's own write with no lead call overlapping still blocks
a = evOf(sub("a7"), WT1, "node -e ...");
pre(a); write("agent.md");
ap = post(a);
ok("agent: a write by the agent alone still blocks, naming the path", ap.blocked && ap.why.includes("agent.md"), ap.why);

lib.summary();
