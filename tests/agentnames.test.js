// Agent name tests: node tests/agentnames.test.js (needs git). As a Claude Code plugin (#136) the agents are
// named proteus:<agent>; every guard decision that matches an agent name reads it through lib.agentName, which
// strips that namespace only. A bare name works as before, proteus:<name> counts as <name>, and another
// plugin's namespace (evil:proteus-verifier) matches no Proteus role. Temp repo and skills; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("agentnames");
const hl = require(path.join(SRC, "proteus-lib.js"));
const link = require(path.join(ROOT, "templates", "teams", "link-skills.js"));

const forms = (name) => [[name, name, true], [`proteus:${name}`, `proteus:${name}`, true], [`evil:${name}`, `evil:${name}`, false]];

// ---- the helper
ok("agentName: a bare name is kept", hl.agentName("proteus-verifier") === "proteus-verifier");
ok("agentName: the proteus: namespace is stripped", hl.agentName("proteus:proteus-verifier") === "proteus-verifier");
ok("agentName: another namespace is kept", hl.agentName("evil:proteus-verifier") === "evil:proteus-verifier");
ok("agentName: only one leading proteus: goes", hl.agentName("proteus:proteus:proteus-verifier") === "proteus:proteus-verifier"
  && hl.agentName("x:proteus:proteus-verifier") === "x:proteus:proteus-verifier" && hl.agentName("Proteus:proteus-verifier") === "Proteus:proteus-verifier");
ok("agentName: no type is \"\"", hl.agentName(undefined) === "" && hl.agentName("") === "" && hl.agentName(null) === "");
ok("isVerifier: bare and proteus: verifiers count, a foreign namespace does not",
  ["proteus-verifier", "proteus-backend-verifier", "proteus:proteus-verifier", "proteus:proteus-security-verifier"].every(hl.isVerifier)
  && !["evil:proteus-verifier", "evil:proteus-security-verifier", "proteus:proteus-worker", "proteus:proteus:proteus-verifier", ""].some(hl.isVerifier));
ok("isPipelineAgent: bare and proteus: workers and verifiers count, a foreign namespace and the scout do not",
  ["proteus-worker", "proteus-backend-verifier", "proteus:proteus-worker", "proteus:proteus-qa-verifier"].every(hl.isPipelineAgent)
  && !["evil:proteus-worker", "evil:proteus-verifier", "proteus:proteus-scout", "proteus-guide", ""].some(hl.isPipelineAgent));

// ---- a repo with two pinned team skills, one drifted later
const SK = path.join(W, "skills");
const skill = (name, body) => { fs.mkdirSync(path.join(SK, name), { recursive: true }); fs.writeFileSync(path.join(SK, name, "SKILL.md"), body); };
skill("alpha", "alpha v1\n");
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const HEAD = g(REPO, "rev-parse", "HEAD").trim();
const LG = path.join(SRC, "proteus-lead-guard.js");
const run = (input, extra = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, ...input, ...extra }, { cwd: REPO });
const as = (type, id = "a1") => ({ agent_id: id, agent_type: type });

// ---- signoff (lib.signoffDenial, through the lead guard and the worker guard's call)
const SIGNOFF = `node .claude/hooks/proteus-signoff.js 5 ${HEAD} MERGE`;
const shell = (command, who) => run({ tool_name: "Bash", tool_input: { command } }, who);
for (const [t, label, yes] of forms("proteus-verifier")) {
  const r = shell(SIGNOFF, as(t));
  ok(`signoff: ${label} ${yes ? "passes" : "is refused as not a verifier"}`, yes ? r.code === 0 : r.code === 2 && r.err.includes(`${t} is not a verifier`), r.err);
}
for (const [t, label] of forms("proteus-worker")) {
  const r = shell(SIGNOFF, as(t));
  ok(`signoff: ${label} is refused as not a verifier`, r.code === 2 && /is not a verifier/.test(r.err), r.err);
}
for (const [t, label, yes] of forms("proteus-security-verifier")) {
  const r = shell(`${SIGNOFF} --security`, as(t));
  ok(`signoff --security: ${label} ${yes ? "passes" : "is refused"}`, yes ? r.code === 0 : r.code === 2 && /is not a verifier/.test(r.err), r.err);
}
for (const [t, label] of forms("proteus-backend-verifier")) {
  const r = shell(`${SIGNOFF} --security`, as(t));
  ok(`signoff --security: ${label} is refused`, r.code === 2 && /(security verifier's signoff|is not a verifier)/.test(r.err), r.err);
}
const wg = (t) => hl.signoffDenial({ agent: "a1", agentType: t, command: SIGNOFF }, hl.SIGNOFF_MSG.role("a worker's session"));
ok("signoff, worker guard: bare and proteus: verifiers pass, evil: is refused",
  wg("proteus-verifier") === null && wg("proteus:proteus-verifier") === null && /evil:proteus-verifier is not a verifier/.test(wg("evil:proteus-verifier") || ""));

// ---- beats (lib.beat, PIPELINE_AGENT)
const BEATS = path.join(REPO, ".git", "proteus", "beats");
const beat = (a) => { try { return JSON.parse(fs.readFileSync(path.join(BEATS, `${a}.json`), "utf8")); } catch { return null; } };
let n = 0;
for (const name of ["proteus-worker", "proteus-backend-verifier"]) for (const [t, label, yes] of forms(name)) {
  const id = `b${n++}`;
  shell("ls", as(t, id));
  ok(`beat: ${label} ${yes ? "is" : "is not"} tracked`, yes ? !!beat(id) && beat(id).type === t : !beat(id), JSON.stringify(beat(id)));
}
for (const [t, label] of forms("proteus-scout")) { shell("ls", as(t, "s1")); ok(`beat: ${label} is not tracked`, !beat("s1")); }

// ---- the scout's teams/*/skills.txt in the main checkout during a run
g(REPO, "branch", "proteus/r1");
const SKT = path.join(REPO, "teams", "backend", "skills.txt");
const edit = (who) => run({ tool_name: "Write", tool_input: { file_path: SKT, content: "x" } }, who);
for (const [t, label, yes] of forms("proteus-scout")) {
  const r = edit(as(t, "sc"));
  ok(`scout: ${label} ${yes ? "writes" : "may not write"} teams/*/skills.txt during a run`, yes ? r.code === 0 : r.code === 2 && /while a run is open/.test(r.err), r.err);
}
g(REPO, "branch", "-D", "proteus/r1");

// ---- spawn while a team skill drifted from its pin (PIPELINE)
const TS = path.join(REPO, "teams", "backend", ".claude", "skills");
fs.mkdirSync(TS, { recursive: true });
fs.symlinkSync(path.join(SK, "alpha"), path.join(TS, "alpha"), process.platform === "win32" ? "junction" : "dir");
fs.writeFileSync(path.join(REPO, "teams", "skills-lock.json"), JSON.stringify({ version: 1, skills: { alpha: { source: "o/r", hash: link.hashDir(path.join(SK, "alpha")) } } }) + "\n");
fs.writeFileSync(path.join(SK, "alpha", "SKILL.md"), "alpha v2\n");
const spawn = (type) => run({ tool_name: "Agent", tool_input: { model: "opus", prompt: "x", subagent_type: type } });
for (const name of ["proteus-worker", "proteus-backend-verifier"]) for (const [t, label, yes] of forms(name)) {
  const r = spawn(t);
  ok(`drift: a ${label} spawn ${yes ? "is refused" : "is not a Proteus pipeline spawn and passes"}`, yes ? r.code === 2 && r.err.includes(`no ${t} spawn`) : r.code === 0, r.err);
}
for (const [t, label] of forms("proteus-scout")) ok(`drift: a ${label} spawn passes`, spawn(t).code === 0);

lib.summary();
