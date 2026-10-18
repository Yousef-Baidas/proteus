// The human's verdict post (#157): node tests/humanpost.test.js. The lead guard asks the human before
// `proteus-verdict.js <issue> --post --body-file <f> --sha <h>` from the main session, denies it where no permission
// dialog can appear (with the command for the human's own terminal) and for subagents, teammates and workers, and
// keeps every agent away from the human's gh login; --post itself checks the hash, the first line, the login and
// the labels, and posts under the human's gh config. tests/fakegh.js holds the issues; never touches the network.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run, g, summary } = lib;

const HOOKS = path.join(__dirname, "..", "templates", "hooks");
const LG = path.join(HOOKS, "proteus-lead-guard.js");
const WG = path.join(HOOKS, "proteus-worker-guard.js");
const VD = path.join(HOOKS, "proteus-verdict.js");
const W = lib.workdir("humanpost");
const HOME = lib.HOME;
const PJ = path.join(HOME, ".claude", "proteus.json");
const BOT = path.join(HOME, ".config", "gh-proteus");
const HUMAN_GH = path.join(HOME, ".config", "gh");
const ISSUES = path.join(W, "issues.json");
const REPO = path.join(W, "repo");
fs.mkdirSync(REPO);
g(REPO, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
for (const [d, login] of [[BOT, "bot"], [HUMAN_GH, "human"]]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "hosts.yml"), login); }
const config = (o) => fs.writeFileSync(PJ, JSON.stringify(o));
config({ agentGh: BOT, human: "human" });
const issues = (o) => fs.writeFileSync(ISSUES, JSON.stringify(o || {
  30: { title: "Review: m1", labels: ["proteus-review", "needs-human"], comments: [] },
  31: { title: "Fix the thing", labels: ["bug"], comments: [] },
}));
const comments = (n) => JSON.parse(fs.readFileSync(ISSUES, "utf8"))[n].comments;
issues();
// a claude that cannot say its version: auto mode then has none to check
lib.fakeCli(lib.BIN, "claude", "process.exit(1);");

const BODY = path.join(W, "verdict.txt");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
fs.writeFileSync(BODY, "ACCEPT\nThe lighting reads well.\n");
const SHA = sha(BODY);
const q = (p) => `"${p.split(path.sep).join("/")}"`;
const postCmd = (n = 30, f = BODY, h = SHA) => `node ${q(VD)} ${n} --post --body-file ${q(f)}${h ? ` --sha ${h}` : ""}`;
// the agents' env: their own gh config, and the session the human opened for review
const env = (extra = {}) => ({ GH_CONFIG_DIR: BOT, FAKE_GH_ISSUES: ISSUES, PROTEUS: "0", ...extra });
const hook = (command, { mode = "default", input = {}, cwd = REPO, script = LG, ...extra } = {}) =>
  run(script, { hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name: "Bash", tool_input: { command }, ...(mode && { permission_mode: mode }), ...input }, { cwd, env: env(extra) });
const decision = (r) => { try { return JSON.parse(r.out).hookSpecificOutput; } catch { return null; } };
const asked = (r) => { const d = decision(r); return r.code === 0 && d && d.permissionDecision === "ask" ? d.permissionDecisionReason : ""; };
const terminal = (r) => r.code === 2 && /none can appear here/.test(r.err) && r.err.includes(`--sha ${SHA}`) && r.err.includes(q(VD));

// ---- the ask: the main session, in a mode whose dialog reaches the human
let r = hook(postCmd());
let why = asked(r);
ok("ask: default mode asks, naming the issue, its title, the login, the body and the hash",
  /#30 "Review: m1" as human\?/.test(why) && why.includes("  ACCEPT\n  The lighting reads well.") && why.includes(SHA.slice(0, 12)), r.out + r.err);
ok("ask: nothing was posted by asking", comments(30).length === 0);
ok("ask: acceptEdits asks too", !!asked(hook(postCmd(), { mode: "acceptEdits" })));
ok("ask: a lead session (PROTEUS unset) asks the same", !!asked(hook(postCmd(), { PROTEUS: "" })));
ok("ask: auto mode asks from 2.1.211", !!asked(hook(postCmd(), { mode: "auto", CLAUDE_CODE_EXECPATH: path.join(W, "versions", "2.1.211") })));
r = hook(postCmd(), { mode: "auto", CLAUDE_CODE_EXECPATH: path.join(W, "versions", "2.1.200") });
ok("deny: auto mode before 2.1.211 prints the command for the human's terminal", terminal(r) && /2\.1\.200/.test(r.err), r.err);
r = hook(postCmd(), { mode: "auto" });
ok("deny: auto mode with no version to check denies", terminal(r) && /version is unknown/.test(r.err), r.out + r.err);
r = hook(postCmd(), { mode: "auto", CLAUDE_CODE_EXECPATH: path.join(W, "versions", "latest") });
ok("deny: an install path that names no version is no version", terminal(r), r.out + r.err);
// a fake claude on win32 is a copy of node.exe, which answers --version itself (v22.x: no Claude Code version)
lib.fakeCli(lib.BIN, "claude", 'process.stdout.write("2.1.300 (Claude Code)\\n");');
r = hook(postCmd(), { mode: "auto" });
ok("auto mode reads the version from claude --version, and nothing else", process.platform === "win32" ? terminal(r) : !!asked(r), r.out + r.err);
lib.fakeCli(lib.BIN, "claude", "process.exit(1);");
for (const mode of ["plan", "dontAsk", "bypassPermissions", "", "someNewMode"]) {
  r = hook(postCmd(), { mode });
  ok(`deny: ${mode || "no"} permission mode prints the command for the human's terminal`, terminal(r), r.out + r.err);
}
r = hook(postCmd(), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
ok("deny: a headless session (claude -p) prints the command instead", terminal(r) && /headless/.test(r.err), r.err);
r = hook(postCmd(), { PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(HOME, ".codex") });
ok("deny: Codex has no dialog; prints the command", terminal(r) && /Codex/.test(r.err), r.err);
ok("deny: nothing was posted by any of them", comments(30).length === 0);

// ---- who may not
r = hook(postCmd(), { input: { agent_id: "a1", agent_type: "proteus-guide" } });
ok("deny: a subagent", r.code === 2 && /only the human's main session/.test(r.err), r.err);
r = hook(postCmd(), { input: { teammate_name: "reviewer" } });
ok("deny: a teammate", r.code === 2 && /only the human's main session/.test(r.err), r.err);
r = hook(postCmd(), { input: { agent_id: "a1", agent_type: "proteus-worker" }, PROTEUS: "" });
ok("deny: a subagent of the lead's session", r.code === 2 && /only the human's main session/.test(r.err), r.err);
const WT = path.join(W, "wt");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/5", WT);
fs.mkdirSync(path.join(WT, ".claude"), { recursive: true });
fs.writeFileSync(path.join(WT, ".claude", "proteus-owned"), "src/**\n");
r = hook(postCmd(), { cwd: WT });
ok("deny: from a worker's worktree, under the lead guard", r.code === 2 && /never runs from a worker's worktree/.test(r.err), r.err);
r = hook(postCmd(), { cwd: WT, script: WG, PROTEUS: "" });
ok("deny: from a worker's worktree, under the worker guard", r.code === 2 && /worker's worktree/.test(r.err), r.err);

// ---- the command and the file
r = hook(postCmd(30, BODY, ""));
ok("deny: no --sha prints the command with the file's hash", r.code === 2 && r.err.includes(`Run: ${postCmd()}`), r.err);
r = hook(postCmd(30, BODY, "0".repeat(64)));
ok("deny: a hash that does not match says so and prints the right one", r.code === 2 && /the file changed since/.test(r.err) && r.err.includes(SHA), r.err);
const BAD = path.join(W, "bad.txt");
fs.writeFileSync(BAD, "LGTM\nACCEPT\n");
r = hook(postCmd(30, BAD, sha(BAD)));
ok("deny: a body whose first line is no verdict", r.code === 2 && /first line/.test(r.err), r.err);
r = hook(postCmd(30, path.join(W, "missing.txt"), SHA));
ok("deny: a body file that is not there", r.code === 2 && /cannot read/.test(r.err), r.err);
const BIG = path.join(W, "big.txt");
fs.writeFileSync(BIG, "ACCEPT\n" + "x".repeat(70000));
ok("deny: a body over one comment's size", /over 65536 bytes/.test(hook(postCmd(30, BIG, sha(BIG))).err));
for (const c of [`cd ${q(REPO)} && ${postCmd()}`, `${postCmd()}; echo done`, `${postCmd()} > out.txt`, `GH_CONFIG_DIR= ${postCmd()}`, `bash -c '${postCmd()}'`, `${postCmd()} --body-file ${q(BAD)} extra`]) {
  r = hook(c);
  ok(`deny: not alone or not as given: ${c.slice(0, 60)}`, r.code === 2 && !asked(r), r.out + r.err);
}
// #164: the gate judges what runs; a commit message or a grep naming the script and --post is no post
for (const c of [`git commit -m "feat: ${postCmd().replace(/"/g, "")} asks the human"`, "grep -rn 'proteus-verdict.js --post' docs", "grep -n -- --post templates/hooks/proteus-verdict.js",
  "cat > notes.md <<'EOF'\nnode proteus-verdict.js 30 --post --body-file v.md\nEOF"]) {
  r = hook(c);
  ok(`--post gate: text naming it passes: ${c.slice(0, 50)}`, r.code === 0 && !asked(r) && !/proteus-verdict/.test(r.err), r.out + r.err);
}
for (const c of [`eval '${postCmd()}'`, `echo ${q(VD)} | xargs -I{} node {} 30 --post --body-file ${q(BODY)}`, `$(which node) ${q(VD)} 30 --post`, `node -e "require('child_process').execSync('node proteus-verdict.js 30 --post')"`]) {
  r = hook(c);
  ok(`--post gate: what it cannot judge is refused: ${c.slice(0, 50)}`, r.code === 2 && !asked(r), r.out + r.err);
}
const COPY = path.join(W, "proteus-verdict.js");
fs.copyFileSync(VD, COPY);
r = hook(`node ${q(COPY)} 30 --post --body-file ${q(BODY)} --sha ${SHA}`);
ok("deny: a copy of the script elsewhere", r.code === 2 && /this install's script/.test(r.err), r.err);
r = hook(postCmd(), { FAKE_GH_LOGIN: "mallory" });
ok("deny: the human's gh logged in as someone else", r.code === 2 && /logged in as mallory, not human/.test(r.err), r.err);
config({ agentGh: BOT });
r = hook(postCmd());
ok("deny: agentGh with no human named", r.code === 2 && /no "human"/.test(r.err), r.err);
config({ agentGh: BOT, human: "human" });

// ---- --post, the script itself (in the human's terminal: no hook)
const post = (args, extra = {}) => run(VD, "", { cwd: REPO, args, env: { GH_CONFIG_DIR: BOT, FAKE_GH_ISSUES: ISSUES, ...extra } });
ok("post: bad usage exits 2, nothing posted",
  [["30", "--post"], ["30", "--post", "--body-file", BODY], ["30", "--post", "--body-file", BODY, "--sha", "abc"], ["--post", "--body-file", BODY, "--sha", SHA], ["30", "--post", "--body-file", "-", "--sha", SHA]]
    .every((a) => post(a).code === 2) && comments(30).length === 0);
r = post(["30", "--post", "--body-file", BODY, "--sha", "f".repeat(64)]);
ok("post: a changed file is refused", r.code === 1 && /changed after it was approved/.test(r.err) && comments(30).length === 0, r.err);
r = post(["30", "--post", "--body-file", BAD, "--sha", sha(BAD)]);
ok("post: a first line that is no verdict is refused", r.code === 1 && /first line/.test(r.err) && comments(30).length === 0, r.err);
r = post(["31", "--post", "--body-file", BODY, "--sha", SHA]);
ok("post: an issue that is no review or question is refused", r.code === 1 && /no proteus-review/.test(r.err) && comments(31).length === 0, r.err);
r = post(["30", "--post", "--body-file", BODY, "--sha", SHA], { FAKE_GH_LOGIN: "mallory" });
ok("post: the human's gh as someone else is refused", r.code === 1 && /mallory/.test(r.err) && comments(30).length === 0, r.err);
r = post(["30", "--post", `--body-file=${BODY}`, `--sha=${SHA}`]);
const c30 = comments(30);
ok("post: posts the file's bytes under the human's login, not the agents'", r.code === 0 && r.out.startsWith("posted as human: https:")
  && c30.length === 1 && c30[0].author.login === "human" && c30[0].body === fs.readFileSync(BODY, "utf8"), r.out + r.err + JSON.stringify(c30));
r = run(VD, "", { cwd: REPO, args: ["30"], env: { GH_CONFIG_DIR: BOT, FAKE_GH_ISSUES: ISSUES } });
ok("post: proteus-verdict.js picks the posted verdict up", r.code === 0 && r.out.startsWith("ACCEPT\nThe lighting"), r.out + r.err);
// "humanGh" names the dir the human logs in with
const ALT = path.join(W, "alt-gh");
fs.mkdirSync(ALT); fs.writeFileSync(path.join(ALT, "hosts.yml"), "human");
config({ agentGh: BOT, human: "human", humanGh: ALT });
issues();
r = post(["30", "--post", "--body-file", BODY, "--sha", SHA], { FAKE_GH_LOGIN: "mallory" });
ok("post: humanGh's login is the one used", r.code === 0 && comments(30)[0].author.login === "human", r.out + r.err);
config({ agentGh: BOT, human: "human" });

// ---- nobody reaches the human's gh login while the agents have their own
const lead = (command, input = {}, extra = {}) => hook(command, { mode: "default", input, PROTEUS: "", ...extra });
const sub = { agent_id: "a1", agent_type: "proteus-worker" };
const reach = [
  "cat ~/.config/gh/hosts.yml", `cp ${q(path.join(HUMAN_GH, "hosts.yml"))} /tmp/x`, "env -u GH_CONFIG_DIR gh issue comment 30 --body hi",
  "env --unset=GH_CONFIG_DIR gh api user", "env -i PATH=/usr/bin gh api user", "GH_CONFIG_DIR= gh api user", "GH_CONFIG_DIR=~/.config/gh gh api user",
  "unset GH_CONFIG_DIR; gh api user", "set -e GH_CONFIG_DIR", "export GH_HOST=example.com", "$env:GH_CONFIG_DIR = ''", "Remove-Item env:GH_CONFIG_DIR",
  "sh -c 'unset GH_CONFIG_DIR && gh api user'", "gh auth token", "gh auth switch --user human", "gh auth login --with-token", "gh --hostname github.com api user", "gh api user --hostname=github.com",
];
for (const [who, input] of [["the lead", {}], ["a subagent", sub], ["a teammate", { teammate_name: "reviewer" }]]) {
  const missed = reach.filter((c) => lead(c, input).code !== 2);
  ok(`gh login: ${who} reaching the human's gh is denied`, !missed.length, missed.join(" | "));
}
const fine = ["gh auth status", "gh api user --jq .login", "echo $GH_CONFIG_DIR", "grep -rn GH_CONFIG_DIR templates", `cat ${q(path.join(BOT, "hosts.yml"))}`, "gh issue view 30"];
ok("gh login: reading the variable, the agents' own config and plain gh calls pass", !fine.filter((c) => lead(c).code !== 0).length, fine.filter((c) => lead(c).code !== 0).join(" | "));
const read = (p, input = {}) => run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Read", tool_input: { file_path: p }, ...input }, { cwd: REPO, env: env({ PROTEUS: "" }) });
ok("gh login: Read of the human's hosts.yml denied, lead and subagent", read(path.join(HUMAN_GH, "hosts.yml")).code === 2 && read(path.join(HUMAN_GH, "hosts.yml"), sub).code === 2);
ok("gh login: Read of the agents' own hosts.yml passes", read(path.join(BOT, "hosts.yml")).code === 0);
r = hook("cat ~/.config/gh/hosts.yml");
ok("gh login: the review session (PROTEUS=0) is held to it too", r.code === 2 && /human's gh config/.test(r.err), r.err);
r = hook("gh issue comment 30 --body 'ACCEPT'");
ok("gh login: the review session still never posts the human's words as the agents", r.code === 2 && /human's words/.test(r.err), r.err);
const XDG = path.join(W, "xdg");
fs.mkdirSync(path.join(XDG, "gh"), { recursive: true });
ok("gh login: XDG_CONFIG_HOME moves the human's gh dir, and the guard with it",
  lead(`cat ${q(path.join(XDG, "gh", "hosts.yml"))}`, {}, { XDG_CONFIG_HOME: XDG }).code === 2 && lead("cat ~/.config/gh/hosts.yml", {}, { XDG_CONFIG_HOME: XDG }).code === 0);
config({ human: "human" });
ok("gh login: with one shared login (no agentGh) there is nothing to keep apart", lead("cat ~/.config/gh/hosts.yml").code === 0 && lead("gh auth token").code === 0);
config({ agentGh: BOT, human: "human" });

// ---- gh's config dir, resolved as gh does
const HL = require(path.join(HOOKS, "proteus-lib.js"));
ok("ghConfigDir: GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then ~/.config/gh",
  HL.ghConfigDir({ GH_CONFIG_DIR: "/g", XDG_CONFIG_HOME: "/x" }, "linux") === "/g" && HL.ghConfigDir({ XDG_CONFIG_HOME: "/x" }, "darwin") === "/x/gh"
  && HL.ghConfigDir({}, "linux") === path.posix.join(os.homedir(), ".config", "gh"));
ok("ghConfigDir: Windows reads %AppData%\\GitHub CLI, any case of the name, after XDG_CONFIG_HOME",
  HL.ghConfigDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32") === "C:\\Users\\me\\AppData\\Roaming\\GitHub CLI"
  && HL.ghConfigDir({ AppData: "C:\\R", XDG_CONFIG_HOME: "D:\\x" }, "win32") === "D:\\x\\gh"
  && HL.ghConfigDir({ gh_config_dir: "E:\\gh", AppData: "C:\\R" }, "win32") === "E:\\gh");

summary();
