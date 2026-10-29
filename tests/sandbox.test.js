// install.js --sandbox (#188): node tests/sandbox.test.js. The profile is a settings file of its own under
// ~/.claude/proteus-sandbox/, never settings.json or settings.local.json; strict sandbox, writes to the repo and the
// temp dir, secrets unreadable, GitHub plus the registries ## Learned names, deny rules for the file tools. Temp HOME
// only; no network, no claude session.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run, g } = lib;
const W = lib.workdir("sandbox");
const HOME = lib.HOME, CLAUDE = path.join(HOME, ".claude");
const INSTALL = path.join(ROOT, "install.js");
const WIN = process.platform === "win32";

const repo = path.join(W, "work", "app");
fs.mkdirSync(path.join(W, "work", "sibling"), { recursive: true });
fs.mkdirSync(repo, { recursive: true });
g(repo, "init", "-q");
fs.writeFileSync(path.join(repo, "AGENTS.md"), "# app\n\n## Learned\n- package manager: npm\n- gates: npm test\n\n## Other\n- python notes\n");
const userSettings = path.join(CLAUDE, "settings.json");
const mine = JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, theme: "dark" }, null, 2) + "\n";
fs.writeFileSync(userSettings, mine);

// the child's temp dir beside the repo, not around it, so the walk has siblings to deny
const TMP = path.join(fs.realpathSync(W), "tmp");
fs.mkdirSync(TMP);
const sandbox = (env = {}, args = ["--sandbox"]) => run(INSTALL, "", { cwd: repo, args, env: { TMPDIR: TMP, ...env } });
const files = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const profileDir = (base = CLAUDE) => path.join(base, "proteus-sandbox");

const XDG = path.join(HOME, "xdg"), HUMAN_GH = path.join(XDG, "gh");
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const realW = fs.realpathSync(W);
const rule = (tool, p2) => `${tool}(/${p2.split(path.sep).join("/")}`;

if (WIN) {
  const r = sandbox();
  ok("win32: --sandbox refuses (no native sandbox) and writes nothing", r.code === 2 && /WSL2/.test(r.err) && !files(profileDir()).length, r.err);
} else {
  g(repo, "commit", "-q", "--allow-empty", "-m", "chore: root");
  const r = sandbox({ XDG_CONFIG_HOME: XDG });
  const made = files(profileDir()).filter((f) => f.endsWith(".json"));
  ok("--sandbox exits 0 and writes one profile under ~/.claude/proteus-sandbox", r.code === 0 && made.length === 1 && /^app-[0-9a-f]{8}\.json$/.test(made[0]), r.err + r.out);
  const file = path.join(profileDir(), made[0] || "x");
  ok("--sandbox prints the launch command with the file and bypassPermissions", r.out.includes(`claude --settings ${file} --permission-mode bypassPermissions`), r.out);
  ok("--sandbox says the review session runs without the profile", /proteus-review\) without it/.test(r.out), r.out);
  ok("--sandbox tells the human to run --project before launching", r.out.includes(`node ${INSTALL} --project`), r.out);
  ok("--sandbox leaves the user's settings.json byte for byte", fs.readFileSync(userSettings, "utf8") === mine);
  ok("--sandbox writes nothing into the repo's .claude", !fs.existsSync(path.join(repo, ".claude")));
  const p = read(file);
  const sb = p.sandbox || {}, fsx = sb.filesystem || {}, net = sb.network || {}, deny = (p.permissions || {}).deny || [];
  const allowWrite = fsx.allowWrite || [], denyRead = fsx.denyRead || [], excluded = sb.excludedCommands || [];
  ok("profile: sandbox on, fail if unavailable, no unsandboxed retry", sb.enabled === true && sb.failIfUnavailable === true && sb.allowUnsandboxedCommands === false, JSON.stringify(sb));
  ok("profile: never sets a permission mode itself", !("defaultMode" in (p.permissions || {})));
  const realRepo = fs.realpathSync(repo);
  ok("profile: writes allowed to the repo", allowWrite.includes(realRepo), JSON.stringify(allowWrite));

  // 6: a per-user scratch dir in the temp dir, private, never the temp dir itself
  const who = typeof process.getuid === "function" ? String(process.getuid()) : require("os").userInfo().username;
  const scratch = path.join(TMP, `proteus-${who}`);
  const sst = fs.lstatSync(scratch, { throwIfNoEntry: false });
  ok("profile: the per-user scratch dir is writable, the temp dir is not", allowWrite.includes(scratch) && !allowWrite.includes(TMP), JSON.stringify(allowWrite));
  ok("scratch dir: made, a real dir, mode 0700", Boolean(sst) && sst.isDirectory() && (sst.mode & 0o777) === 0o700, sst && (sst.mode & 0o777).toString(8));
  ok("profile: Edit denied in the temp dir beside the scratch dir", deny.includes(`${rule("Edit", path.join(TMP, ".*"))})`), deny.filter((d) => d.includes("/tmp")).join(" "));

  // 5: secrets, the human's gh dir always
  ok("profile: credentials unreadable, in the sandbox and to Read",
    ["~/.ssh", "~/.aws", "~/.config/gcloud", "~/.claude/.credentials.json", "~/.git-credentials", "~/.netrc", "~/.npmrc", "~/.docker/config.json", "~/.kube", "~/.gnupg", "~/.local/share/keyrings", "~/Library/Keychains"]
      .every((x) => denyRead.includes(x)) && ["Read(~/.ssh/**)", "Read(~/.netrc)", "Read(~/.kube/**)", "Read(~/.docker/config.json)", "Read(~/.claude/.credentials.json)"].every((x) => deny.includes(x)),
    JSON.stringify(denyRead));
  ok("profile: the human's gh config dir unreadable with no agentGh set", denyRead.includes(HUMAN_GH) && deny.includes(`${rule("Read", HUMAN_GH)}/**)`), JSON.stringify(denyRead));
  ok("profile: Claude Code's own credentials under the config dir unreadable", denyRead.includes(path.join(CLAUDE, ".credentials.json")));
  ok("--sandbox warns that gh has no login without an agent identity", /--agent-login/.test(r.err), r.err);

  ok("profile: strict allowlist of GitHub plus npm from ## Learned, nothing from other sections",
    net.strictAllowlist === true && ["github.com", "*.github.com", "registry.npmjs.org"].every((d) => net.allowedDomains.includes(d)) && !net.allowedDomains.includes("pypi.org"), JSON.stringify(net));
  ok("profile: token env vars kept from sandboxed commands", ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "ANTHROPIC_API_KEY"].every((n) => ((sb.credentials || {}).envVars || []).some((e) => e.name === n && e.mode === "deny")));
  ok("profile: WebFetch and exec or fetch MCP servers denied", ["WebFetch", "mcp__plugin_context-mode_context-mode__*", "mcp__plugin_playwright_playwright__*"].every((x) => deny.includes(x)));

  // 1 and 2: excludedCommands name only the absolute copy, outside every writable path, Edit-denied
  const bins = files(path.join(profileDir(), "bin"));
  const bin = path.join(profileDir(), "bin", bins[0] || "x"), copy = path.join(bin, "proteus-worktree.js");
  ok("copy: proteus-worktree.js and what it requires copied to proteus-sandbox/bin/<hash>",
    bins.length === 1 && ["proteus-worktree.js", "proteus-lib.js", "proteus-harness.js", "proteus-harness-claude.js", "proteus-confine.js", "worktree-settings.local.json"].every((f) => fs.existsSync(path.join(bin, f))), bins.join(" "));
  ok("copy: sandbox-root.json names the repo", read(path.join(bin, "sandbox-root.json")).root === realRepo);
  ok("profile: excludedCommands hold only the absolute copy", excluded.length > 0 && excluded.every((c) => c === `node ${copy} *` || c === `node ${JSON.stringify(copy)} *`), JSON.stringify(excluded));
  ok("profile: no relative or install.js entry in excludedCommands", !excluded.some((c) => /\.claude\/hooks|install\.js/.test(c)));
  ok("profile: the copy is outside every writable path", !allowWrite.some((w) => bin.startsWith(w + path.sep) || bin === w));
  ok("profile: Edit denied on the copies and the profile", deny.includes(`${rule("Edit", profileDir())}/**)`), deny.slice(0, 30).join(" "));

  ok("profile: Edit denied beside the repo, under each dir on the way", deny.includes(`${rule("Edit", path.join(realW, "work", "sibling"))}/**)`));
  ok("profile: Edit denied for new dotfiles beside the repo's parent", deny.includes(`${rule("Edit", path.join(realW, "work", ".*"))})`));
  const ancestors = [];
  for (let d = realRepo; ; d = path.dirname(d)) { ancestors.push(d); if (path.dirname(d) === d) break; }
  for (let d = scratch; ; d = path.dirname(d)) { ancestors.push(d); if (path.dirname(d) === d) break; }
  const opened = (r2) => ancestors.some((a) => r2 === `${rule("Edit", a)}/**)` || r2 === `${rule("Edit", a)})`);
  ok("profile: no Edit rule covers the repo, the scratch dir or a dir above them", !deny.some(opened), deny.filter(opened).join(" "));
  // 7: git config and hooks; NF1: the main config.worktree, made so the exact rule names a file
  const dotGit = path.join(realRepo, ".git");
  ok("profile: Edit denied for the repo's .claude dirs, git config, config.worktree and hooks",
    [`${rule("Edit", realRepo)}/**/.claude/**)`, `${rule("Edit", path.join(dotGit, "config"))})`, `${rule("Edit", path.join(dotGit, "config.worktree"))})`,
      `${rule("Edit", path.join(dotGit, "hooks"))}/**)`].every((x) => deny.includes(x)), deny.slice(0, 16).join(" "));
  ok("--sandbox makes the main config.worktree, empty, so its deny names a file", fs.readFileSync(path.join(dotGit, "config.worktree"), "utf8") === "");
  // NF2: Linux's denyWrite honours only an exact path or a trailing /**, so no .git rule has another wildcard
  const gitRules = (d) => d.filter((x) => x.includes("/.git/"));
  const linuxOk = (x) => /^Edit\(.*\)$/.test(x) && !x.slice(5, -1).replace(/\/\*\*$/, "").includes("*");
  ok("profile: every .git deny rule is exact or ends in /**", gitRules(deny).length >= 3 && gitRules(deny).every(linuxOk), gitRules(deny).filter((x) => !linuxOk(x)).join(" "));

  // gitDenyRules: each worktree, each submodule git dir (nested ones and ones under a name path), no other wildcard
  const C = require(path.join(ROOT, "templates", "hooks", "proteus-confine.js"));
  const fakeGit = path.join(realW, "fake-git");
  for (const d of [["worktrees", "a"], ["modules", "sub"], ["modules", "sub", "modules", "inner"], ["modules", "lib", "deep"]]) {
    fs.mkdirSync(path.join(fakeGit, ...d), { recursive: true });
    if (d[0] === "modules") fs.writeFileSync(path.join(fakeGit, ...d, "HEAD"), "ref: refs/heads/main\n");
  }
  const gr = C.gitDenyRules(fakeGit);
  const want = [["config"], ["config.worktree"], ["hooks", "**"], ["worktrees", "a", "config.worktree"], ["worktrees", "a", "proteus-hooks", "**"],
    ["modules", "sub", "config"], ["modules", "sub", "hooks", "**"], ["modules", "sub", "config.worktree"], ["modules", "sub", "modules", "inner", "config"],
    ["modules", "sub", "modules", "inner", "hooks", "**"], ["modules", "lib", "deep", "config"], ["modules", "lib", "deep", "hooks", "**"]]
    .map((s) => `${rule("Edit", path.join(fakeGit, ...s))})`);
  ok("gitDenyRules: config, config.worktree and hooks for the git dir, each worktree and each submodule, nested too",
    want.every((x) => gr.includes(x)) && !gr.some((x) => x.includes(path.join("modules", "lib") + "/config")), gr.join(" "));
  ok("gitDenyRules: every rule exact or ending in /**", gr.every(linuxOk), gr.filter((x) => !linuxOk(x)).join(" "));

  // 3: the copy prepares only this repo's listed worktrees under .worktrees/
  const runCopy = (...a) => run(copy, "", { cwd: repo, args: a });
  // the in-repo script writes the worktree half, then names the copy; the copy writes the git half only (#212 B1)
  const runTree = (...a) => run(path.join(ROOT, "templates", "hooks", "proteus-worktree.js"), "", { cwd: repo, args: a });
  const w1 = path.join(repo, ".worktrees", "w1");
  g(repo, "worktree", "add", "-q", "-b", "w1", w1);
  const half = runTree(w1, "src/**");
  ok("in-repo script: writes the worktree half and names the copy for the git half",
    half.code === 0 && fs.existsSync(path.join(w1, ".claude", "settings.local.json")) && fs.existsSync(path.join(w1, ".claude", "proteus-owned")) && half.out.includes(`node ${copy} ${fs.realpathSync(w1)}`), half.err + half.out);
  fs.rmSync(path.join(dotGit, "worktrees", "w1", "proteus-hooks"), { recursive: true, force: true });
  fs.rmSync(path.join(w1, ".claude"), { recursive: true, force: true });
  const good = runCopy(w1);
  ok("copy: prepares the git half of a listed worktree under .worktrees/, nothing in the worktree",
    good.code === 0 && fs.existsSync(path.join(dotGit, "worktrees", "w1", "proteus-hooks", "pre-commit")) && !fs.existsSync(path.join(w1, ".claude"))
      && /hooksPath = /.test(fs.readFileSync(path.join(dotGit, "worktrees", "w1", "config.worktree"), "utf8")) && /worktreeConfig = true/i.test(fs.readFileSync(path.join(dotGit, "config"), "utf8")), good.err + good.out);
  ok("copy: sandbox-root.json names the profile", read(path.join(bin, "sandbox-root.json")).profile === file);
  const w1Rules = [["config.worktree"], ["proteus-hooks", "**"]].map((s) => `${rule("Edit", path.join(dotGit, "worktrees", "w1", ...s))})`);
  const after = (read(file).permissions || {}).deny || [];
  ok("copy: preparing a new worktree adds its config.worktree and proteus-hooks denies to the profile",
    !w1Rules.some((x) => deny.includes(x)) && w1Rules.every((x) => after.includes(x)) && deny.every((x) => after.includes(x)), after.filter((x) => x.includes("worktrees")).join(" "));
  const again = runCopy(path.join(repo, ".worktrees", "w1"), "src/**");
  const after2 = (read(file).permissions || {}).deny || [];
  ok("copy: a re-run adds no rule twice", again.code === 0 && after2.length === after.length, again.err);
  const fake = path.join(TMP, "fake");
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, ".git"), `gitdir: ${path.join(realRepo, ".git")}\n`);
  const esc = runCopy(fake, "src/**");
  ok("copy: refuses a /tmp dir whose .git file points at the repo", esc.code === 1 && /refused/.test(esc.err) && !fs.existsSync(path.join(fake, ".claude")), esc.err);
  const esc2 = runCopy(fake, "--allow", "force-push");
  ok("copy: refuses --allow for it too", esc2.code === 1 && /refused/.test(esc2.err), esc2.err);
  const planted = path.join(repo, ".worktrees", "planted");
  fs.mkdirSync(planted);
  fs.writeFileSync(path.join(planted, ".git"), `gitdir: ${path.join(realRepo, ".git", "worktrees", "w1")}\n`);
  const esc3 = runCopy(planted, "src/**");
  ok("copy: refuses a dir under .worktrees/ the repo does not register", esc3.code === 1 && /registers/.test(esc3.err) && !fs.existsSync(path.join(planted, ".claude")), esc3.err);
  const away = path.join(W, "work", "away");
  g(repo, "worktree", "add", "-q", "-b", "away", away);
  const esc4 = runCopy(away, "src/**");
  ok("copy: refuses a listed worktree outside .worktrees/", esc4.code === 1 && /not a checkout under/.test(esc4.err) && !fs.existsSync(path.join(away, ".claude")), esc4.err);
  const w2 = path.join(repo, ".worktrees", "w2"), victim = path.join(W, "victim");
  g(repo, "worktree", "add", "-q", "-b", "w2", w2);
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, path.join(w2, ".claude"));
  const esc5 = runCopy(w2, "src/**");
  ok("copy: writes nothing through a worktree's .claude link", esc5.code === 0 && !files(victim).length, esc5.err);
  // a link at a fixed path under <common> is replaced, never written through; a merged file that is a link refuses
  const outsideFile = path.join(W, "outside-hook");
  fs.writeFileSync(outsideFile, "keep\n");
  fs.rmSync(path.join(dotGit, "worktrees", "w2", "proteus-hooks", "pre-commit"), { force: true });
  fs.symlinkSync(outsideFile, path.join(dotGit, "worktrees", "w2", "proteus-hooks", "pre-commit"));
  const esc6 = runCopy(w2);
  ok("copy: refuses a link at a hook file it writes, leaving its target", esc6.code === 1 && /link/.test(esc6.err) && fs.readFileSync(outsideFile, "utf8") === "keep\n", esc6.err);
  const CB = require(path.join(bin, "proteus-confine.js"));
  const leaf = path.join(W, "leaf");
  fs.mkdirSync(leaf);
  fs.symlinkSync(outsideFile, path.join(leaf, "f"));
  CB.replaceFile(path.join(leaf, "f"), () => "mine\n");
  ok("replaceFile: a link at the path is replaced by a file, its target left", fs.readFileSync(outsideFile, "utf8") === "keep\n" && !fs.lstatSync(path.join(leaf, "f")).isSymbolicLink() && fs.readFileSync(path.join(leaf, "f"), "utf8") === "mine\n");
  fs.symlinkSync(outsideFile, path.join(leaf, "f.lock"));
  let threw = false;
  try { CB.replaceFile(path.join(leaf, "f"), () => "x"); } catch { threw = true; }
  ok("replaceFile: a link at <path>.lock refuses, its target left", threw && fs.readFileSync(outsideFile, "utf8") === "keep\n");

  // the copy opens no path under the worktree: every fs call that opens, reads, makes or moves a path is traced
  const trace = path.join(W, "trace.js"), traced = path.join(W, "traced.txt");
  fs.writeFileSync(trace, `const fs = require("fs"), p = require("path"), log = fs.appendFileSync, out = ${JSON.stringify(traced)};
let busy = false;
const two = new Set(["renameSync", "copyFileSync", "symlinkSync", "linkSync"]);
for (const k of ["openSync", "readFileSync", "writeFileSync", "appendFileSync", "copyFileSync", "cpSync", "mkdirSync", "mkdtempSync", "readdirSync", "opendirSync", "renameSync", "rmSync", "unlinkSync", "rmdirSync", "symlinkSync", "linkSync", "chmodSync", "truncateSync"]) {
  const f = fs[k];
  fs[k] = function (a, b, ...r) {
    if (!busy) { busy = true; try { for (const x of two.has(k) ? [a, b] : [a]) if (typeof x === "string") log(out, k + " " + p.resolve(x) + "\\n"); } finally { busy = false; } }
    return f.call(this, a, b, ...r);
  };
}
`);
  const w5 = path.join(repo, ".worktrees", "w5");
  g(repo, "worktree", "add", "-q", "-b", "w5", w5);
  for (const a of [[w5, "src/**"], [w5, "--allow", "force-push"]]) {
    fs.mkdirSync(path.join(w5, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(w5, ".claude", "proteus-owned"), "src/**\n");
    fs.rmSync(traced, { force: true });
    const tr = run(copy, "", { cwd: repo, args: a, env: { NODE_OPTIONS: `--require ${JSON.stringify(trace)}` } });
    const opened = files(W).includes("traced.txt") ? fs.readFileSync(traced, "utf8").split("\n").filter(Boolean) : [];
    const realW5 = fs.realpathSync(w5);
    const inTree = opened.filter((l) => [w5, realW5].some((d) => l.split(" ").slice(1).join(" ").startsWith(d + path.sep) || l.endsWith(" " + d)));
    ok(`copy ${a.slice(1).join(" ")}: opens no path under the worktree (${opened.length} traced)`, tr.code === 0 && opened.length > 0 && !inTree.length, inTree.join(" ") + tr.err);
  }

  // the copy's main root and state dir come from sandbox-root.json: a worktree's planted .git file and commondir,
  // the cwd and CLAUDE_PROJECT_DIR move neither
  const w3 = path.join(repo, ".worktrees", "w3"), evil = path.join(w3, "evil");
  g(repo, "worktree", "add", "-q", "-b", "w3", w3);
  ok("copy: prepares w3", runTree(w3, "src/**").code === 0 && runCopy(w3).code === 0);
  fs.mkdirSync(path.join(evil, "gd"), { recursive: true });
  fs.mkdirSync(path.join(evil, "common", "info"), { recursive: true });
  fs.writeFileSync(path.join(evil, "gd", "commondir"), "../common\n");
  fs.writeFileSync(path.join(w3, ".git"), `gitdir: ${path.join(evil, "gd")}\n`);
  fs.writeFileSync(path.join(dotGit, "worktrees", "w3", "commondir"), path.join(evil, "common") + "\n");
  const plantEnv = { env: { CLAUDE_PROJECT_DIR: evil } };
  const pa = run(copy, "", { cwd: w3, args: [w3, "--allow", "force-push"], ...plantEnv });
  ok("copy: a planted .git file and commondir leave --allow's state in the repo's <common>/proteus",
    pa.code === 0 && files(path.join(dotGit, "proteus", "allow")).some((f) => f.startsWith("w3-")) && !fs.existsSync(path.join(evil, "common", "proteus")), pa.err + pa.out);
  const pp = run(copy, "", { cwd: w3, args: [w3, "src/**"], ...plantEnv });
  ok("copy: ... and preparing writes the repo's info/exclude and git dir, none of the planted ones",
    pp.code === 0 && !files(path.join(evil, "common", "info")).length && !fs.existsSync(path.join(evil, "gd", "proteus-hooks"))
      && fs.existsSync(path.join(dotGit, "worktrees", "w3", "proteus-hooks", "pre-commit")), pp.err + pp.out);
  const probe = `const l = require(${JSON.stringify(path.join(bin, "proteus-lib.js"))}); const p = require(${JSON.stringify(path.join(bin, "sandbox-root.json"))});
l.pinProject(p.root, p.common); const c = l.gitCommonDir(${JSON.stringify(w3)});
console.log(JSON.stringify({ c, state: c && l.stateDir(c), main: l.mainRoot(c), project: l.projectRoot({}), git: l.repoCommon(${JSON.stringify(w3)}), out: l.gitCommonDir(${JSON.stringify(fake)}) }));`;
  let seen = {};
  try { seen = JSON.parse(require("child_process").execFileSync(process.execPath, ["-e", probe], { cwd: evil, env: { ...process.env, CLAUDE_PROJECT_DIR: evil }, encoding: "utf8" })); } catch {}
  ok("pinned lib: the common dir, state dir, main root and project root are sandbox-root.json's despite the plants",
    seen.c === dotGit && seen.state === path.join(dotGit, "proteus") && seen.main === realRepo && seen.project === realRepo && seen.git === dotGit, JSON.stringify(seen));
  ok("pinned lib: a dir outside the pinned repo has no common dir, whatever its .git file says", seen.out === null, JSON.stringify(seen));

  // a copy with no sandbox-root.json, or an unreadable one, refuses rather than falling back
  const bare = path.join(W, "cfg2", "proteus-sandbox", "bin", "deadbeef");
  fs.mkdirSync(bare, { recursive: true });
  for (const f of files(bin)) if (f !== "sandbox-root.json") fs.copyFileSync(path.join(bin, f), path.join(bare, f));
  const w1Hooks = path.join(dotGit, "worktrees", "w1", "proteus-hooks");
  fs.rmSync(w1Hooks, { recursive: true, force: true });
  const nopin = run(path.join(bare, "proteus-worktree.js"), "", { cwd: repo, args: [path.join(repo, ".worktrees", "w1"), "src/**"] });
  ok("copy: no sandbox-root.json refuses and writes nothing", nopin.code === 1 && /sandbox-root\.json/.test(nopin.err) && !fs.existsSync(w1Hooks), nopin.err + nopin.out);
  const noallow = run(path.join(bare, "proteus-worktree.js"), "", { cwd: repo, args: [w1, "--allow", "force-push"] });
  ok("copy: no sandbox-root.json refuses --allow too", noallow.code === 1 && /sandbox-root\.json/.test(noallow.err), noallow.err);
  fs.writeFileSync(path.join(bare, "sandbox-root.json"), "{not json");
  const badpin = run(path.join(bare, "proteus-worktree.js"), "", { cwd: repo, args: [w1, "src/**"] });
  ok("copy: an unreadable sandbox-root.json refuses", badpin.code === 1 && /sandbox-root\.json/.test(badpin.err) && !fs.existsSync(w1Hooks), badpin.err);

  // guest.json sits under <common>, where sandboxed commands write: --sandbox makes writable only the fixed guest dir
  // ~/.proteus/guest/<repo>-<hash>, and warns about and leaves out any other dir it names (#212 B2)
  const guestJson = path.join(dotGit, "proteus", "guest.json"), planted2 = path.join(HOME, ".config");
  fs.mkdirSync(path.dirname(guestJson), { recursive: true });
  fs.writeFileSync(guestJson, JSON.stringify({ dir: planted2 }));
  const gp = sandbox({ XDG_CONFIG_HOME: XDG });
  const gw = ((read(file).sandbox || {}).filesystem || {}).allowWrite || [];
  const fixedGuest = path.join(HOME, ".proteus", "guest", `app-${require("crypto").createHash("sha256").update(dotGit).digest("hex").slice(0, 8)}`);
  ok("guest: a planted guest.json naming another dir does not reach allowWrite, and is warned about naming both",
    gp.code === 0 && !gw.some((w) => w.startsWith(planted2)) && gp.err.includes(planted2) && gp.err.includes(fixedGuest), gw.join(" ") + gp.err);
  fs.writeFileSync(guestJson, JSON.stringify({ dir: fixedGuest }));
  const gf = sandbox({ XDG_CONFIG_HOME: XDG });
  const gw2 = ((read(file).sandbox || {}).filesystem || {}).allowWrite || [];
  ok("guest: guest.json naming the fixed guest dir makes it writable and --sandbox prints it", gf.code === 0 && gw2.includes(fixedGuest) && gf.out.includes(fixedGuest), gw2.join(" ") + gf.err);
  fs.rmSync(guestJson);

  // agentGh set: the human's gh dir still unreadable, the agents' own readable; the profile is rewritten in place
  const agent = path.join(HOME, ".config", "gh-proteus");
  fs.writeFileSync(path.join(CLAUDE, "proteus.json"), JSON.stringify({ agentGh: agent, human: "me" }));
  const r2 = sandbox({ XDG_CONFIG_HOME: XDG });
  const p2 = read(file), d2 = ((p2.sandbox || {}).filesystem || {}).denyRead || [];
  ok("agentGh: the human's gh config dir is denied, the agents' own is not", r2.code === 0 && d2.includes(HUMAN_GH) && !d2.includes(agent), JSON.stringify(d2));

  // CLAUDE_CONFIG_DIR moves the profile and the copy with the rest of Claude Code's config
  const alt = path.join(W, "alt-claude");
  const r3 = sandbox({ CLAUDE_CONFIG_DIR: alt });
  ok("CLAUDE_CONFIG_DIR: the profile and the copy go under it", r3.code === 0 && files(profileDir(alt)).filter((f) => f.endsWith(".json")).length === 1 && files(path.join(profileDir(alt), "bin")).length === 1, r3.err);
  // 1: refused when the copy would land where sandboxed commands write
  const inRepo = sandbox({ CLAUDE_CONFIG_DIR: path.join(repo, "cfg") });
  ok("--sandbox refuses a config dir inside the repo", inRepo.code === 2 && /CLAUDE_CONFIG_DIR/.test(inRepo.err) && !fs.existsSync(path.join(repo, "cfg")), inRepo.err);
  const inTmp = sandbox({ CLAUDE_CONFIG_DIR: path.join(scratch, "cfg") });
  ok("--sandbox refuses a config dir inside the scratch dir", inTmp.code === 2 && !fs.existsSync(path.join(scratch, "cfg")), inTmp.err);
}

// flags
const r4 = sandbox({}, ["--sandbox", "--project"]);
ok("--sandbox takes no other flag", r4.code === 2 && /--sandbox takes no other flag/.test(r4.err), r4.err);
const r5 = sandbox({}, ["--sandbox", "--harness", "codex"]);
ok("--sandbox refuses Codex, which has its own sandbox", r5.code === 2 && /Codex/.test(r5.err), r5.err);
const outside = path.join(W, "nogit");
fs.mkdirSync(outside);
const r6 = run(INSTALL, "", { cwd: outside, args: ["--sandbox"], env: { GIT_CEILING_DIRECTORIES: W } });
ok("--sandbox outside a git repo refuses", r6.code === 2, r6.err);

// docs
const install = fs.readFileSync(path.join(ROOT, "docs", "install.md"), "utf8");
const sec = (/^## Sandboxed bypass\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(install) || [])[1] || "";
ok("docs/install.md: a Sandboxed bypass section", Boolean(sec));
ok("docs/install.md: it names the residuals (prompt injection, file tools, gh token, identity=separate)",
  /prompt injection/i.test(sec) && /Read, Edit and Write/.test(sec) && /identity=separate/.test(sec) && /token/.test(sec), sec.slice(0, 300));
ok("docs/install.md: the review session runs outside bypass", /proteus-review/.test(sec) && /outside|without/.test(sec));

lib.summary();
