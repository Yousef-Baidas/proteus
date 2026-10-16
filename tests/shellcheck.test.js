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
const PY = ["python3", "python"].find((p) => spawnSync(p, ["-c", "print(1)"], { encoding: "utf8" }).status === 0);
const agentFile = path.join(WT1, ".claude", "agents", "x.md");
r = PY ? call(`${PY} -c "open('.claude/agents/x.md','w').write('x')"`, [PY, "-c", "import os; os.makedirs('.claude/agents', exist_ok=True); open('.claude/agents/x.md','w').write('x')"])
  : call("node -e \"...\"", node("require('fs').mkdirSync('.claude/agents',{recursive:true});require('fs').writeFileSync('.claude/agents/x.md','x')"));
ok("interpreter: python -c writing .claude/agents/x.md passes the shell parser", r.pre.code === 0, r.pre.err);
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
r = call("F=.claude/hooks/proteus-worker-guard.js; : > \"$F\"", node("require('fs').writeFileSync('.claude/hooks/proteus-worker-guard.js','')"));
ok("variable: emptying the worker guard through $F is caught", r.pre.code === 0 && r.blocked && r.why.includes(".claude/hooks/proteus-worker-guard.js"), r.why);
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
r = call("git config core.hooksPath /dev/null", ["git", "config", "core.hooksPath", "/dev/null"]);
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
r = call("python3 -c ...", node("require('fs').mkdirSync('.codex/agents',{recursive:true});require('fs').writeFileSync('.codex/agents/x.toml','x')"), { env: cx, who: { agent_id: "c1", agent_type: "proteus-backend-worker" } });
ok("codex: an interpreter write to .codex/agents is caught after the call", r.pre.code === 0 && r.blocked && r.why.includes(".codex/agents/x.toml"), r.pre.err + r.why);

// the guard's own records: deleting one stays on the new record until the lead clears it
const d1 = { who: { agent_id: "d1", agent_type: "proteus-backend-worker" } };
r = call("node -e ...", node("require('fs').writeFileSync('.claude/agents/y.md','x')"), d1);
ok("records: d1's write is recorded", r.blocked && record("agent-d1") && record("agent-d1").open, r.why);
fs.rmSync(path.join(WT1, ".claude", "agents", "y.md"));
r = call("node -e unlink", node(`require('fs').rmSync(${JSON.stringify(path.join(STATE, "tamper", "agent-d1.json"))})`), d1);
ok("records: deleting the guard's record is caught", r.blocked && r.why.includes("tamper/agent-d1.json") && /only the lead clears it/.test(r.why), r.why);
r = call("ls", null, d1);
ok("records: ...and stays open after it is written again", r.blocked && record("agent-d1").open, r.why);

// the lead's own calls are not checked
r = call("node -e ...", node("require('fs').writeFileSync('.claude/agents/lead.md','x')"), { who: {}, cwd: REPO });
ok("lead: the main thread's own shell calls are not checked here", !r.blocked, r.why);

// registration
const claudeH = require(path.join(SRC, "proteus-harness-claude.js")), codexH = require(path.join(SRC, "proteus-harness-codex.js"));
ok("wiring: both adapters register the check on PostToolUse Bash and answer with postBlock",
  [claudeH, codexH].every((h) => h.LEAD_HOOKS.some(([e, s, m]) => e === "PostToolUse" && s === "proteus-shell-check.js" && m === "Bash") && typeof h.postBlock === "function"));

lib.summary();
