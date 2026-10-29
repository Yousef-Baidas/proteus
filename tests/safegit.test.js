// #215: hooks run git outside the sandbox, so they must never let git read a config an agent can write. Each route
// below plants a config that runs a command (core.fsmonitor, or a clean filter with .gitattributes) where a
// sandboxed agent can write, then drives the real hook entry points (the shell check before and after a call, the
// lead guard's bind check, the gates cache) and asserts the planted command never ran. A plain `git status` in the
// same checkout afterwards shows the plant was live; where this git does not run it, the route is skipped with why.
// node tests/safegit.test.js (needs git). Temp repos only; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("safegit");
const fw = (p) => p.split(path.sep).join("/");
const LG = path.join(SRC, "proteus-lead-guard.js"), SC = path.join(SRC, "proteus-shell-check.js"), GC = path.join(SRC, "proteus-gates-cache.js");

// the planted command: writes <marks>/<name>, and passes stdin through so it also works as a clean filter
const MARKS = path.join(W, "marks"), PLANT = path.join(W, "plant.js");
fs.mkdirSync(MARKS);
fs.writeFileSync(PLANT, `require("fs").writeFileSync(require("path").join(${JSON.stringify(MARKS)}, process.argv[2]), "ran\\n");
if (process.argv[3] === "filter") process.stdin.pipe(process.stdout);\n`);
const cmd = (name, filter) => `"${fw(process.execPath)}" "${fw(PLANT)}" ${name}${filter ? " filter" : ""}`;
const fired = (name) => fs.existsSync(path.join(MARKS, name));

// a repo with two prepared worker worktrees under .worktrees/, as the lead makes them
let nrepo = 0;
function repo() {
  const R = path.join(W, `repo${++nrepo}`);
  g(W, "init", "-q", "-b", "main", R);
  fs.mkdirSync(path.join(R, "src"));
  fs.writeFileSync(path.join(R, "src", "a.js"), "a\n");
  g(R, "add", "-A"); g(R, "commit", "-qm", "init");
  const WT1 = path.join(R, ".worktrees", "r-1"), WT2 = path.join(R, ".worktrees", "r-2");
  g(R, "worktree", "add", "-q", "-b", "proteus-work/r/1", WT1, "main");
  g(R, "worktree", "add", "-q", "-b", "proteus-work/r/2", WT2, "main");
  for (const wt of [WT1, WT2]) lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: R, args: [wt, "src/**"] });
  return { R, WT1, WT2, common: path.join(R, ".git") };
}
// a scratch repo whose own config runs the planted command
function evilRepo(name) {
  const E = path.join(W, `evil-${name}`);
  g(W, "init", "-q", "-b", "main", E);
  g(E, "config", "core.fsmonitor", cmd(name));
  return E;
}
const wtId = (common, wt) => fs.readdirSync(path.join(common, "worktrees")).find((id) => {
  try { return path.resolve(path.dirname(fs.readFileSync(path.join(common, "worktrees", id, "gitdir"), "utf8").trim())) === fs.realpathSync(wt); } catch { return false; }
});

// every hook route that runs git on target, the lead's checkout being R. bind: target is a prepared worktree whose
// binding Proteus still finds (a plant that moves the git dir moves where Proteus keeps its state too: #212)
let ncall = 0;
function drive({ R, WT1 }, target, prepared) {
  const env = { CLAUDE_PROJECT_DIR: R };
  const who = (id) => ({ agent_id: id, agent_type: "proteus-backend-worker", session_id: "s1" });
  const ran = [];
  // a shell call in WT1: the guard snapshots every idle prepared worktree's changes before it, the check compares after
  const base = { ...who("a1"), cwd: WT1, tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: `toolu_${++ncall}` };
  ran.push(["shell pre", lib.run(LG, { hook_event_name: "PreToolUse", ...base }, { cwd: R, env })]);
  ran.push(["shell post", lib.run(SC, { hook_event_name: "PostToolUse", ...base, tool_response: { stdout: "", stderr: "" } }, { cwd: R, env })]);
  // the gates cache in the target checkout
  ran.push(["gates-cache", lib.run(GC, "", { cwd: target, env, args: [`"${fw(process.execPath)}" -e 0`] })]);
  if (prepared) {
    // an agent bound to the target with uncommitted work there, then editing in WT1: the bind check reads its changes
    const id = `b${ncall}`;
    const edit = (file) => lib.run(LG, { hook_event_name: "PreToolUse", ...who(id), cwd: R, tool_name: "Write", tool_input: { file_path: file, content: "x\n" } }, { cwd: R, env });
    ran.push(["bind", edit(path.join(target, "src", `n${ncall}.js`))]);
    fs.writeFileSync(path.join(target, "src", `n${ncall}.js`), "x\n");
    const r = edit(path.join(WT1, "src", "a.js"));
    ran.push(["bind check", r]);
    ok(`${target === WT1 ? "WT1" : path.basename(target)}: the bind check still sees the uncommitted work`, r.code === 2 && r.err.includes("uncommitted work there"), r.err);
  }
  return ran;
}
// the route's verdict: no hook ran the plant; then plain git status in target proves the plant was live
function verdict(route, name, target, ran) {
  ok(`${route}: no hook ran the planted command`, !fired(name), ran.map(([w, r]) => `${w}: ${r.code} ${r.err}`).join("\n"));
  spawnSync("git", ["status", "--porcelain"], { cwd: target, env: lib.ENV, encoding: "utf8", windowsHide: true });
  if (!fired(name)) console.log(`skip ${route}: this git (${process.platform}) does not run the plant from a plain git status either, so the control shows nothing`);
  else ok(`${route}: control: plain git status there runs it`, true);
}

// 1. <common>/commondir: git in the main checkout would take its config from another dir
{
  const r = repo();
  const E = evilRepo("main-commondir");
  fs.writeFileSync(path.join(r.common, "commondir"), path.join(E, ".git") + "\n");
  verdict("main commondir", "main-commondir", r.R, drive(r, r.R, false));
}

// 2. <common>/worktrees/<id>/commondir: a worker worktree's git would read another repo's config
{
  const r = repo();
  const E = evilRepo("wt-commondir");
  fs.writeFileSync(path.join(r.common, "worktrees", wtId(r.common, r.WT2), "commondir"), path.join(E, ".git") + "\n");
  verdict("worktree commondir", "wt-commondir", r.WT2, drive(r, r.WT2, false));
}

// 3. the worktree's own .git file, aimed at another repo
{
  const r = repo();
  const E = path.join(W, "evil-wt-gitfile");
  // a repo with this checkout's history, so a plain git status there gets as far as asking fsmonitor
  g(W, "clone", "-q", r.R, E);
  g(E, "config", "core.fsmonitor", cmd("wt-gitfile"));
  fs.writeFileSync(path.join(r.WT2, ".git"), `gitdir: ${path.join(E, ".git")}\n`);
  verdict("worktree .git file", "wt-gitfile", r.WT2, drive(r, r.WT2, false));
}

// 4. the worktree's gitdir renamed, carrying a config.worktree that runs the plant, and the .git file following it
{
  const r = repo();
  const id = wtId(r.common, r.WT2), from = path.join(r.common, "worktrees", id), to = `${from}-moved`;
  fs.renameSync(from, to);
  fs.writeFileSync(path.join(to, "config.worktree"), `[core]\n\tfsmonitor = ${cmd("wt-renamed").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}\n`);
  fs.writeFileSync(path.join(r.WT2, ".git"), `gitdir: ${to}\n`);
  verdict("renamed worktree gitdir", "wt-renamed", r.WT2, drive(r, r.WT2, true));
}

// 5. a worktree an agent made itself, with core.fsmonitor in its config.worktree
{
  const r = repo();
  const WT3 = path.join(r.R, ".worktrees", "made");
  g(r.R, "worktree", "add", "-q", "-b", "made", WT3, "main");
  g(r.R, "config", "extensions.worktreeConfig", "true");
  g(WT3, "config", "--worktree", "core.fsmonitor", cmd("wt-made"));
  verdict("sandbox-made worktree", "wt-made", WT3, drive(r, WT3, false));
}

// 6. a clean filter: .gitattributes in the worktree, filter.<name>.clean in its config.worktree, a modified file
{
  const r = repo();
  fs.writeFileSync(path.join(r.WT2, ".gitattributes"), "*.js filter=plant\n");
  g(r.WT2, "config", "--worktree", "filter.plant.clean", cmd("wt-filter", true));
  // the same size, so git must read the file through the filter to tell whether it changed
  fs.writeFileSync(path.join(r.WT2, "src", "a.js"), "b\n");
  fs.utimesSync(path.join(r.WT2, "src", "a.js"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  verdict("filter.clean with .gitattributes", "wt-filter", r.WT2, drive(r, r.WT2, true));
}

lib.summary();
