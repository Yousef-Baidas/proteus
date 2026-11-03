// Acceptance checks (#365): node tests/acceptance.test.js (needs git). The run's checks live in
// <run scratch>/proteus-holdout/, and both guards refuse a worker's Read, Edit or shell command reaching them
// (lib.holdoutDenial); a verifier and proteus-acceptance pass. The lead guard refuses a verifier spawn whose
// prompt names no saved scratch/<key>/spec.md (lib.specNamed), in the main checkout and a linked worktree.
// Temp repo with a local bare remote; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const hl = require(path.join(SRC, "proteus-lib.js"));
const { ok, g } = lib;
const W = lib.workdir("acceptance");

const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, "src"));
fs.writeFileSync(path.join(REPO, "src", "a.js"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE);
g(REPO, "push", "-q", "-u", "origin", "main");
g(REPO, "push", "-q", "origin", "main:proteus/r1");
const WT = path.join(REPO, ".worktrees", "r1-1");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT, "main");
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "src/**"] });

// the run's scratch, as the lead fills it at planning
const SPEC = lib.spec(REPO, "r1");
const CHECKS = path.join(path.dirname(SPEC), hl.HOLDOUT);
fs.mkdirSync(CHECKS, { recursive: true });
const CHECK = path.join(CHECKS, "01-login.sh");
fs.writeFileSync(CHECK, "#!/bin/sh\n# \"A user can log in.\"\nexit 0\n");

const LG = path.join(SRC, "proteus-lead-guard.js");
const as = (agent_type) => ({ agent_id: `a-${agent_type}`, agent_type });
const ev = (tool_name, tool_input, extra = {}, cwd = REPO) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name, tool_input, ...extra });
const lead = (e) => lib.run(LG, e, { cwd: e.cwd });
const MSG = /acceptance checks are not a worker's to read/;

// a worker subagent, through the lead guard
const worker = as("proteus-backend-worker");
let r = lead(ev("Read", { file_path: CHECK }, worker));
ok("worker: Read of a check is refused, naming why", r.code === 2 && MSG.test(r.err), r.err);
r = lead(ev("Edit", { file_path: CHECK, old_string: "exit 0", new_string: "exit 1" }, worker));
ok("worker: Edit of a check is refused", r.code === 2 && MSG.test(r.err), r.err);
r = lead(ev("Bash", { command: `cat ${JSON.stringify(CHECK)}` }, worker));
ok("worker: a shell command naming the checks dir is refused", r.code === 2 && MSG.test(r.err), r.err);
r = lead(ev("Read", { file_path: SPEC }, worker));
ok("worker: the spec beside the checks is not refused for the holdout", !MSG.test(r.err), r.err);

// a verifier and the acceptance writer pass
for (const t of ["proteus-backend-verifier", "proteus-qa-verifier", "proteus:proteus-acceptance"]) {
  r = lead(ev("Read", { file_path: CHECK }, as(t)));
  ok(`${t}: Read of a check passes`, r.code === 0, r.err);
}

// a worker's own session, through its worktree's guard
const WG = path.join(WT, ".claude", "hooks", "proteus-worker-guard.js");
const own = (tool_name, tool_input) => lib.run(WG, ev(tool_name, tool_input, {}, WT), { cwd: WT });
r = own("Read", { file_path: CHECK });
ok("worker session: Read of a check is refused", r.code === 2 && MSG.test(r.err), r.code + r.err);
r = own("Bash", { command: `ls ${JSON.stringify(CHECKS)}` });
ok("worker session: a shell command naming the checks dir is refused", r.code === 2 && MSG.test(r.err), r.code + r.err);
r = own("Read", { file_path: path.join(WT, "src", "a.js") });
ok("worker session: its own file still reads", r.code === 0, r.err);

// lib: the allowlist and the spec match
ok("lib: holdoutDenial lets the verifier through", hl.holdoutDenial({ tool: "read", agent: "a", agentType: "proteus-verifier", path: CHECK, cwd: REPO }) === null);
ok("lib: specNamed finds the saved spec in a prompt", hl.specNamed(`verifier PR#3 requirement ${SPEC}`, path.join(REPO, ".git")) === SPEC);
ok("lib: specNamed finds no unsaved spec", hl.specNamed(`requirement ${path.join(path.dirname(SPEC), "..", "r9", "spec.md")}`, path.join(REPO, ".git")) === "");

// the spawn guard: a verifier's prompt names the spec
const spawn = (type, prompt, cwd = REPO) => lead(ev("Agent", { model: "opus", subagent_type: type, prompt }, {}, cwd));
r = spawn("proteus-backend-verifier", "Review PR#12.");
ok("spawn: a verifier without the spec path is refused, in one line naming spec.md", r.code === 2 && /names the approved spec/.test(r.err) && /spec\.md/.test(r.err), r.err);
r = spawn("proteus:proteus-security-verifier", "Review PR#12.");
ok("spawn: a plugin-named security verifier without it is refused", r.code === 2 && /names the approved spec/.test(r.err), r.err);
r = spawn("proteus-backend-verifier", `Review PR#12. requirement ${SPEC}`);
ok("spawn: a verifier naming the spec passes", r.code === 0, r.err);
r = spawn("proteus-backend-verifier", `Review PR#12. requirement ${path.join(path.dirname(SPEC), "..", "r9", "spec.md")}`);
ok("spawn: a path to no saved spec is refused", r.code === 2, r.err);
r = spawn("proteus-backend-worker", "worker #5");
ok("spawn: a worker needs no spec", r.code === 0, r.err);
r = spawn("proteus-backend-verifier", "Review PR#12.", WT);
ok("spawn: a linked worktree's verifier without the spec is refused too", r.code === 2 && /names the approved spec/.test(r.err), r.err);

lib.summary();
