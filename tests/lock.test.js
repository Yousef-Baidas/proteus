// Skills-lock tests: node tests/lock.test.js (needs git). While a team skill differs from its pin in
// teams/skills-lock.json, the lead guard refuses proteus worker and verifier spawns and lets helpers
// pass; the autostart reports the drift. Temp repo and skills; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("lock");
const hl = require(path.join(SRC, "proteus-lib.js"));
const link = require(path.join(ROOT, "templates", "teams", "link-skills.js"));

// two installed skills, linked into one team the way link-skills.js does
const SK = path.join(W, "skills");
const skill = (name, body) => { fs.mkdirSync(path.join(SK, name, "references"), { recursive: true }); fs.writeFileSync(path.join(SK, name, "SKILL.md"), body); fs.writeFileSync(path.join(SK, name, "references", "a.md"), "ref\n"); };
skill("alpha", "alpha v1\n");
skill("beta", "beta v1\n");
const REPO = path.join(W, "repo");
fs.mkdirSync(path.join(REPO, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
g(W, "init", "-q", "-b", "main", REPO);
const TS = path.join(REPO, "teams", "backend", ".claude", "skills");
fs.mkdirSync(TS, { recursive: true });
for (const n of ["alpha", "beta"]) fs.symlinkSync(path.join(SK, n), path.join(TS, n), process.platform === "win32" ? "junction" : "dir");
const LOCK = path.join(REPO, "teams", "skills-lock.json");
const pin = () => fs.writeFileSync(LOCK, JSON.stringify({ version: 1, skills: { alpha: { source: "o/r", hash: link.hashDir(path.join(SK, "alpha")) }, beta: { source: "o/r", hash: link.hashDir(path.join(SK, "beta")) } } }, null, 2) + "\n");

const LG = path.join(SRC, "proteus-lead-guard.js");
const AS = path.join(SRC, "proteus-autostart.js");
const spawn = (type, extra = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Agent", tool_input: { model: "opus", prompt: "x", subagent_type: type || undefined }, ...extra }, { cwd: REPO });
const start = () => lib.run(AS, { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: REPO }, { cwd: REPO });
const stateLine = (out) => out.split("\n").find((l) => l.startsWith("proteus-state")) || "";

ok("hash: lib.hashSkill matches link-skills.js hashDir byte for byte", hl.hashSkill(path.join(SK, "alpha")) === link.hashDir(path.join(SK, "alpha")));

// no lock: nothing pinned, nothing refused
ok("no lock: a worker spawn passes", spawn("proteus-worker").code === 0, spawn("proteus-worker").err);
ok("no lock: autostart says skills-lock=NO", /skills-lock=NO( |$)/.test(stateLine(start().out)));

// pinned and matching
pin();
ok("clean: lockDrift is empty", hl.lockDrift(REPO, true).length === 0);
ok("clean: worker and verifier spawns pass", spawn("proteus-worker").code === 0 && spawn("proteus-backend-verifier").code === 0);
let r = start();
ok("clean: autostart says skills-lock=yes, no drift note", /skills-lock=yes( |$)/.test(stateLine(r.out)) && !/Drifted/.test(r.out), stateLine(r.out));

// drift: beta's copy on this machine changes after the lock was written
fs.writeFileSync(path.join(SK, "beta", "SKILL.md"), "beta v2\n");
r = start();
ok("drift: autostart says skills-lock=drift:beta and tells how to re-lock", /skills-lock=drift:beta( |$)/.test(stateLine(r.out)) && /spawns are refused/.test(r.out) && /--relock/.test(r.out), r.out.slice(0, 1500));
const denied = (type) => { const x = spawn(type); return x.code === 2 && /Drifted from teams\/skills-lock\.json: beta\./.test(x.err) && /link-skills\.js --relock/.test(x.err) && /npx skills update/.test(x.err); };
ok("drift: proteus-worker, proteus-verifier and team workers/verifiers are refused with the re-lock steps",
  ["proteus-worker", "proteus-verifier", "proteus-backend-worker", "proteus-qa-verifier", "proteus-security-verifier"].every(denied), spawn("proteus-worker").err);
ok("drift: helper spawns pass (scout, guide, general-purpose, Explore, none named)",
  ["proteus-scout", "proteus-guide", "general-purpose", "Explore", ""].every((t) => spawn(t).code === 0));
ok("drift: a subagent's own spawn is not the lead's dispatch", spawn("proteus-worker", { agent_id: "a1", agent_type: "proteus-scout" }).code === 0);
ok("drift: PROTEUS=0 opens the session without the guard", lib.run(LG, { hook_event_name: "PreToolUse", cwd: REPO, tool_name: "Agent", tool_input: { model: "opus", subagent_type: "proteus-worker" } }, { cwd: REPO, env: { PROTEUS: "0" } }).code === 0);

// the guard's own check, without the autostart: a stale clean cache for an older lock does not hide a drift
fs.writeFileSync(path.join(SK, "beta", "SKILL.md"), "beta v1\n");
ok("cache: an update back to the pinned copy clears the drift at the next spawn", spawn("proteus-worker").code === 0);
fs.writeFileSync(path.join(SK, "beta", "SKILL.md"), "beta v3\n");
const cache = hl.readJSON(hl.driftFile(path.join(REPO, ".git")), null);
ok("cache: a clean result is cached per lock in .git/proteus/skills-drift.json", cache && Array.isArray(cache.drift) && !cache.drift.length && typeof cache.lock === "string", JSON.stringify(cache));
ok("cache: the clean result stands until the lock changes or a session starts", spawn("proteus-worker").code === 0);
start();
ok("cache: the next session start re-hashes and the guard refuses", spawn("proteus-worker").code === 2);

// re-lock accepts this machine's copy: the lock --relock writes holds the current hashes
pin();
ok("relock: the next worker spawn passes", spawn("proteus-worker").code === 0, spawn("proteus-worker").err);

// a broken lock or a pinned skill linked nowhere is not a drift
fs.writeFileSync(LOCK, JSON.stringify({ version: 1, skills: { gone: { source: "o/r", hash: "0" }, "../x": { source: "o/r", hash: "0" } } }));
ok("lock: a pinned skill linked nowhere, or a name with a path in it, is no drift", hl.lockDrift(REPO, true).length === 0);
fs.writeFileSync(LOCK, "{ not json");
ok("lock: an unreadable lock is no drift", hl.lockDrift(REPO, true).length === 0 && spawn("proteus-worker").code === 0);

// Codex: spawn_agent names the agent in agent_type
pin();
fs.writeFileSync(path.join(SK, "alpha", "SKILL.md"), "alpha v2\n");
const cx = (type) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "c1", cwd: REPO, model: "gpt-6-sol", transcript_path: null, tool_name: "spawn_agent", tool_input: { message: "x", model: "gpt-6-sol", agent_type: type } }, { cwd: REPO, env: { PROTEUS_HARNESS: "codex" } });
r = cx("proteus-worker");
ok("codex: a proteus-worker spawn_agent is refused on drift", r.code === 2 && /Drifted from teams\/skills-lock\.json: alpha\./.test(r.err), r.err);
ok("codex: a helper spawn_agent passes", cx("explorer").code === 0, cx("explorer").err);

lib.summary();
