// A subagent's shell, #48 part B layer 2: node tests/shellcheck.test.js (needs git). The guards fingerprint the
// guarded paths before each subagent shell call and proteus-shell-check.js compares after it, so a write the
// command line hides (an interpreter, a variable) is caught: the call is answered with a block naming the paths,
// recorded until they are put back, and proteus-signoff.js refuses MERGE on that branch meanwhile.
// Temp repo with a local bare remote; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("shellcheck");
const slash = (p) => p.split(path.sep).join("/");

const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
for (const [f, body] of [["src/a.js", "a\n"], [".github/workflows/ci.yml", "on: push\n"], [".gitignore", "dist/\n"]]) {
  fs.mkdirSync(path.dirname(path.join(REPO, f)), { recursive: true });
  fs.writeFileSync(path.join(REPO, f), body);
}
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE);
g(REPO, "push", "-q", "-u", "origin", "main");
const WT1 = path.join(REPO, ".worktrees", "r1-1"), WT2 = path.join(REPO, ".worktrees", "r1-2");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT1, "main");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/2", WT2, "main");
for (const wt of [WT1, WT2]) lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [wt, "src/**", "dist/**"] });
const STATE = path.join(REPO, ".git", "proteus");

const LG = path.join(SRC, "proteus-lead-guard.js"), SC = path.join(SRC, "proteus-shell-check.js");
const sub = { agent_id: "a1", agent_type: "proteus-backend-worker" };
const bind = lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Write", tool_input: { file_path: path.join(WT1, "src", "a.js"), content: "a\n" }, ...sub }, { cwd: REPO });
ok("setup: a1 bound to its worktree", bind.code === 0, bind.err);

// one shell call: the guard's PreToolUse, the command itself (argv, no shell), the PostToolUse check
let n = 0;
function call(command, argv, { who = sub, cwd = WT1, guard = LG, check = SC, root = REPO, env = {}, session = "s1" } = {}) {
  const base = { session_id: session, cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_${++n}`, ...who };
  const pre = lib.run(guard, { hook_event_name: "PreToolUse", ...base }, { cwd: root, env });
  if (pre.code !== 0) return { pre, blocked: false, why: "", denied: true };
  if (argv) spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: { ...lib.ENV, ...env } });
  const post = lib.run(check, { hook_event_name: "PostToolUse", ...base, tool_response: { stdout: "", stderr: "" } }, { cwd: root, env });
  let j = null;
  try { j = JSON.parse(post.out); } catch {}
  return { pre, post, blocked: !!(j && j.decision === "block"), why: (j && j.reason) || "", ms: pre.ms + post.ms };
}
const node = (code) => [process.execPath, "-e", code];
const record = (key = "agent-a1") => { try { return JSON.parse(fs.readFileSync(path.join(STATE, "tamper", `${key}.json`), "utf8")); } catch { return null; } };

// a normal build: owned paths, ignored output, a commit in the agent's own worktree
let r = call("npm run build", node("const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.js','x');fs.writeFileSync('src/a.js','b\\n')"));
ok("build: writes to owned and ignored paths pass", r.pre.code === 0 && !r.blocked && !r.post.out.trim(), r.post && r.post.out);
r = call("git commit -qam work", ["git", "commit", "-qam", "work"]);
ok("build: a commit of owned work in the agent's own worktree passes", !r.blocked, r.why);
ok("build: no record for a clean agent", record() === null);
const WT3 = path.join(REPO, ".worktrees", "r1-3");
r = call("(the lead adds a worktree meanwhile)", ["git", "-C", REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/3", WT3, "main"]);
ok("build: a worktree the lead adds during the call is not a violation", !r.blocked && fs.existsSync(path.join(WT3, ".git")), r.why);
r = call("(the lead removes it meanwhile)", ["git", "-C", REPO, "worktree", "remove", "--force", WT3]);
ok("build: ...nor one it removes", !r.blocked && !fs.existsSync(WT3), r.why);

// an interpreter writing an agent definition
// looked up on the PATH the call runs with (lib.ENV's, stripped), not the test's own
const PY = ["python3", "python"].find((p) => spawnSync(p, ["-c", "print(1)"], { encoding: "utf8", env: lib.ENV }).status === 0);
const agentFile = path.join(WT1, ".claude", "agents", "x.md");
// the command line names no path (a script on disk), so the shell guard has nothing to judge (#48's residual)
r = PY ? call(`${PY} tools/gen.py`, [PY, "-c", "import os; os.makedirs('.claude/agents', exist_ok=True); open('.claude/agents/x.md','w').write('x')"])
  : call("node tools/gen.js", node("require('fs').mkdirSync('.claude/agents',{recursive:true});require('fs').writeFileSync('.claude/agents/x.md','x')"));
ok("interpreter: a script writing .claude/agents/x.md passes the shell parser", r.pre.code === 0, r.pre.err);
ok("interpreter: ...and the write happened", fs.existsSync(agentFile), PY || "node");
ok("interpreter: ...and is caught after the call, naming the path", r.blocked && r.why.includes(slash(agentFile)) && /Put each back/.test(r.why), r.why);
let t = record();
ok("interpreter: a record names the agent, its branch and the path", t && t.open && t.branch === "proteus-work/r1/1" && t.items.some((i) => i.path === agentFile && i.before === null), JSON.stringify(t));
r = call("ls", null);
ok("interpreter: the next call blocks again while it is not put back", r.blocked && /still differ/.test(r.why), r.why);

// signoff refuses MERGE on that branch meanwhile
const PR = path.join(W, "pr.json"), HEAD = "a".repeat(40);
fs.writeFileSync(PR, JSON.stringify({ head: HEAD, branch: "proteus-work/r1/1", files: [], statuses: {} }));
const sign = (word) => lib.run(path.join(SRC, "proteus-signoff.js"), "", { cwd: WT1, args: ["5", HEAD, word], env: { FAKE_GH_PR: PR } });
let s = sign("MERGE");
ok("signoff: MERGE refused while the head branch has an open record, naming it and the path", s.code === 1 && /open guard-violation record/.test(s.err) && s.err.includes("proteus-work/r1/1") && s.err.includes(".claude/agents/x.md") && !JSON.parse(fs.readFileSync(PR, "utf8")).statuses[HEAD], s.err);
ok("signoff: BACK-TO-WORKER still posts", sign("BACK-TO-WORKER").code === 0);
fs.writeFileSync(PR, JSON.stringify({ head: HEAD, branch: "proteus-work/r1/2", files: [], statuses: {} }));
ok("signoff: MERGE on another branch is not refused for it", sign("MERGE").code === 0);
fs.writeFileSync(PR, JSON.stringify({ head: HEAD, branch: "proteus-work/r1/1", files: [], statuses: {} }));

ok("restore: Layer 1 refuses rm on the guarded path itself", call("rm .claude/agents/x.md", null).denied);
r = call("node -e ...", node("require('fs').rmSync('.claude/agents/x.md')"));
ok("restore: putting it back passes and closes the record", !r.blocked && record() && record().open === false, r.why + JSON.stringify(record()));
ok("signoff: MERGE passes once the paths are back", sign("MERGE").code === 0);

// node -e writing into a sibling worktree
r = call("node -e ...", node(`require('fs').writeFileSync(${JSON.stringify(path.join(WT2, "src", "evil.js"))}, 'x')`));
ok("sibling: node -e writing into another worker's idle worktree is caught", r.pre.code === 0 && r.blocked && r.why.includes(slash(WT2)) && r.why.includes("src/evil.js"), r.why);
r = call("node -e ...", node(`require('fs').rmSync(${JSON.stringify(path.join(WT2, "src", "evil.js"))})`));
ok("sibling: removing it again passes", !r.blocked, r.why);
// a sibling whose own agent is working is left to that agent
fs.writeFileSync(path.join(STATE, "agents", "agent-b2"), WT2);
fs.mkdirSync(path.join(STATE, "beats"), { recursive: true });
fs.writeFileSync(path.join(STATE, "beats", "b2.json"), JSON.stringify({ agent: "b2", last: new Date(Date.now() + 60e3).toISOString() }));
r = call("node -e ...", node(`require('fs').writeFileSync(${JSON.stringify(path.join(WT2, "src", "own.js"))}, 'x')`));
ok("sibling: a change in a worktree whose agent is active is left to it", !r.blocked, r.why);
fs.rmSync(path.join(WT2, "src", "own.js"));
fs.rmSync(path.join(STATE, "beats", "b2.json"));

// a variable and a hook copy in the worktree
r = call("sh tools/reset.sh", node("require('fs').writeFileSync('.claude/hooks/proteus-worker-guard.js','')"));
ok("variable: emptying the worker guard from a script is caught", r.pre.code === 0 && r.blocked && r.why.includes(".claude/hooks/proteus-worker-guard.js"), r.why);
fs.copyFileSync(path.join(SRC, "proteus-worker-guard.js"), path.join(WT1, ".claude", "hooks", "proteus-worker-guard.js"));
r = call("ls", null);
ok("variable: the restored copy passes", !r.blocked, r.why);

// git: a workflow change merged from the protected main passes; one the agent commits is caught
fs.writeFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "on: [push]\n");
g(REPO, "commit", "-qam", "ci on main"); g(REPO, "push", "-q", "origin", "main");
r = call("git merge origin/main", ["git", "merge", "-q", "--no-edit", "origin/main"]);
ok("git: merging a workflow change from origin/main passes", !r.blocked && fs.readFileSync(path.join(WT1, ".github", "workflows", "ci.yml"), "utf8") === "on: [push]\n", r.why);
// written by an interpreter and committed past the owned-paths hook, as git -c core.hooksPath= would
r = call("node -e ...", node("require('fs').writeFileSync('.github/workflows/ci.yml','on: never\\n');require('child_process').execFileSync('git',['commit','-qnam','evil ci'])"));
ok("git: a workflow change the agent commits is caught", r.blocked && r.why.includes(".github/workflows/ci.yml"), r.why);
r = call("git revert HEAD", ["git", "revert", "--no-edit", "HEAD"]);
ok("git: reverting it passes and closes the record", !r.blocked && record().open === false, r.why);

// the shared git dir and the guard's own records
r = call("node -e ... .git/hooks", node(`require('fs').writeFileSync(${JSON.stringify(path.join(REPO, ".git", "hooks", "pre-push"))}, 'exit 0')`));
ok("git dir: a hook written into the shared .git/hooks is caught", r.blocked && r.why.includes(".git/hooks/pre-push"), r.why);
fs.rmSync(path.join(REPO, ".git", "hooks", "pre-push"));
// a script on disk sets it: the pre-check refuses a worker's own git config core.hooksPath (#48 F8)
r = call("sh tools/setup.sh", ["git", "config", "core.hooksPath", "/dev/null"]);
ok("git dir: core.hooksPath set in the shared config is caught", r.blocked && r.why.includes(".git/config"), r.why);
g(WT1, "config", "--unset", "core.hooksPath");
r = call("git push -u origin proteus-work/r1/1", ["git", "push", "-q", "-u", "origin", "proteus-work/r1/1"]);
ok("git dir: a push -u (branch section of the config) passes, and the earlier change is back", !r.blocked && record().open === false, r.why);

// the home: the CLIs' own settings
const HS = path.join(lib.HOME, ".claude", "settings.json");
fs.writeFileSync(HS, JSON.stringify({ permissions: { allow: [] } }));
r = call("ls", null);
r = call("node -e ... ~/.claude/settings.json", node(`require('fs').writeFileSync(${JSON.stringify(HS)}, JSON.stringify({ hooks: {} }))`));
ok("home: rewriting ~/.claude/settings.json is caught", r.blocked && r.why.includes(".claude/settings.json"), r.why);
fs.writeFileSync(HS, JSON.stringify({ permissions: { allow: [] } }));
r = call("ls", null);
ok("home: put back, it passes", !r.blocked, r.why);
r = call("touch", node(`require('fs').writeFileSync(${JSON.stringify(HS)}, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }))`));
ok("home: a permissions change alone (the human approving a tool) is not a violation", !r.blocked, r.why);

// a worker session opened inside the worktree: its own guard and check
const WG = path.join(WT1, ".claude", "hooks", "proteus-worker-guard.js"), WC = path.join(WT1, ".claude", "hooks", "proteus-shell-check.js");
ok("worker: the worktree carries the check", fs.existsSync(WC) && JSON.stringify(JSON.parse(fs.readFileSync(path.join(WT1, ".claude", "settings.local.json"), "utf8")).hooks.PostToolUse).includes("proteus-shell-check.js"));
const ws = { who: {}, guard: WG, check: WC, root: WT1, session: "s2" };
r = call("node -e ...", node("require('fs').appendFileSync('.claude/proteus-owned','\\n**')"), ws);
ok("worker: a worker session's interpreter write to its owned list is caught", r.pre.code === 0 && r.blocked && r.why.includes(".claude/proteus-owned"), r.why);
const owned = fs.readFileSync(path.join(WT1, ".claude", "proteus-owned"), "utf8").replace(/\n\*\*$/, "");
fs.writeFileSync(path.join(WT1, ".claude", "proteus-owned"), owned);
r = call("ls", null, ws);
ok("worker: put back, it passes; owned work too", !r.blocked && !call("node -e ...", node("require('fs').writeFileSync('src/w.js','x')"), ws).blocked, r.why);

// Codex: the same check through its adapter
const cx = { PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(lib.HOME, ".codex") };
r = call("python3 tools/gen.py", node("require('fs').mkdirSync('.codex/agents',{recursive:true});require('fs').writeFileSync('.codex/agents/x.toml','x')"), { env: cx, who: { agent_id: "c1", agent_type: "proteus-backend-worker" } });
ok("codex: an interpreter write to .codex/agents is caught after the call", r.pre.code === 0 && r.blocked && r.why.includes(".codex/agents/x.toml"), r.pre.err + r.why);

// the guard's own records: deleting one stays on the new record until the lead clears it
const d1 = { who: { agent_id: "d1", agent_type: "proteus-backend-worker" } };
r = call("node -e ...", node("require('fs').mkdirSync('.claude/agents',{recursive:true});require('fs').writeFileSync('.claude/agents/y.md','x')"), d1);
ok("records: d1's write is recorded", r.blocked && record("agent-d1") && record("agent-d1").open, r.why);
fs.rmSync(path.join(WT1, ".claude", "agents", "y.md"), { force: true });
r = call("node -e unlink", node(`require('fs').rmSync(${JSON.stringify(path.join(STATE, "tamper", "agent-d1.json"))})`), d1);
ok("records: deleting the guard's record is caught", r.blocked && r.why.includes("tamper/agent-d1.json") && /only the lead clears it/.test(r.why), r.why);
r = call("ls", null, d1);
ok("records: ...and stays open after it is written again", r.blocked && record("agent-d1").open, r.why);

// git config: compared by key; identity, colours and the agent's own branch's upstream pass, the rest is caught
const gitc = (...a) => node(`require('child_process').execFileSync('git',${JSON.stringify(["config", ...a])})`);
r = call("git config user.email x", gitc("user.email", "x@example.com"));
ok("config: git config user.email passes", !r.blocked, r.why);
r = call("git branch --set-upstream-to=origin/main", ["git", "branch", "--set-upstream-to=origin/main"]);
ok("config: setting the agent's own branch's upstream passes", !r.blocked && g(WT1, "config", "branch.proteus-work/r1/1.merge") === "refs/heads/main", r.why);
for (const [what, key, val] of [
  ["alias.p", "alias.p", "push --force"],
  ["remote.origin.push", "remote.origin.push", "+refs/heads/*:refs/heads/main"],
  ["includeIf", "includeIf.gitdir:/x/.path", path.join(W, "evil.cfg")],
  ["the upstream of a branch no worktree has out", "branch.release.remote", "origin"],
  ["a pushRemote other than the branch's remote", "branch.proteus-work/r1/1.pushRemote", "elsewhere"],
]) {
  r = call("node -e ...", gitc(key, val)); // past Layer 1, which reads the command line
  ok(`config: ${what} is caught, naming the key`, r.blocked && r.why.includes(".git/config") && r.why.toLowerCase().includes(key.toLowerCase()), r.why);
  r = call(`git config --unset ${key}`, gitc("--unset", key));
  ok(`config: ...unsetting it again passes and closes the record`, !r.blocked && record().open === false, r.why + JSON.stringify(record()));
}
// #172: a worker whose brief named a worktree the lead never prepared (no owned list, no binding) runs in it;
// its push -u is its own branch's upstream, the same keys for a branch no worktree has out are not
const WT5 = path.join(REPO, ".worktrees", "s5");
g(REPO, "worktree", "add", "-q", "-b", "fix/s5", WT5, "main");
const e1 = { who: { agent_id: "e1", agent_type: "proteus-worker" }, cwd: WT5 };
r = call("git push -u origin fix/s5", ["git", "push", "-q", "-u", "origin", "fix/s5"], e1);
ok("config: push -u from an unprepared worktree leaves no record", r.pre.code === 0 && !r.blocked && record("agent-e1") === null && g(WT5, "config", "branch.fix/s5.merge") === "refs/heads/fix/s5", r.pre.err + r.why);
r = call("git branch --set-upstream-to=origin/main", ["git", "branch", "--set-upstream-to=origin/main"], e1);
ok("config: ...nor does --set-upstream-to on that branch", !r.blocked && record("agent-e1") === null, r.why);
// Layer 1 refuses an interpreter here (no prepared worktree), so the command line names none: a script on disk
r = call("sh tools/track.sh", ["git", "config", "branch.release.merge", "refs/heads/main"], e1);
ok("config: ...while another branch's merge key is caught, naming it", r.blocked && record("agent-e1") && record("agent-e1").open && r.why.includes("branch.release.merge"), r.why + r.pre.err);
r = call("sh tools/untrack.sh", ["git", "config", "--unset", "branch.release.merge"], e1);
ok("config: ...unsetting it again passes and closes the record", !r.blocked && record("agent-e1").open === false, r.why);

// #178: a build worker whose first call is a shell one, from the main checkout (a subagent's cwd resets there), is
// bound to the one prepared worktree its brief names; a sibling's stays refused, and a brief naming two binds none
const WT6 = path.join(REPO, ".worktrees", "r1-6");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/6", WT6, "main");
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT6, "src/**"] });
const briefOf = (id, text) => {
  const f = path.join(W, `brief-${id}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  return { who: { agent_id: id, agent_type: "proteus-devops-worker", agent_transcript_path: f }, cwd: REPO };
};
const lock = path.join(WT6, "package-lock.json");
const f1 = briefOf("f1", `Ticket #67, worktree ${WT6}. Add the font dependency.`);
r = call("npm install", node(`require('fs').writeFileSync(${JSON.stringify(lock)}, '{}')`), f1);
ok("brief bind: a first shell call changing the brief's worktree is not refused", r.pre.code === 0 && !r.blocked && record("agent-f1") === null, r.pre.err + r.why);
ok("brief bind: ...and binds the agent to it", fs.existsSync(path.join(STATE, "agents", "agent-f1")) && fs.readFileSync(path.join(STATE, "agents", "agent-f1"), "utf8").trim() === WT6);
r = call("sh tools/x.sh", node(`require('fs').writeFileSync(${JSON.stringify(path.join(WT2, "src", "f1.js"))}, 'x')`), f1);
ok("brief bind: ...while a change to a sibling worktree is still refused", r.blocked && r.why.includes(slash(WT2)), r.why);
r = call("sh tools/undo.sh", node(`require('fs').rmSync(${JSON.stringify(path.join(WT2, "src", "f1.js"))})`), f1);
ok("brief bind: ...removing it again passes", !r.blocked && record("agent-f1").open === false, r.why);
fs.rmSync(lock);
const f2 = briefOf("f2", `Contracts: worktree ${WT6} for #67, worktree ${WT2} for #68.`);
r = call("npm install", node(`require('fs').writeFileSync(${JSON.stringify(lock)}, '{}')`), f2);
ok("brief bind: a brief naming two worktrees binds none, as before", r.blocked && r.why.includes(slash(WT6)) && !fs.existsSync(path.join(STATE, "agents", "agent-f2")), r.why);
r = call("sh tools/undo.sh", node(`require('fs').rmSync(${JSON.stringify(lock)})`), f2);
ok("brief bind: ...removing it again passes", !r.blocked && record("agent-f2").open === false, r.why);

// the lead's own shell calls: what changes while one overlaps an agent's call is a notice to the lead, not a block
let m = 0;
const evOf = (who, cwd, command) => ({ session_id: "s1", cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_lead${++m}`, ...who });
const pre = (b) => lib.run(LG, { hook_event_name: "PreToolUse", ...b }, { cwd: REPO });
const post = (b) => {
  const p = lib.run(SC, { hook_event_name: "PostToolUse", ...b, tool_response: { stdout: "", stderr: "" } }, { cwd: REPO });
  let j = null;
  try { j = JSON.parse(p.out); } catch {}
  return { blocked: !!(j && j.decision === "block"), why: (j && j.reason) || "", ctx: (j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || "" };
};
const prepare = (wt, ...owned) => lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [wt, ...owned] });
const notices = () => { try { return fs.readdirSync(path.join(STATE, "unattributed")); } catch { return []; } };
const ownedWT2 = slash(path.join(WT2, ".claude", "proteus-owned"));
let a = evOf(sub, WT1, "npm test"), l = evOf({}, REPO, "node .claude/hooks/proteus-worktree.js .worktrees/r1-2 ...");
pre(a); pre(l);
prepare(WT2, "src/**", "dist/**", "lib/**");
let lp = post(l), ap = post(a);
ok("lead: proteus-worktree.js run by the lead during an agent's call does not block the agent", !lp.blocked && !ap.blocked && record().open === false, ap.why);
ok("lead: ...the lead is shown a notice naming the agent and the path, and how to clear it", lp.ctx.includes(ownedWT2) && lp.ctx.includes("a1") && /--clear \d+/.test(lp.ctx) && notices().length === 1, lp.ctx);
a = evOf(sub, WT1, "npm test"); l = evOf({}, REPO, "node .claude/hooks/proteus-worktree.js .worktrees/r1-2 ...");
pre(a); pre(l);
prepare(WT2, "src/**", "dist/**");
ap = post(a); lp = post(l);
ok("lead: ...also when the agent's call ends first, while the lead's still runs", !ap.blocked && record().open === false && lp.ctx.includes(ownedWT2) && notices().length === 2, ap.why + lp.ctx);
ok("lead: a notice is shown once", !post(evOf({}, REPO, "ls")).ctx, "");
const listed = lib.run(SC, "", { cwd: REPO, args: ["--list"] });
ok("lead: --list prints the notices", listed.code === 0 && listed.out.includes(ownedWT2), listed.out + listed.err);
// the notices name r1-2's paths; its branch has no record of its own
fs.writeFileSync(PR, JSON.stringify({ head: HEAD, branch: "proteus-work/r1/2", files: [], statuses: {} }));
s = sign("MERGE");
ok("lead: signoff does not refuse on a notice", s.code === 0, s.err);
fs.writeFileSync(PR, JSON.stringify({ head: HEAD, branch: "proteus-work/r1/1", files: [], statuses: {} }));
const cleared = lib.run(SC, "", { cwd: REPO, args: ["--clear", "all"] });
ok("lead: --clear all removes them", cleared.code === 0 && notices().length === 0, cleared.out + cleared.err);
r = call("node -e ...", node("require('fs').writeFileSync('.claude/agents/z.md','x')"));
ok("lead: an agent write with no lead call overlapping still blocks", r.blocked && r.why.includes(".claude/agents/z.md"), r.why);
r = call("node -e ...", node("require('fs').rmSync('.claude/agents/z.md')"));
ok("lead: ...and passes once put back", !r.blocked && record().open === false, r.why);
// re-baseline: a path on an open record that the lead's call then rewrites takes the lead's state as its state before
r = call("node -e ...", node("require('fs').appendFileSync('.claude/proteus-owned','\\n**')"));
ok("lead: an agent's write to its owned list is recorded", r.blocked && record().open, r.why);
r = call("node .claude/hooks/proteus-worktree.js .worktrees/r1-1 ...", [process.execPath, path.join(SRC, "proteus-worktree.js"), WT1, "src/**", "dist/**", "lib/**"], { who: {}, cwd: REPO, env: { CLAUDE_PROJECT_DIR: REPO } });
ok("lead: ...the lead re-prepares the worktree with a new list", !r.blocked && /lib\/\*\*/.test(fs.readFileSync(path.join(WT1, ".claude", "proteus-owned"), "utf8")), r.why);
r = call("ls", null);
ok("lead: ...and the agent's next call is not blocked on the lead's change", !r.blocked && record().open === false, r.why + JSON.stringify(record()));

// #164: Claude Code's .in_use markers in the plugin cache are not the agent's doing; the plugin's own files still are
{
  const CFG = path.join(W, "claude-config"), PLUG = path.join(CFG, "plugins", "cache", "proteus", "proteus", "abc123");
  const HOOK = path.join(PLUG, "templates", "hooks", "proteus-lib.js");
  fs.mkdirSync(path.dirname(HOOK), { recursive: true });
  fs.writeFileSync(HOOK, "lib\n");
  const env = { CLAUDE_CONFIG_DIR: CFG, CLAUDE_PLUGIN_ROOT: PLUG };
  const js = (s) => JSON.stringify(s);
  r = call("npm run lint", node(`const fs=require('fs');fs.mkdirSync(${js(path.join(PLUG, ".in_use"))},{recursive:true});fs.writeFileSync(${js(path.join(PLUG, ".in_use", "4242"))},'')`), { env });
  ok("plugin cache: a new .in_use marker under the plugin's version dir is not reported", r.pre.code === 0 && !r.blocked, r.why);
  r = call("npm test", node(`require('fs').rmSync(${js(path.join(PLUG, ".in_use", "4242"))})`), { env });
  ok("plugin cache: ...nor one removed", !r.blocked, r.why);
  r = call("npm test", node(`require('fs').writeFileSync(${js(HOOK)},'changed\\n')`), { env });
  ok("plugin cache: a change to a plugin file in the same cache is still reported", r.blocked && r.why.includes(slash(fs.realpathSync(HOOK))), r.why);
  r = call("git checkout", node(`require('fs').writeFileSync(${js(HOOK)},'lib\\n')`), { env });
  ok("plugin cache: ...and passes once put back", !r.blocked && record().open === false, r.why);
}

// the lead's own calls are not checked
r = call("node -e ...", node("require('fs').writeFileSync('.claude/agents/lead.md','x')"), { who: {}, cwd: REPO });
ok("lead: the main thread's own shell calls are not checked here", !r.blocked, r.why);

// #182: what another agent's push -u or the removal of a worktree changes is no change of this agent's, and a
// record whose agent has ended stops refusing MERGE once its paths are back or explained
r = call("npm test", ["git", "-C", WT2, "push", "-q", "-u", "origin", "proteus-work/r1/2"]);
ok("#182 tracking: ticket B's push -u during ticket A's call is not flagged on A", r.pre.code === 0 && !r.blocked && g(REPO, "config", "branch.proteus-work/r1/2.merge") === "refs/heads/proteus-work/r1/2" && record().open === false, r.why);
r = call("npm test", gitc("branch.proteus-work/r1/9.remote", "origin"));
ok("#182 tracking: ...nor a work branch no worktree has out", !r.blocked, r.why);
r = call("npm test", gitc("branch.proteus-work/r1/9.pushRemote", "elsewhere"));
ok("#182 tracking: ...while its pushRemote elsewhere is still caught", r.blocked && r.why.includes("branch.proteus-work/r1/9.pushremote"), r.why);
r = call("npm test", gitc("--unset", "branch.proteus-work/r1/9.pushRemote"));
ok("#182 tracking: ...and passes once unset", !r.blocked && record().open === false, r.why);
const SCR = path.join(W, "proteus-scratch", "r1-106-broken");
g(REPO, "worktree", "add", "-q", "--detach", SCR, "main");
g(REPO, "config", "extensions.worktreeConfig", "true");
g(SCR, "config", "--worktree", "core.hooksPath", "/dev/null");
const scrCfg = path.join(fs.realpathSync(path.join(REPO, ".git")), "worktrees", "r1-106-broken", "config.worktree");
ok("setup: the scratch worktree has a config.worktree", fs.existsSync(scrCfg));
r = call("node tools/clean.js", node(`require('fs').rmSync(${JSON.stringify(SCR)},{recursive:true,force:true});require('child_process').execFileSync('git',['-C',${JSON.stringify(REPO)},'worktree','prune'])`));
ok("#182 scratch: a deleted and pruned worktree's config.worktree is not flagged", r.pre.code === 0 && !r.blocked && !fs.existsSync(scrCfg) && record().open === false, r.why + r.pre.err);

// a contracts agent with no worktree of its own runs from the main checkout, on the lead's docs branch
g(REPO, "checkout", "-q", "-b", "proteus-work/r1/lead-docs");
const k1 = { who: { agent_id: "k1", agent_type: "proteus-worker" }, cwd: REPO };
r = call("sh tools/x.sh", node("require('fs').mkdirSync('.claude/agents',{recursive:true});require('fs').writeFileSync('.claude/agents/k1.md','x')"), k1);
ok("#182 keying: an agent without a worktree is still blocked", r.pre.code === 0 && r.blocked && r.why.includes(".claude/agents/k1.md"), r.why + r.pre.err);
ok("#182 keying: ...but its record is not keyed by the main checkout's branch", record("agent-k1") && record("agent-k1").open && record("agent-k1").branch === "", JSON.stringify(record("agent-k1")));
fs.writeFileSync(PR, JSON.stringify({ head: HEAD, branch: "proteus-work/r1/lead-docs", files: [], statuses: {} }));
s = sign("MERGE");
ok("#182 keying: ...so a lead-docs MERGE is not refused for it", s.code === 0, s.err);
r = call("sh tools/undo.sh", node("require('fs').rmSync('.claude/agents/k1.md')"), k1);
ok("#182 keying: ...and it closes once put back", !r.blocked && record("agent-k1").open === false, r.why);

// a record from before the fix, of an agent that has ended: filed under lead-docs, B's tracking key and the scratch
// worktree's config.worktree on it. The signoff re-checks it and finds both explained
const mainCfg = path.join(fs.realpathSync(path.join(REPO, ".git")), "config");
g(REPO, "config", "branch.proteus-work/r1/105.remote", "origin");
g(REPO, "config", "branch.proteus-work/r1/105.merge", "refs/heads/proteus-work/r1/105");
const old = { key: "agent-old", agent: "old", session: "s0", worktree: fs.realpathSync(REPO), branch: "proteus-work/r1/lead-docs", open: true, at: new Date().toISOString(), history: [],
  items: [
    { kind: "path", path: scrCfg, before: 'c:[["core.hookspath","/dev/null"]]', keys: { "core.hookspath": "/dev/null" } },
    { kind: "path", path: mainCfg, before: "c:[]", keys: { "branch.proteus-work/r1/105.remote": null, "branch.proteus-work/r1/105.merge": null } },
  ] };
fs.writeFileSync(path.join(STATE, "tamper", "agent-old.json"), JSON.stringify(old));
s = sign("MERGE");
ok("#182 re-check: an ended agent's record whose paths are all explained does not refuse MERGE", s.code === 0, s.err);
old.items[1].keys["branch.release.merge"] = null;
fs.writeFileSync(path.join(STATE, "tamper", "agent-old.json"), JSON.stringify(old));
g(REPO, "config", "branch.release.merge", "refs/heads/release");
s = sign("MERGE");
ok("#182 re-check: ...one with a key still changed does, naming the file", s.code === 1 && /open guard-violation record/.test(s.err) && s.err.includes(slash(mainCfg)), s.err);
g(REPO, "config", "--unset", "branch.release.merge");
s = sign("MERGE");
ok("#182 re-check: ...until the key is put back by hand, with no call of that agent", s.code === 0, s.err);

// registration
const claudeH = require(path.join(SRC, "proteus-harness-claude.js")), codexH = require(path.join(SRC, "proteus-harness-codex.js"));
ok("wiring: both adapters register the check on PostToolUse Bash and answer with postBlock",
  [claudeH, codexH].every((h) => h.LEAD_HOOKS.some(([e, s, m]) => e === "PostToolUse" && s === "proteus-shell-check.js" && m === "Bash") && typeof h.postBlock === "function"));

lib.summary();
