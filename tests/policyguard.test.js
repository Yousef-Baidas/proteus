// The policy in the guards (#307): node tests/policyguard.test.js (needs git). The lead guard and the worker guard
// call proteus-policy.js guard after their own checks: a block rule refuses; an ask rule opens the permission dialog
// for the lead's own call on Claude Code and refuses a subagent's, a worker's or a call on Codex with NEEDS; allow and
// no match change nothing; the guards' own refusals stand. The policy's files are refused to every edit and shell
// write (the shell-check catches a write the line hides), an invalid policy file refuses edits and shell writes until
// it is fixed, and `proteus-policy.js write` is the lead's dialog, a refusal with the human's command where no dialog
// can appear, and refused to anyone else. Temp repos under the test's workdir; never touches the network.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("policyguard");
const LG = path.join(SRC, "proteus-lead-guard.js"), SC = path.join(SRC, "proteus-shell-check.js");
const SCRIPT = path.join(SRC, "proteus-policy.js");
const USER = path.join(lib.HOME, ".claude", "proteus-policy.json");
const slash = (p) => p.split(path.sep).join("/");
const q = (p) => `"${slash(p)}"`;

const RULES = [
  { id: "stop-it", effect: "block", tool: "shell", command: "placeholder-block", why: "a placeholder that cannot be undone" },
  { id: "check-it", effect: "ask", tool: "shell", command: "placeholder-ask", why: "a placeholder the human weighs" },
  { id: "fine", effect: "allow", tool: "any", command: "placeholder|push", paths: ["**"], why: "adds nothing" },
  { id: "kept", effect: "block", tool: "edit", paths: ["docs/adr/**", "src/locked/**"], why: "kept as decided" },
  { id: "read-first", effect: "ask", tool: "edit", paths: ["CONTEXT.md", "README.md", "src/gated/**"], why: "the human reads these" },
];
// a repo with a commit; policy: teams/policy.json's text, or none
function repo(name, policy) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  for (const [f, body] of [["src/a.js", "a\n"], ["README.md", "r\n"], ["CONTEXT.md", "c\n"]]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body);
  }
  if (policy !== undefined) { fs.mkdirSync(path.join(d, "teams"), { recursive: true }); fs.writeFileSync(path.join(d, "teams", "policy.json"), policy); }
  g(d, "add", "-A"); g(d, "commit", "-qm", "init");
  return d;
}
const REPO = repo("repo", JSON.stringify({ version: 1, rules: RULES }));
const WT1 = path.join(REPO, ".worktrees", "r1-1"), WT2 = path.join(REPO, ".worktrees", "r1-2");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT1, "main");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/2", WT2, "main");
const WT3 = path.join(REPO, ".worktrees", "r1-3");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/3", WT3, "main");
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT1, "src/**", "dist/**"] });
// WT2 and WT3 (Codex's) own everything: the fixed core still holds
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT2, "**"] });
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT3, "**"], env: { PROTEUS_HARNESS: "codex" } });
ok("setup: the workers' worktrees carry the policy hook",
  fs.existsSync(path.join(WT2, ".claude", "hooks", "proteus-policy.js")) && fs.existsSync(path.join(WT3, ".codex", "hooks", "proteus-policy.js")));

const sub = { agent_id: "a1", agent_type: "proteus-backend-worker" }, helper = { agent_id: "h1", agent_type: "proteus-guide" };
// one PreToolUse: who {} is the lead's own call; codex runs it as Codex
function hook(tool_name, tool_input, { who = {}, mode = "default", cwd = REPO, root = REPO, codex = false, guard = LG, env = {} } = {}) {
  const input = { hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name, tool_input, tool_use_id: `t${Math.random()}`, ...(mode && { permission_mode: mode }), ...who };
  return lib.run(guard, input, { cwd: root, env: { ...(codex && { PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(lib.HOME, ".codex") }), ...env } });
}
const shell = (command, o = {}) => hook("Bash", { command }, o);
const write = (file, o = {}) => o.codex ? hook("apply_patch", { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch` }, o) : hook("Write", { file_path: file, content: "b\n" }, o);
const worker = (wt, codex = false) => ({ guard: path.join(wt, codex ? ".codex" : ".claude", "hooks", "proteus-worker-guard.js"), cwd: wt, root: wt, codex });
const workers = [[WT2, false, "Claude Code"], [WT3, true, "Codex"]];
const decision = (r) => { try { return JSON.parse(r.out).hookSpecificOutput; } catch { return null; } };
const asked = (r) => { const d = decision(r); return r.code === 0 && d && d.permissionDecision === "ask" ? d.permissionDecisionReason : ""; };
const passed = (r) => r.code === 0 && !asked(r);
const refused = (r, re) => r.code === 2 && re.test(r.err);
const NEEDS = /File NEEDS; the lead asks the human/;
const BLOCK = /policy stop-it: a placeholder that cannot be undone/, ASK = /policy check-it: a placeholder the human weighs/;
const cd = (wt) => `cd ${q(wt)} && `;

let r = write(path.join(WT1, "src", "a.js"), { who: sub });
ok("setup: the subagent's first edit binds it to its worktree", r.code === 0, r.err);

// ---- shell: each effect for the lead and a subagent, on Claude Code and on Codex
r = shell("echo placeholder-block");
ok("block: the lead's shell call is refused with the rule's id and why", refused(r, BLOCK), r.out + r.err);
r = shell("echo placeholder-ask");
ok("ask: the lead's own call on Claude Code opens the dialog with the rule's id and why", ASK.test(asked(r)), r.out + r.err);
r = shell("echo placeholder-ask", { mode: "bypassPermissions" });
ok("ask: the lead in a mode with no dialog is refused with NEEDS", refused(r, ASK) && NEEDS.test(r.err), r.out + r.err);
ok("allow: the lead's call an allow rule matches passes untouched", passed(shell("echo placeholder-allow")));
ok("none: the lead's call no rule matches passes untouched", passed(shell("git status")));
for (const [who, name] of [[sub, "a worker subagent"], [helper, "a helper subagent"]]) {
  r = shell(cd(WT1) + "echo placeholder-block", { who });
  ok(`block: ${name}'s shell call is refused`, refused(r, BLOCK), r.err);
  r = shell(cd(WT1) + "echo placeholder-ask", { who });
  ok(`ask: ${name}'s shell call is refused with NEEDS, no dialog`, refused(r, ASK) && NEEDS.test(r.err) && !asked(r), r.out + r.err);
  ok(`allow and none: ${name}'s calls pass`, passed(shell(cd(WT1) + "echo placeholder-allow", { who })) && passed(shell(cd(WT1) + "git status", { who })));
}
r = shell("echo placeholder-block", { codex: true });
ok("block: the lead on Codex is refused", refused(r, BLOCK), r.out + r.err);
r = shell("echo placeholder-ask", { codex: true });
ok("ask: the lead on Codex, with no dialog, is refused with NEEDS", refused(r, ASK) && NEEDS.test(r.err), r.out + r.err);
ok("allow and none: the lead's calls on Codex pass", passed(shell("echo placeholder-allow", { codex: true })) && passed(shell("git status", { codex: true })));
r = shell(cd(WT1) + "echo placeholder-ask", { codex: true, who: { agent_id: "c1", agent_type: "proteus-guide" } });
ok("ask: a subagent on Codex is refused with NEEDS", refused(r, ASK) && NEEDS.test(r.err), r.out + r.err);
r = shell(cd(WT1) + "echo placeholder-block", { codex: true, who: { agent_id: "c1", agent_type: "proteus-guide" } });
ok("block: a subagent on Codex is refused", refused(r, BLOCK), r.out + r.err);
for (const [wt, codex, on] of workers) {
  const o = worker(wt, codex);
  r = shell("echo placeholder-block", o);
  ok(`block: a worker's session on ${on} is refused`, refused(r, BLOCK), r.out + r.err);
  r = shell("echo placeholder-ask", o);
  ok(`ask: a worker's session on ${on} is refused with NEEDS`, refused(r, ASK) && NEEDS.test(r.err), r.out + r.err);
  ok(`allow and none: a worker's calls on ${on} pass`, passed(shell("echo placeholder-allow", o)) && passed(shell("git status", o)));
}

// ---- edits: the path relative to its checkout, judged against the rules' globs
r = write(path.join(REPO, "docs", "adr", "0001-x.md"));
ok("block: the lead's edit of a path a block rule covers is refused", refused(r, /policy kept: kept as decided/), r.err);
r = write(path.join(REPO, "CONTEXT.md"));
ok("ask: the lead's edit of a path an ask rule covers opens the dialog", /policy read-first: the human reads these/.test(asked(r)), r.out + r.err);
r = write(path.join(REPO, "CONTEXT.md"), { codex: true });
ok("ask: the lead's edit on Codex is refused with NEEDS", refused(r, /policy read-first/) && NEEDS.test(r.err), r.out + r.err);
ok("allow: the lead's edit of its own doc an allow rule covers passes", passed(write(path.join(REPO, "AGENTS.md"))));
r = write(path.join(WT1, "src", "locked", "a.js"), { who: sub });
ok("block: a subagent's edit is refused", refused(r, /policy kept/), r.err);
r = write(path.join(WT1, "src", "gated", "a.js"), { who: sub });
ok("ask: a subagent's edit is refused with NEEDS", refused(r, /policy read-first/) && NEEDS.test(r.err), r.out + r.err);
r = write(path.join(WT1, "docs", "adr", "0001-x.md"), { cwd: WT1, root: WT1 });
ok("block: the lead's edit in a session opened in a linked worktree is refused by the main checkout's policy", refused(r, /policy kept/), r.err);
r = write(path.join(WT1, "CONTEXT.md"), { cwd: WT1, root: WT1 });
ok("ask: the lead's edit in a linked worktree opens the dialog", /policy read-first/.test(asked(r)), r.out + r.err);
ok("allow: a subagent's owned edit passes", passed(write(path.join(WT1, "src", "b.js"), { who: sub })));
for (const [wt, codex, on] of workers) {
  const o = worker(wt, codex);
  r = write(path.join(wt, "src", "locked", "a.js"), o);
  ok(`block: a worker's edit on ${on} is refused`, refused(r, /policy kept/), r.out + r.err);
  r = write(path.join(wt, "src", "gated", "a.js"), o);
  ok(`ask: a worker's edit on ${on} is refused with NEEDS`, refused(r, /policy read-first/) && NEEDS.test(r.err), r.out + r.err);
  ok(`allow: a worker's owned edit on ${on} passes`, passed(write(path.join(wt, "src", "b.js"), o)));
}

// ---- the guards' own refusals stand, whatever the policy allows or asks
r = write(path.join(REPO, "src", "a.js"));
ok("own refusal: the lead still does not edit code an allow rule covers", refused(r, /the lead does not edit src\/a\.js/) && !/policy/.test(r.err), r.err);
r = write(path.join(WT1, "README.md"), { who: sub });
ok("own refusal: a subagent's edit outside its owned paths keeps the owned refusal, not the ask", r.code === 2 && /not in/.test(r.err) && !/policy/.test(r.err), r.err);
r = shell(cd(WT1) + "git push --force origin HEAD", { who: sub });
ok("own refusal: a force-push an allow rule matches is still refused", r.code === 2 && /force-push/.test(r.err) && !/policy/.test(r.err), r.err);
r = shell(cd(WT1) + "echo placeholder-ask > ../../.claude/settings.json", { who: sub });
ok("own refusal: a guarded write the policy would ask about keeps the guard's refusal", r.code === 2 && !/policy check-it/.test(r.err), r.err);

// ---- the fixed core: the policy's files, for edits and shell writes
const POLICY = path.join(REPO, "teams", "policy.json"), DOC = path.join(REPO, "teams", "POLICY.md");
const before = fs.readFileSync(POLICY, "utf8");
fs.mkdirSync(path.dirname(USER), { recursive: true });
const CORE = /is the policy, which nobody writes by hand/;
for (const [f, name] of [[POLICY, "teams/policy.json"], [DOC, "teams/POLICY.md"], [USER, "the user file"]]) {
  ok(`core: the lead's edit of ${name} is refused`, write(f).code === 2);
  ok(`core: a subagent's edit of ${name} is refused`, write(f, { who: helper }).code === 2);
}
r = write(USER);
ok("core: the lead's edit of the user file names the write command", refused(r, CORE) && /proteus-policy\.js write/.test(r.err), r.err);
r = write(path.join(WT2, "teams", "policy.json"), worker(WT2));
ok("core: a worker who owns everything still may not edit its worktree's teams/policy.json", refused(r, CORE), r.err);
r = write(path.join(WT2, "teams", "policy.JSON."), worker(WT2));
ok("core: a case or trailing-dot spelling of it is refused too", refused(r, CORE), r.err);
r = write(path.join(WT3, "teams", "POLICY.md"), worker(WT3, true));
ok("core: a worker's patch of teams/POLICY.md on Codex is refused", refused(r, CORE), r.out + r.err);
r = shell("echo x > teams/policy.json");
ok("core: the lead's shell write to teams/policy.json is refused", refused(r, CORE), r.err);
r = shell(`cp README.md ${q(USER)}`);
ok("core: the lead's shell copy onto the user file is refused", refused(r, CORE), r.err);
ok("core: the lead's shell read of the policy passes", passed(shell("cat teams/policy.json")));
for (const [o, name] of [[{ who: sub, cwd: REPO }, "a subagent"], [worker(WT2), "a worker"]]) {
  const pre = o.who ? cd(WT2 === o.cwd ? WT2 : WT1) : "";
  for (const t of ["teams/policy.json", "teams/POLICY.md"]) {
    r = shell(`${pre}echo x > ${t}`, o);
    ok(`core: ${name}'s shell write to ${t} is refused`, r.code === 2 && /teams\/policy\.(json|md)/i.test(r.err), r.err);
  }
  r = shell(`${pre}echo x > ${q(USER)}`, o);
  ok(`core: ${name}'s shell write to the user file is refused`, r.code === 2, r.err);
  r = shell(`${pre}rm -rf teams`, o);
  ok(`core: ${name}'s removal of the dir holding the policy is refused`, r.code === 2, r.err);
}
ok("core: nothing was written", fs.readFileSync(POLICY, "utf8") === before && !fs.existsSync(USER));

// the shell-check: a write the line hides (an interpreter) is caught after the call; its own repo, so the calls above
// (a PreToolUse with no PostToolUse) leave no open flights in it
const SCR = repo("check", JSON.stringify({ version: 1, rules: [] })), SWT = path.join(SCR, ".worktrees", "r1-1");
g(SCR, "worktree", "add", "-q", "-b", "proteus-work/r1/1", SWT, "main");
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: SCR, args: [SWT, "src/**"] });
r = write(path.join(SWT, "src", "a.js"), { who: sub, cwd: SCR, root: SCR });
ok("shell-check setup: the subagent binds to the check repo's worktree", r.code === 0, r.err);
let n = 0;
function hidden(code) {
  const base = { session_id: "s1", cwd: SWT, tool_name: "Bash", tool_input: { command: "npm run build" }, tool_use_id: `toolu_${++n}`, ...sub };
  const pre = lib.run(LG, { hook_event_name: "PreToolUse", ...base }, { cwd: SCR });
  spawnSync(process.execPath, ["-e", code], { cwd: SWT, env: lib.ENV });
  const post = lib.run(SC, { hook_event_name: "PostToolUse", ...base, tool_response: { stdout: "", stderr: "" } }, { cwd: SCR });
  let j = null;
  try { j = JSON.parse(post.out); } catch {}
  return { pre, why: (j && j.decision === "block" && j.reason) || "" };
}
r = hidden("require('fs').writeFileSync('teams/policy.json','{}')");
ok("shell-check: a hidden write to a worktree's teams/policy.json is caught", r.pre.code === 0 && /teams\/policy\.json/.test(r.why), r.pre.err + r.why);
g(SWT, "checkout", "--", "teams/policy.json");
hidden("");
r = hidden(`require('fs').writeFileSync(${JSON.stringify(USER)},'{}')`);
ok("shell-check: a hidden write to the user file is caught", /proteus-policy\.json/.test(r.why), r.why);
fs.rmSync(USER, { force: true });
hidden("");

// ---- proteus-policy.js write
const DRAFT = path.join(W, "draft.json");
fs.writeFileSync(DRAFT, JSON.stringify({ version: 1, preset: "careful", rules: [{ id: "from-draft", effect: "block", tool: "shell", command: "placeholder-draft", why: "the draft's reason" }] }));
const writeCmd = (extra = "", script = SCRIPT, draft = DRAFT) => `node ${q(script)} write ${q(draft)}${extra}`;
r = shell(writeCmd());
let why = asked(r);
ok("write: the lead's own call on Claude Code opens the dialog with the draft rendered and the target",
  why.includes(slash(POLICY)) && /### from-draft/.test(why) && /the draft's reason/.test(why) && /Preset: careful/.test(why), r.out + r.err);
r = shell(writeCmd(" --user"));
ok("write: --user asks too, naming the user file", asked(r).includes(slash(USER)), r.out + r.err);
r = shell(writeCmd(), { codex: true });
ok("write: the lead on Codex is refused with the exact command for the human's terminal",
  r.code === 2 && /none can appear here/.test(r.err) && r.err.includes(`in ${slash(REPO)}: node ${q(SCRIPT)} write ${q(DRAFT)}`), r.out + r.err);
r = shell(writeCmd(), { mode: "dontAsk" });
ok("write: the lead in a mode with no dialog gets the command too", r.code === 2 && r.err.includes(`write ${q(DRAFT)}`), r.out + r.err);
for (const [o, name] of [[{ who: helper }, "a subagent"], [{ who: helper, codex: true }, "a subagent on Codex"], [worker(WT2), "a worker"], [worker(WT3, true), "a worker on Codex"]]) {
  r = shell(writeCmd(), o);
  ok(`write: ${name} is always refused`, refused(r, /a subagent or a worker never runs it/) && NEEDS.test(r.err), r.out + r.err);
}
r = shell(`bash -c ${JSON.stringify(writeCmd())}`, { who: helper });
ok("write: a subagent's write inside sh -c is refused too", refused(r, /never runs it/), r.err);
r = shell(`${writeCmd()} && echo done`);
ok("write: the lead's write with anything else on the line is refused with the one form", refused(r, /run it alone/), r.out + r.err);
const COPY = path.join(W, "copy", "proteus-policy.js");
fs.mkdirSync(path.dirname(COPY), { recursive: true });
fs.copyFileSync(SCRIPT, COPY);
r = shell(writeCmd("", COPY));
ok("write: another copy of the script is refused", refused(r, /only as this install's script/), r.out + r.err);
const BAD = path.join(W, "bad.json");
fs.writeFileSync(BAD, JSON.stringify({ version: 2 }));
r = shell(writeCmd("", SCRIPT, BAD));
ok("write: an invalid draft is refused before the dialog, with its errors", refused(r, /has errors/) && /"version" must be 1/.test(r.err), r.out + r.err);
ok("write: a commit message or echo naming it is no write", passed(shell(`git commit --allow-empty -qm "use proteus-policy.js write"`)) && passed(shell("echo proteus-policy.js write", { who: helper, cwd: WT1 })));
ok("write: asking wrote nothing", fs.readFileSync(POLICY, "utf8") === before && !fs.existsSync(DOC) && !fs.existsSync(USER));

// ---- an invalid policy file refuses edits and shell writes until it is fixed; a missing one is the preset
const INV = repo("invalid", JSON.stringify({ version: 1, rules: [{ id: "Bad Id", effect: "block", tool: "shell", command: "x", why: "y" }] }));
const io = { cwd: INV, root: INV };
r = write(path.join(INV, "CONTEXT.md"), io);
ok("invalid: the lead's edit is refused, naming the file and the first error",
  refused(r, /the policy file .*teams\/policy\.json is invalid \(rule 1 \("Bad Id"\): "id" must be kebab-case/), r.err);
r = shell("echo x > out.txt", io);
ok("invalid: the lead's shell write is refused", refused(r, /is invalid/), r.err);
ok("invalid: a shell call that writes nothing passes", passed(shell("git status", io)));
r = shell(writeCmd(), io);
ok("invalid: proteus-policy.js write itself still reaches the dialog", !!asked(r), r.out + r.err);
r = write(path.join(INV, "src", "a.js"), { ...io, who: helper });
ok("invalid: a subagent's edit is refused", refused(r, /is invalid/), r.err);
r = shell("echo x > out.txt", { ...io, who: helper });
ok("invalid: a subagent's shell write is refused", refused(r, /is invalid/), r.err);
const NONE = repo("none");
ok("missing: no policy file anywhere means the preset; edits and writes pass",
  passed(write(path.join(NONE, "CONTEXT.md"), { cwd: NONE, root: NONE })) && passed(shell("echo x > out.txt", { cwd: NONE, root: NONE })));
fs.writeFileSync(USER, "{ not json");
r = write(path.join(NONE, "CONTEXT.md"), { cwd: NONE, root: NONE });
ok("invalid: a broken user file refuses too, naming it", refused(r, /proteus-policy\.json is invalid \(is not valid JSON/) && /--user/.test(r.err), r.err);
fs.rmSync(USER, { force: true });
ok("invalid: fixed, the edit passes again", passed(write(path.join(NONE, "CONTEXT.md"), { cwd: NONE, root: NONE })));

lib.summary();
