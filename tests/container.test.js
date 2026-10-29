// proteus-container.js (#80): a fake docker (and podman) that records its argv and env, then plays the container by
// running proteus-container-entry.js locally with PROTEUS_CONTAINER_TEST_ROOT mapping /in, /out and /work into the
// scratch dir, and a fake claude that edits, commits, plants or reports. Covers the import, every refusal, the hardening
// flags and mounts, the credential and GitHub token handling, the timeout's kill, the fallback, win32 paths, --model
// and --agent, the clone's commit hooks, and --ticket's publish (report, push, PR, comment) through the fake gh.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require("./lib.js");
const { ok, g } = lib;

const SRC = path.join(__dirname, "..", "templates", "hooks");
const SCRIPT = path.join(SRC, "proteus-container.js");
const C = require(SCRIPT);
const W = lib.workdir("container");
const BIN = lib.BIN;
const LOG = path.join(W, "docker.log");
const MARK = path.join(W, "planted-fired");
const SECRET = "sk-oauth-secret-value-9f3c";
// a throw is one more failure, never a missing summary line
process.on("uncaughtException", (e) => { ok("no uncaught throw", false, e && e.stack); lib.summary(); });
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// win32: the fake claude is a copy of node.exe, which reads the entry's leading -p and --permission-mode as its own
// options and exits 9 before fake-cli-shim.js loads; this preload, which the fake docker loads into the entry there,
// runs the fake's script with node instead, as the image's claude would run
const CLAUDE_PRELOAD = path.join(W, "claude-preload.js");
fs.writeFileSync(CLAUDE_PRELOAD, `const cp = require("child_process"), spawnSync = cp.spawnSync;
cp.spawnSync = (cmd, args, o) => (cmd === "claude" ? spawnSync(process.execPath, [${JSON.stringify(lib.fakeScript(BIN, "claude"))}, ...args], o) : spawnSync(cmd, args, o));
`);

const FAKE_DOCKER = `
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const me = path.basename(process.argv[1]).replace(/\\.fake\\.js$/, "");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ me, args, gh: Object.keys(process.env).filter((k) => /^(GH_TOKEN|GITHUB_TOKEN)$/i.test(k)) }) + "\\n");
const cmd = args[0];
if (cmd === "info") { console.log(process.env.FAKE_DOCKER_INFO || "[name=seccomp,profile=builtin]"); process.exit(0); }
if (cmd === "image") process.exit(process.env.FAKE_DOCKER_NOIMAGE ? 1 : 0);
if (cmd === "kill" || cmd === "build") process.exit(0);
if (cmd !== "run") process.exit(3);
if (process.env.FAKE_DOCKER_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, +process.env.FAKE_DOCKER_SLEEP);
const mounts = args.filter((a, i) => args[i - 1] === "--mount").map((m) => Object.fromEntries(m.split(",").map((kv) => kv.split(/=(.*)/s).slice(0, 2))));
const src = (t) => (mounts.find((m) => m.target === t) || {}).source;
const root = path.dirname(src("/in"));
if (path.dirname(src("/out")) !== root) process.exit(4);
fs.mkdirSync(path.join(root, "work"), { recursive: true });
if (process.env.FAKE_DOCKER_RM) fs.rmSync(process.env.FAKE_DOCKER_RM, { force: true });
const pre = process.env.FAKE_DOCKER_PRELOAD ? ["--require", process.env.FAKE_DOCKER_PRELOAD] : [];
spawnSync(process.execPath, [...pre, process.env.FAKE_DOCKER_ENTRY], { env: { ...process.env, PROTEUS_CONTAINER_TEST_ROOT: root }, stdio: "inherit" });
if (process.env.FAKE_DOCKER_EXTRA) {
  const repo = path.join(root, "work", "repo");
  const git = (...a) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
  git("branch", "evil");
  git("tag", "evil");
  fs.rmSync(path.join(root, "out", "out.bundle"), { force: true });
  git("bundle", "create", path.join(root, "out", "out.bundle"), "--branches", "--tags");
}
process.exit(+(process.env.FAKE_DOCKER_EXIT || 0));
`;

const FAKE_CLAUDE = `
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const mode = process.env.FAKE_CLAUDE || "ok";
const prompt = fs.readFileSync(0, "utf8");
const g = (...a) => execFileSync("git", a, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const w = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, { mode: 0o755 }); };
const commit = () => { g("add", "-A"); g("commit", "-q", "-m", "feat: worker " + mode); };
if (mode === "ok" || mode === "plant" || mode === "extra") { w("src/a.js", "a\\n"); commit(); }
if (mode === "uncommitted") w("src/b.js", "b\\n");
if (mode === "outside") { w("src/a.js", "a\\n"); w("README.md", "changed\\n"); commit(); }
if (mode === "gitattr") { w("src/.gitattributes", "*.js filter=evil\\n"); commit(); }
if (mode === "ghattr") { w(".github/x/.gitattributes", "*.js filter=evil\\n"); commit(); }
if (mode === "agentdirs") { w("src/.claude/skills/x/SKILL.md", "x\\n"); w("src/a/.codex/config.toml", "x\\n"); w("src/.agents/x.md", "x\\n"); commit(); }
if (mode === "rewrite") { w("src/a.js", "a\\n"); g("add", "-A"); g("commit", "-q", "--amend", "-m", "fix: rewritten"); }
// the clone's hooks: a path outside the owned list and a bad message are refused, the owned list is git-ignored
const hooks = {};
if (mode === "hooks") {
  const t = (f) => { try { f(); return "passed"; } catch { return "refused"; } };
  w("README.md", "changed\\n");
  g("add", "README.md");
  hooks.owned = t(() => g("commit", "-q", "-m", "feat: outside"));
  g("reset", "-q", "HEAD", "--", "README.md");
  g("checkout", "--", "README.md");
  w("src/a.js", "a\\n");
  g("add", "src/a.js");
  hooks.msg = t(() => g("commit", "-q", "-m", "Bad message"));
  hooks.ignored = t(() => g("check-ignore", "-q", ".claude/proteus-owned"));
  hooks.path = g("config", "core.hooksPath").trim();
  commit();
}
const rep = process.env.PROTEUS_REPORT, src = process.env.FAKE_REPORT_FILE;
if (rep && src) { if (process.env.FAKE_REPORT_LINK) fs.symlinkSync(src, rep); else fs.copyFileSync(src, rep); }
if (mode === "plant") {
  const sh = "#!/bin/sh\\necho fired > '" + process.env.FAKE_MARK.replace(/\\\\/g, "/") + "'\\n";
  for (const h of ["post-checkout", "post-merge", "post-commit", "pre-commit", "reference-transaction", "fsmon"]) w(".git/hooks/" + h, sh);
  g("config", "core.hooksPath", ".git/hooks");
  g("config", "core.fsmonitor", ".git/hooks/fsmon");
}
process.stdout.write(JSON.stringify({ type: "result", result: "done", mode, args: process.argv.slice(2), prompt, hooks, report: rep || null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN === "${SECRET}" }));
`;

lib.fakeCli(BIN, "docker", FAKE_DOCKER);
lib.fakeCli(BIN, "podman", FAKE_DOCKER);
lib.fakeCli(BIN, "claude", FAKE_CLAUDE);
const NOBIN = path.join(W, "nobin");
fs.mkdirSync(NOBIN);

const R = path.join(W, "repo");
fs.mkdirSync(path.join(R, "src"), { recursive: true });
g(W, "init", "-q", "-b", "main", R);
fs.writeFileSync(path.join(R, "README.md"), "readme\n");
fs.writeFileSync(path.join(R, "src", "x.js"), "x\n");
g(R, "add", "-A");
g(R, "commit", "-q", "-m", "init");
fs.appendFileSync(path.join(R, ".git", "info", "exclude"), "/.worktrees/\n.claude/\n");
const PROMPT = path.join(W, "prompt.md");
fs.writeFileSync(PROMPT, "do the ticket\n");
const hooksBefore = fs.readdirSync(path.join(R, ".git", "hooks")).sort().join(",");
// the remote the host pushes to; its push config would push every branch and tag on a bare `git push origin`
const ORIGIN = path.join(W, "origin.git");
g(W, "init", "-q", "--bare", ORIGIN);
g(R, "remote", "add", "origin", ORIGIN);
g(R, "config", "remote.origin.push", "+refs/*:refs/*");
g(R, "tag", "v1");

let n = 0;
// a fresh worker worktree on its own branch, owning src/
function worktree(owned = "src/\n") {
  const id = ++n, wt = path.join(R, ".worktrees", `w${id}`), branch = `proteus-work/r1/${id}`;
  g(R, "worktree", "add", "-q", "-b", branch, wt);
  if (owned !== null) { fs.mkdirSync(path.join(wt, ".claude"), { recursive: true }); fs.writeFileSync(path.join(wt, ".claude", "proteus-owned"), owned); }
  return { wt, branch, base: g(R, "rev-parse", branch) };
}
const calls = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function run(args, env = {}) {
  fs.rmSync(LOG, { force: true });
  const base = { FAKE_DOCKER_LOG: LOG, FAKE_DOCKER_ENTRY: path.join(SRC, "proteus-container-entry.js"), FAKE_MARK: MARK, CLAUDE_CODE_OAUTH_TOKEN: SECRET };
  if (process.platform === "win32") base.FAKE_DOCKER_PRELOAD = CLAUDE_PRELOAD;
  return lib.run(SCRIPT, "", { cwd: R, args, env: { ...base, ...env } });
}
const runIn = (t, env, extra = []) => run(["run", "--worktree", t.wt, "--prompt-file", PROMPT, "--runtime", "docker", ...extra], env);
const tip = (t) => g(R, "rev-parse", t.branch);
const refs = () => g(R, "for-each-ref", "--format=%(refname)");
const scratch = path.join(R, ".git", "proteus", "scratch");
const outDir = (res) => (/result\.json and status\.json in (.+)$/m.exec(res.out) || [])[1] || "";
const resultOf = (res) => { try { return JSON.parse(read(path.join(outDir(res), "result.json"))); } catch { return {}; } };
const argOf = (args, k) => { const i = (args || []).indexOf(k); return i < 0 ? undefined : args[i + 1]; };
const lastLine = (res) => res.out.trim().split("\n").pop();

// ---- happy path: imported, branch moved by update-ref, a clean worktree's files follow
{
  const t = worktree();
  const res = runIn(t, { GH_TOKEN: "ghp_x", GITHUB_TOKEN: "ghp_y" });
  ok("run imports the worker's commit and exits 0", res.code === 0, res.out + res.err);
  ok("the branch moved to a child of its old tip", tip(t) !== t.base && g(R, "rev-parse", `${t.branch}~1`) === t.base, res.out);
  ok("a clean worktree's files follow the branch", read(path.join(t.wt, "src", "a.js")) === "a\n" && g(t.wt, "status", "--porcelain") === "", g(t.wt, "status", "--porcelain"));
  ok("the temporary ref is gone after the import", !refs().includes("refs/proteus-container/"), refs());
  const out = outDir(res);
  let result = {};
  try { result = JSON.parse(read(path.join(out, "result.json"))); } catch {}
  ok("claude ran with -p, bypassPermissions and json output, the prompt on stdin", (result.args || []).join(" ") === "-p --permission-mode bypassPermissions --output-format json" && result.prompt === "do the ticket\n", JSON.stringify(result));
  ok("result.json and status.json stay; both bundles are removed", fs.existsSync(path.join(out, "status.json")) && !fs.existsSync(path.join(out, "out.bundle")) && !fs.existsSync(path.join(path.dirname(out), "in", "in.bundle")), out);
  ok("the scratch dir sits under <common>/proteus/scratch", lib.W && out.startsWith(scratch + path.sep), out);
  if (process.platform !== "win32") ok("the scratch dir is private (0700)", (fs.statSync(path.dirname(out)).mode & 0o777) === 0o700);
  const c = calls().find((x) => x.args[0] === "run");
  const a = c ? c.args : [];
  const pair = (k, v) => a.some((x, i) => x === k && a[i + 1] === v);
  ok("docker run gets every hardening flag", a[1] === "--rm" && pair("--cap-drop", "ALL") && pair("--security-opt", "no-new-privileges") && a.includes("--read-only")
    && pair("--pids-limit", "512") && pair("--memory", "4g") && pair("--cpus", "2") && pair("--user", "node"), a.join(" "));
  ok("/tmp, /work and the home dir are tmpfs", ["/tmp", "/work", "/home/node"].every((d) => a.some((x, i) => a[i - 1] === "--tmpfs" && x.startsWith(`${d}:`))), a.join(" "));
  ok("no --network unless given, and no --userns for docker", !a.includes("--network") && !a.includes("--userns"), a.join(" "));
  const mounts = a.filter((x, i) => a[i - 1] === "--mount");
  const sources = mounts.map((m) => /source=([^,]+)/.exec(m)[1]);
  ok("exactly two mounts: /in read-only and /out", mounts.length === 2 && mounts[0].endsWith("target=/in,readonly") && mounts[1].endsWith("target=/out"), mounts.join(" | "));
  ok("no mount source is a .git, the repo or the worktree", sources.every((s) => s.startsWith(scratch) && !/[\\/]\.git$/.test(s) && s !== R && s !== t.wt), sources.join(" "));
  ok("the credential is passed by name, its value never in argv", pair("-e", "CLAUDE_CODE_OAUTH_TOKEN") && !calls().some((x) => x.args.join(" ").includes(SECRET)), a.join(" "));
  ok("the credential still reaches the session through the env", result.token === true);
  ok("GH_TOKEN and GITHUB_TOKEN never reach the runtime", c && c.gh.length === 0 && !a.some((x) => /GH_TOKEN|GITHUB_TOKEN/.test(x)), JSON.stringify(c && c.gh));
  ok("the container is named for the run", a.some((x, i) => a[i - 1] === "--name" && /^proteus-\w+$/.test(x)), a.join(" "));
}

// ---- a dirty worktree: the branch moves, its files stay, the command to follow is printed
{
  const t = worktree();
  fs.writeFileSync(path.join(t.wt, "src", "local.js"), "mine\n");
  const res = runIn(t);
  ok("a dirty worktree still gets the branch moved", res.code === 0 && tip(t) !== t.base, res.out + res.err);
  ok("its files are left and the read-tree command is printed", !fs.existsSync(path.join(t.wt, "src", "a.js")) && res.out.includes(`read-tree -m -u ${t.base} ${tip(t)}`), res.out);
}

// ---- uncommitted changes come back as a wip commit
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "uncommitted" });
  ok("uncommitted worker changes are committed as wip and imported", res.code === 0 && g(R, "log", "-1", "--format=%s", t.branch) === "wip: uncommitted worker changes" && fs.existsSync(path.join(t.wt, "src", "b.js")), res.out + res.err);
}

// ---- nothing changed
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "none" });
  ok("no new commits: exit 0, branch unchanged", res.code === 0 && tip(t) === t.base && /no new commits/.test(res.out), res.out + res.err);
}

// ---- refusals: outside the owned paths, a .git* path, rewritten history
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "outside" });
  ok("a commit outside the owned paths is refused, exit 1", res.code === 1 && /refused/.test(res.err) && res.err.includes("README.md") && !res.err.includes("src/a.js"), res.err);
  ok("the refused branch is unchanged and the result kept for inspection", tip(t) === t.base && refs().includes("refs/proteus-container/"), refs());
}
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "gitattr" });
  ok("a .gitattributes under an owned dir is refused when no entry names it", res.code === 1 && res.err.includes("src/.gitattributes") && tip(t) === t.base, res.err);
  const t2 = worktree("src/\nsrc/.gitattributes\n");
  const res2 = runIn(t2, { FAKE_CLAUDE: "gitattr" });
  ok("an owned entry naming the .git* path lets it through", res2.code === 0 && tip(t2) !== t2.base, res2.out + res2.err);
  const t3 = worktree(".github/\n");
  const res3 = runIn(t3, { FAKE_CLAUDE: "ghattr" });
  ok("an entry naming .github/ does not let a .gitattributes under it through", res3.code === 1 && res3.err.includes(".github/x/.gitattributes") && tip(t3) === t3.base, res3.err);
}
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "agentdirs" });
  ok("a .claude, .codex or .agents dir at any depth under an owned dir is refused",
    res.code === 1 && ["src/.claude/skills/x/SKILL.md", "src/a/.codex/config.toml", "src/.agents/x.md"].every((p) => res.err.includes(p)) && tip(t) === t.base, res.err);
  const t2 = worktree("src/\nsrc/.claude/**\nsrc/a/.codex/\nsrc/.agents/\n");
  const res2 = runIn(t2, { FAKE_CLAUDE: "agentdirs" });
  ok("owned entries naming those dirs let them through", res2.code === 0 && tip(t2) !== t2.base, res2.out + res2.err);
}
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "outside", FAKE_DOCKER_RM: path.join(t.wt, ".claude", "proteus-owned") });
  ok("the import checks the owned list read before the run, even if it is gone after", res.code === 1 && res.err.includes("README.md") && tip(t) === t.base, res.err);
}
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "rewrite" });
  ok("a result that does not descend from the old tip is refused", res.code === 1 && /does not descend/.test(res.err) && tip(t) === t.base, res.err);
}

// ---- a planted hook or config in the container's clone has no effect on the host
{
  fs.rmSync(MARK, { force: true });
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "plant" });
  ok("a clone with planted hooks and fsmonitor still imports", res.code === 0 && tip(t) !== t.base, res.out + res.err);
  ok("nothing planted ran, on the host or in the entry's own git", !fs.existsSync(MARK));
  ok("the host's config and hooks are untouched", !/fsmonitor|hookspath/i.test(fs.readFileSync(path.join(R, ".git", "config"), "utf8")) && fs.readdirSync(path.join(R, ".git", "hooks")).sort().join(",") === hooksBefore);
}

// ---- an extra ref in the out bundle is not fetched
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "extra", FAKE_DOCKER_EXTRA: "1" });
  ok("a bundle with extra branches and tags imports only the worker's branch", res.code === 0 && tip(t) !== t.base && !/refs\/heads\/evil|refs\/tags\/evil/.test(refs()), refs() + res.err);
}

// ---- preconditions and failures
{
  const t = worktree();
  const res = runIn(t, { CLAUDE_CODE_OAUTH_TOKEN: "" });
  ok("missing credentials die before the container starts", res.code === 1 && /CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY/.test(res.err) && !calls().length, res.err);
  const res2 = runIn(t, { CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: SECRET });
  const a = (calls().find((x) => x.args[0] === "run") || { args: [] }).args;
  ok("ANTHROPIC_API_KEY is passed by name when it is the one set", res2.code === 0 && a.some((x, i) => a[i - 1] === "-e" && x === "ANTHROPIC_API_KEY") && !a.join(" ").includes(SECRET), a.join(" "));
}
{
  const t = worktree();
  const bare = { PATH: [NOBIN, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter) };
  const has = [path.dirname(process.execPath), ...lib.SYS_PATH].some((d) => ["docker", "podman", "docker.exe", "podman.exe"].some((f) => fs.existsSync(path.join(d, f))));
  if (!has) {
    const res = run(["run", "--worktree", t.wt, "--prompt-file", PROMPT], bare);
    ok("no runtime: a clear die that says to run without the container", res.code === 1 && /no container runtime \(podman or docker\)/.test(res.err) && /without the container/.test(res.err), res.err);
    const doc = run(["doctor"], bare);
    ok("doctor with no runtime fails with the same fallback", doc.code === 1 && /^FIX\s+runtime:.*without the container/m.test(doc.out), doc.out);
  }
  const res = run(["run", "--worktree", t.wt, "--prompt-file", PROMPT, "--runtime", "podman"], { PATH: [NOBIN, path.dirname(process.execPath)].join(path.delimiter) });
  ok("a named runtime that is missing dies with the fallback", res.code === 1 && /podman is not on PATH; run this worker without the container/.test(res.err), res.err);
}
{
  const t = worktree();
  const res = runIn(t, { FAKE_DOCKER_SLEEP: "30000" }, ["--timeout", "0.03"]);
  ok("the timeout stops the run, exit 1, nothing imported", res.code === 1 && /timed out/.test(res.err) && tip(t) === t.base, res.err);
  const kill = calls().find((x) => x.args[0] === "kill");
  const name = ((calls().find((x) => x.args[0] === "run") || { args: [] }).args.find((x, i, a) => a[i - 1] === "--name"));
  ok("the timeout kills the container by its name", kill && name && kill.args[1] === name, JSON.stringify(calls().map((x) => x.args.slice(0, 2))));
}
{
  const t = worktree();
  const res = runIn(t, { FAKE_DOCKER_EXIT: "125" });
  ok("a failed docker run imports nothing", res.code === 1 && /exited 125/.test(res.err) && tip(t) === t.base, res.err);
  const t2 = worktree(null);
  const res2 = runIn(t2);
  ok("a worktree with no owned-path list is refused before the run", res2.code === 1 && /proteus-owned/.test(res2.err) && !calls().length, res2.err);
  const t3 = worktree(null);
  fs.mkdirSync(path.join(t3.wt, ".claude", "proteus-owned"), { recursive: true });
  const res4 = runIn(t3);
  ok("an unreadable owned-path list is refused before the run", res4.code === 1 && /proteus-owned/.test(res4.err) && !calls().length && tip(t3) === t3.base, res4.err);
  const res3 = run(["run", "--worktree", W, "--prompt-file", PROMPT, "--runtime", "docker"]);
  ok("a dir that is no worktree of the repo is refused", res3.code === 1 && /not a worktree/.test(res3.err), res3.err);
}

// ---- runtime choice, network, podman
{
  const t = worktree();
  const res = run(["run", "--worktree", t.wt, "--prompt-file", PROMPT, "--network", "none"]);
  const c = calls().find((x) => x.args[0] === "run") || { args: [] };
  ok("podman is preferred when both are found, with --userns keep-id", res.code === 0 && c.me === "podman" && c.args.some((x, i) => c.args[i - 1] === "--userns" && x === "keep-id"), JSON.stringify(c));
  ok("--network is passed when given", c.args.some((x, i) => c.args[i - 1] === "--network" && x === "none"), c.args.join(" "));
}

// ---- --model and --agent reach claude; an unknown agent dies before the container starts
{
  const t = worktree();
  const res = runIn(t, {}, ["--model", "claude-test-1", "--agent", "proteus:proteus-worker"]);
  const r = resultOf(res), sys = argOf(r.args, "--append-system-prompt") || "";
  ok("--model reaches claude once, the agent's model: line does not", res.code === 0 && argOf(r.args, "--model") === "claude-test-1" && r.args.filter((x) => x === "--model").length === 1, JSON.stringify(r.args));
  ok("the plugin's agent body is the appended system prompt, without its frontmatter", sys.startsWith("You are a Proteus worker") && !/^model:|^disallowedTools:/m.test(sys), sys.slice(0, 200));
  ok("its disallowedTools go to --disallowedTools", argOf(r.args, "--disallowedTools") === "Agent,AskUserQuestion,EnterPlanMode,ExitPlanMode,CronCreate,CronDelete,CronList,ScheduleWakeup,RemoteTrigger,PushNotification,Monitor,EnterWorktree,ExitWorktree", JSON.stringify(r.args));
  ok("no ticket: no report path and no report line", r.report === null && !/PROTEUS_REPORT/.test(sys), sys);
  const dir = path.join(R, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "proteus-worker.md"), "---\nname: proteus-worker\nmodel: opus\ndisallowedTools: [WebFetch, \"Bash(rm:*)\"]\n---\nPROJECT COPY\n");
  const t2 = worktree();
  const r2 = resultOf(runIn(t2, {}, ["--agent", "proteus-worker"]));
  ok("the project's .claude/agents copy wins over the plugin's, its inline list parsed", argOf(r2.args, "--append-system-prompt") === "PROJECT COPY" && argOf(r2.args, "--disallowedTools") === "WebFetch,Bash(rm:*)" && !r2.args.includes("--model"), JSON.stringify(r2.args));
  fs.rmSync(dir, { recursive: true, force: true });
  const t3 = worktree();
  const res3 = runIn(t3, {}, ["--agent", "proteus-nobody"]);
  ok("an unknown agent dies before the container starts", res3.code === 1 && /--agent proteus-nobody: no proteus-nobody\.md/.test(res3.err) && !calls().length && tip(t3) === t3.base, res3.err);
}

// ---- the clone runs the worktree's commit checks; they never reach a commit
{
  const t = worktree();
  const res = runIn(t, { FAKE_CLAUDE: "hooks" });
  const h = resultOf(res).hooks || {};
  ok("the clone's pre-commit refuses a path outside the owned list", h.owned === "refused", JSON.stringify(h));
  ok("the clone's commit-msg refuses a bad message", h.msg === "refused", JSON.stringify(h));
  ok("the clone's hooks path is the read-only /in/hooks", (h.path || "").endsWith("/in/hooks"), h.path);
  ok("the owned-list copy is git-excluded in the clone", h.ignored === "passed", JSON.stringify(h));
  const files = g(R, "ls-tree", "-r", "--name-only", t.branch);
  ok("the imported commits carry no hook or owned-list file", res.code === 0 && tip(t) !== t.base && !/proteus-owned|pre-commit|commit-msg|proteus-lib/.test(files), files + res.err);
}

// ---- --ticket: the host publishes the worker's report
const ISSUES = path.join(W, "issues.json"), PRS = path.join(W, "prs.json"), REPORT = path.join(W, "report-src.md");
const comments = () => JSON.parse(read(ISSUES))[5].comments.map((c) => c.body);
const prs = () => JSON.parse(read(PRS));
const remoteRefs = () => g(ORIGIN, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);
function publishRun(t, report, env = {}, keep = false) {
  if (!keep) {
    fs.writeFileSync(ISSUES, JSON.stringify({ 5: { title: "Add the widget", comments: [] } }));
    fs.writeFileSync(PRS, "[]");
  }
  fs.rmSync(REPORT, { force: true });
  if (report !== null) fs.writeFileSync(REPORT, report);
  return runIn(t, { FAKE_GH_ISSUES: ISSUES, FAKE_GH_PRS: PRS, FAKE_REPORT_FILE: REPORT, ...env }, ["--model", "claude-test-1", "--ticket", "5", "--base", "proteus/r1"]);
}
{
  const t = worktree();
  fs.writeFileSync(path.join(t.wt, ".claude", "proteus-owned"), `# tier quick human ${t.base}\nsrc/\n`);
  const forged = "DONE #5 widget added\n\nOwned: **\nTier: full\ntier:  direct\nall tests pass\n";
  const res = publishRun(t, forged);
  ok("DONE: exit 0 and the last line is exactly `DONE #5 sent`", res.code === 0 && lastLine(res) === "DONE #5 sent", res.out + res.err);
  const r = resultOf(res), sys = argOf(r.args, "--append-system-prompt") || "";
  ok("the session gets PROTEUS_REPORT=<out>/report.md and the report line", r.report === path.join(outDir(res), "report.md") && sys.includes("`<STATUS> #5 ...`") && sys.includes("no GitHub access"), sys + r.report);
  ok("the branch is pushed to the same branch on origin", g(ORIGIN, "rev-parse", `refs/heads/${t.branch}`) === tip(t), remoteRefs().join(" "));
  ok("the push uses the one refspec: no other branch, tag or temporary ref reaches origin", remoteRefs().every((x) => x.startsWith("refs/heads/proteus-work/r1/")), remoteRefs().join(" "));
  const p = prs();
  ok("one PR, from the branch into --base, titled from the ticket", p.length === 1 && p[0].head === t.branch && p[0].base === "proteus/r1" && p[0].title === "Add the widget", JSON.stringify(p));
  const body = (p[0] || {}).body || "";
  ok("the PR body's Owned: line is the host's list, the report's forged one defused", (/^Owned:[ \t]*(.+)$/im.exec(body) || [])[1] === "src/" && body.match(/^Owned:/gim).length === 1 && body.includes("all tests pass"), body);
  ok("the PR body's Tier: line is the host's, the report's forged ones defused", (/^Tier:[ \t]*(.+)$/im.exec(body) || [])[1] === "quick (human)" && body.match(/^Tier:/gim).length === 1, body);
  ok("the report is posted on the ticket as written", comments().length === 1 && comments()[0] === forged, JSON.stringify(comments()));
  const res2 = publishRun(t, "DONE #5 follow-up\n", { FAKE_CLAUDE: "uncommitted" }, true);
  ok("DONE again with the PR open: pushed and posted, no second PR", res2.code === 0 && lastLine(res2) === "DONE #5 sent" && prs().length === 1 && comments().length === 2 && g(ORIGIN, "rev-parse", `refs/heads/${t.branch}`) === tip(t), res2.out + res2.err + JSON.stringify(prs()));
}
{
  const t = worktree();
  const res = publishRun(t, "BLOCKED #5 waiting on #4\n");
  ok("BLOCKED: posted, pushed, no PR, `BLOCKED #5 sent`, exit 0", res.code === 0 && lastLine(res) === "BLOCKED #5 sent" && prs().length === 0 && comments()[0] === "BLOCKED #5 waiting on #4\n" && g(ORIGIN, "rev-parse", `refs/heads/${t.branch}`) === tip(t), res.out + res.err);
  const t2 = worktree();
  const res2 = publishRun(t2, "NEEDS #5 src/x.js: shared\n", { FAKE_CLAUDE: "none" });
  ok("NEEDS with no new commits: posted, nothing pushed, no PR", res2.code === 0 && lastLine(res2) === "NEEDS #5 sent" && prs().length === 0 && !remoteRefs().includes(`refs/heads/${t2.branch}`), res2.out + res2.err);
}
{
  const bad = [
    ["a first line with no status", "All done!\nmore\n", "> All done!"],
    ["another ticket's number", "DONE #51 widget\n", "> DONE #51 widget"],
    ["no report at all", null, "wrote no report.md"],
    ["a report that is not UTF-8", Buffer.from([0x44, 0x4f, 0x4e, 0x45, 0x20, 0x23, 0x35, 0x0a, 0xff, 0xfe]), "as UTF-8"],
  ];
  for (const [what, report, says] of bad) {
    const t = worktree();
    const res = publishRun(t, report);
    const c = comments()[0] || "";
    ok(`${what} becomes RED and is posted as such, with no PR`, res.code === 0 && lastLine(res) === "RED #5 sent" && c.startsWith("RED #5 container: no valid report\n") && c.includes(says) && prs().length === 0, res.out + res.err + c);
  }
  const t = worktree();
  const res = publishRun(t, `DONE #5 big\n${"x".repeat(65 << 10)}\n`);
  const c = comments()[0] || "";
  ok("an oversized report is not read: RED, no PR", res.code === 0 && lastLine(res) === "RED #5 sent" && /over the 64 KiB cap/.test(c) && !c.includes("xxxx") && prs().length === 0, c.slice(0, 300));
  if (process.platform !== "win32") {
    const t2 = worktree();
    const res2 = publishRun(t2, "DONE #5 through a link\n", { FAKE_REPORT_LINK: "1" });
    const c2 = comments()[0] || "";
    ok("a report that is a link is not read: RED, no PR", res2.code === 0 && lastLine(res2) === "RED #5 sent" && /link/.test(c2) && !c2.includes("through a link") && prs().length === 0, res2.out + res2.err + c2);
  }
}
{
  const t = worktree();
  const res = publishRun(t, "DONE #5 x\n", { FAKE_CLAUDE: "outside" });
  ok("a refused import: exit 1, last line `RED #5 container: refused: ...`, nothing pushed or posted", res.code === 1 && lastLine(res).startsWith("RED #5 container: refused: ") && comments().length === 0 && prs().length === 0 && !remoteRefs().includes(`refs/heads/${t.branch}`), res.out + res.err);
  const t2 = worktree();
  const res2 = publishRun(t2, "BLOCKED #5 x\n", { FAKE_GH: "fail" });
  ok("a failed post: exit 1 and a RED container line", res2.code === 1 && lastLine(res2).startsWith("RED #5 container: cannot post the report on #5"), res2.out + res2.err);
}

// ---- usage
{
  ok("--ticket without --base is a usage error", run(["run", "--worktree", "x", "--prompt-file", PROMPT, "--model", "m", "--ticket", "5"]).code === 2);
  ok("--ticket without --model is a usage error", run(["run", "--worktree", "x", "--prompt-file", PROMPT, "--ticket", "5", "--base", "proteus/r1"]).code === 2);
  ok("a --ticket that is no issue number is a usage error", run(["run", "--worktree", "x", "--prompt-file", PROMPT, "--model", "m", "--ticket", "5x", "--base", "b"]).code === 2);
  ok("an --agent with a path in it is a usage error", run(["run", "--worktree", "x", "--prompt-file", PROMPT, "--agent", "../x"]).code === 2);
  ok("an unknown flag is a usage error", run(["run", "--bogus", "1"]).code === 2);
  ok("run without --worktree is a usage error", run(["run", "--prompt-file", PROMPT]).code === 2);
  ok("a bad --memory is a usage error", run(["run", "--worktree", "x", "--prompt-file", PROMPT, "--memory", "lots"]).code === 2);
  ok("a run-only flag on build is a usage error", run(["build", "--worktree", "x"]).code === 2);
  ok("no command is a usage error", run([]).code === 2);
  ok("--help exits 0", run(["--help"]).code === 0);
}

// ---- doctor and build
{
  const d = run(["doctor", "--runtime", "docker"]);
  ok("doctor: runtime, rootful warning, image, credential; exit 0", d.code === 0 && /^ok\s+runtime docker/m.test(d.out) && /^warn\s+rootful docker/m.test(d.out) && /^ok\s+image proteus-worker/m.test(d.out) && /^ok\s+credential CLAUDE_CODE_OAUTH_TOKEN set/m.test(d.out) && !d.out.includes(SECRET), d.out);
  const r = run(["doctor", "--runtime", "docker"], { FAKE_DOCKER_INFO: "[name=seccomp name=rootless]" });
  ok("doctor reads rootless docker from docker info", /^ok\s+rootless docker/m.test(r.out), r.out);
  const f = run(["doctor", "--runtime", "docker"], { FAKE_DOCKER_NOIMAGE: "1", CLAUDE_CODE_OAUTH_TOKEN: "" });
  ok("doctor fails on a missing image and credential", f.code === 1 && /^FIX\s+image proteus-worker not found/m.test(f.out) && /^FIX\s+credential.*claude setup-token/m.test(f.out), f.out);
  const b = run(["build", "--runtime", "docker", "--image", "my/worker:1"]);
  const c = calls().find((x) => x.args[0] === "build") || { args: [] };
  ok("build runs <runtime> build -t <image> on a context it removes after", b.code === 0 && c.args[1] === "-t" && c.args[2] === "my/worker:1" && c.args[3] && !fs.existsSync(c.args[3]), b.out + b.err + JSON.stringify(c));
  const df = fs.readFileSync(path.join(__dirname, "..", "templates", "container", "Dockerfile"), "utf8");
  ok("the Dockerfile pins node:22-slim by tag, installs git and Claude Code, runs as node", /^FROM node:22-slim$/m.test(df) && /git ca-certificates/.test(df) && /npm i -g @anthropic-ai\/claude-code/.test(df) && /^USER node$/m.test(df) && /^WORKDIR \/work$/m.test(df) && df.includes("proteus-container-entry.js"), df);
}

// ---- win32 (faked): PATHEXT lookup, backslash mount sources, the comma refusal
function onPlatform(name, fn) {
  const was = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: name });
  try { return fn(); } finally { Object.defineProperty(process, "platform", was); }
}
{
  const a = path.join(W, "win-a"), b = path.join(W, "win-b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, "docker.EXE"), "");
  const found = onPlatform("win32", () => C.findRuntime("", { PATH: `${a};${b}`, PATHEXT: ".COM;.EXE" }));
  ok("win32: the runtime is found through PATHEXT on a ;-separated PATH", found && found.name === "docker" && found.bin === path.join(b, "docker.EXE"), JSON.stringify(found));
  const o = { name: "proteus-x", image: "img", memory: "4g", cpus: "2", pids: "512", cred: "ANTHROPIC_API_KEY", in: "C:\\Users\\me\\repo\\.git\\proteus\\scratch\\container-ab\\in", out: "C:\\Users\\me\\repo\\.git\\proteus\\scratch\\container-ab\\out" };
  const args = onPlatform("win32", () => C.runArgs({ name: "docker" }, o));
  ok("win32: a drive-letter mount source is passed whole", args.includes(`type=bind,source=${o.in},target=/in,readonly`) && args.includes(`type=bind,source=${o.out},target=/out`), args.join(" "));
  let threw = "";
  try { onPlatform("win32", () => C.runArgs({ name: "docker" }, { ...o, in: "C:\\a,b\\in" })); } catch (e) { threw = e.message; }
  ok("a comma in a mount source is refused, not split", /comma/.test(threw), threw);
  const env = C.childEnv({ PATH: "x", gh_token: "1", GITHUB_TOKEN: "2", ANTHROPIC_API_KEY: "k" });
  ok("childEnv drops GitHub tokens in any case and keeps the rest", !("gh_token" in env) && !("GITHUB_TOKEN" in env) && env.ANTHROPIC_API_KEY === "k" && env.PATH === "x", JSON.stringify(env));
}

lib.summary();
