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

  // 1 and 2: excludedCommands name only the absolute copies, outside every writable path, Edit-denied
  const bins = files(path.join(profileDir(), "bin"));
  const bin = path.join(profileDir(), "bin", bins[0] || "x"), copy = path.join(bin, "proteus-worktree.js");
  ok("copy: proteus-worktree.js and what it requires copied to proteus-sandbox/bin/<hash>",
    bins.length === 1 && ["proteus-worktree.js", "proteus-lib.js", "proteus-harness.js", "proteus-harness-claude.js", "proteus-confine.js", "worktree-settings.local.json"].every((f) => fs.existsSync(path.join(bin, f))), bins.join(" "));
  ok("copy: sandbox-root.json names the repo", read(path.join(bin, "sandbox-root.json")).root === realRepo);
  const box = path.join(bin, "proteus-container.js"), named = (c, f) => c === `node ${f} *` || c === `node ${JSON.stringify(f)} *`;
  ok("profile: excludedCommands hold only the absolute copies", excluded.length > 0 && excluded.every((c) => named(c, copy) || named(c, box)), JSON.stringify(excluded));
  ok("copy: the container runner and its entrypoint are in bin, and excludedCommands name the runner (#80)",
    ["proteus-container.js", "proteus-container-entry.js"].every((f) => fs.existsSync(path.join(bin, f))) && excluded.some((c) => named(c, box)), JSON.stringify(excluded));
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
  // a write the profile refuses on Linux too: a rule of the two forms Linux honours names the path or a dir above it
  const deniedOnLinux = (p2) => deny.filter(linuxOk).some((x) => {
    const at = x.slice(6, -1);
    return at.endsWith("/**") ? p2.startsWith(at.slice(0, -2)) : at === p2;
  });
  // #237: the lead's state, which the hooks write outside the sandbox, made before the profile and denied by it
  const leadDir = path.join(dotGit, "proteus-lead"), lst = fs.lstatSync(leadDir, { throwIfNoEntry: false });
  ok("--sandbox makes <common>/proteus-lead, a real dir, mode 0700", Boolean(lst) && lst.isDirectory() && !lst.isSymbolicLink() && (lst.mode & 0o777) === 0o700, lst && (lst.mode & 0o777).toString(8));
  ok("profile: an agent write to <common>/proteus-lead is denied", deny.includes(`${rule("Edit", leadDir)}/**)`)
    && deniedOnLinux(path.join(leadDir, "journal.jsonl")) && deniedOnLinux(path.join(leadDir, "agents", "x.json")), deny.filter((x) => x.includes("proteus-lead")).join(" "));
  // #237 r2: the root's hooks and settings, which the plugin's SessionStart acts on outside the sandbox
  ok("profile: an agent write to the root's .claude/hooks is denied", deniedOnLinux(path.join(realRepo, ".claude", "hooks", "proteus-lib.js")),
    deny.filter((x) => x.includes(".claude")).join(" "));
  ok("profile: an agent write to the root's .claude/settings files is denied, exactly too", ["settings.json", "settings.local.json"]
    .every((f) => deniedOnLinux(path.join(realRepo, ".claude", f)) && deny.includes(`${rule("Edit", path.join(realRepo, ".claude", f))})`)), deny.filter((x) => x.includes(".claude")).join(" "));
  // #212 B8, B9: the root's whole .claude/ by a rule Linux honours: skills, whose SKILL.md hooks: run outside the
  // sandbox once the skill loads, and workflows, which Claude Code runs in its own process
  ok("profile: an agent write to the root's .claude/ is denied, by a rule Linux honours", deny.includes(`${rule("Edit", path.join(realRepo, ".claude"))}/**)`)
    && ["skills/x/SKILL.md", "workflows/x.js", "agents/x.md", "settings.local.json"].every((f) => deniedOnLinux(path.join(realRepo, ".claude", ...f.split("/")))), deny.filter((x) => x.includes(".claude")).join(" "));
  // proteus-lead a link or a file: --sandbox refuses, writes no profile and nothing through the link
  const leadVictim = path.join(W, "lead-victim"), leadAside = path.join(W, "lead-aside");
  fs.mkdirSync(leadVictim);
  fs.renameSync(leadDir, leadAside);
  fs.rmSync(file);
  fs.symlinkSync(leadVictim, leadDir);
  const ll = sandbox({ XDG_CONFIG_HOME: XDG });
  ok("--sandbox refuses a link at <common>/proteus-lead, writing no profile and nothing through it",
    ll.code === 1 && /proteus-lead/.test(ll.err) && !fs.existsSync(file) && !files(leadVictim).length, ll.err);
  fs.unlinkSync(leadDir);
  fs.writeFileSync(leadDir, "");
  const lf = sandbox({ XDG_CONFIG_HOME: XDG });
  ok("--sandbox refuses a file at <common>/proteus-lead and writes no profile", lf.code === 1 && /proteus-lead/.test(lf.err) && !fs.existsSync(file), lf.err);
  fs.unlinkSync(leadDir);
  fs.renameSync(leadAside, leadDir);
  ok("--sandbox writes the profile again once proteus-lead is a real dir", sandbox({ XDG_CONFIG_HOME: XDG }).code === 0 && fs.existsSync(file));
  // a proteus-lead made before, more open than 0700: --sandbox makes it private again
  fs.chmodSync(leadDir, 0o755);
  sandbox({ XDG_CONFIG_HOME: XDG });
  ok("--sandbox makes an existing <common>/proteus-lead mode 0700", (fs.statSync(leadDir).mode & 0o777) === 0o700, (fs.statSync(leadDir).mode & 0o777).toString(8));

  // #212 B7: a 1.x home proteus.json names in this profile's write set (self-hosted in the repo) or in another repo's
  // profile is refused: exit 1, no profile and no copy written, the plugin or a move named. A home outside every one
  // is not
  const CFG = path.join(CLAUDE, "proteus.json"), hadCfg = fs.existsSync(CFG) ? fs.readFileSync(CFG) : null;
  const OUTHOME = path.join(W, "release-home");
  fs.mkdirSync(OUTHOME, { recursive: true });
  const pinFile = path.join(files(path.join(profileDir(), "bin")).map((b) => path.join(profileDir(), "bin", b))[0] || "x", "sandbox-root.json");
  const refused = (home) => {
    fs.writeFileSync(CFG, JSON.stringify({ home }));
    fs.rmSync(file, { force: true });
    const pinned = fs.statSync(pinFile).mtimeMs;
    const r = sandbox({ XDG_CONFIG_HOME: XDG });
    return { r, hit: r.code === 1 && r.err.includes(home) && /as a plugin/.test(r.err) && /move the home outside every sandboxed repo/.test(r.err)
      && /nothing written/.test(r.err) && !fs.existsSync(file) && fs.statSync(pinFile).mtimeMs === pinned };
  };
  const self = refused(repo);
  ok("--sandbox refuses a self-hosted home (inside the repo), writing nothing and naming the plugin or a move", self.hit, self.r.err);
  const OTHER = path.join(W, "work", "other-proteus");
  fs.mkdirSync(OTHER, { recursive: true });
  const otherProfile = path.join(profileDir(), "other-proteus-12345678.json");
  fs.writeFileSync(otherProfile, JSON.stringify({ sandbox: { filesystem: { allowWrite: [OTHER] } } }));
  const other = refused(OTHER);
  ok("--sandbox refuses a home in another repo's profile write set, writing nothing", other.hit, other.r.err);
  fs.rmSync(otherProfile);
  fs.writeFileSync(CFG, JSON.stringify({ home: OUTHOME }));
  const out = sandbox({ XDG_CONFIG_HOME: XDG });
  ok("--sandbox accepts a home outside every writable place", out.code === 0 && !/the Proteus 1\.x home/.test(out.err) && fs.existsSync(file), out.err);
  if (hadCfg) fs.writeFileSync(CFG, hadCfg); else fs.rmSync(CFG);

  // gitDenyRules: each submodule git dir (nested ones and ones under a name path), no worktree's, no other wildcard
  const C = require(path.join(ROOT, "templates", "hooks", "proteus-confine.js"));
  const fakeGit = path.join(realW, "fake-git");
  for (const d of [["worktrees", "a"], ["modules", "sub"], ["modules", "sub", "modules", "inner"], ["modules", "lib", "deep"]]) {
    fs.mkdirSync(path.join(fakeGit, ...d), { recursive: true });
    if (d[0] === "modules") fs.writeFileSync(path.join(fakeGit, ...d, "HEAD"), "ref: refs/heads/main\n");
  }
  const gr = C.gitDenyRules(fakeGit);
  const want = [["config"], ["config.worktree"], ["hooks", "**"],
    ["modules", "sub", "config"], ["modules", "sub", "hooks", "**"], ["modules", "sub", "config.worktree"], ["modules", "sub", "modules", "inner", "config"],
    ["modules", "sub", "modules", "inner", "hooks", "**"], ["modules", "lib", "deep", "config"], ["modules", "lib", "deep", "hooks", "**"]]
    .map((s) => `${rule("Edit", path.join(fakeGit, ...s))})`);
  ok("gitDenyRules: config, config.worktree and hooks for the git dir and each submodule, nested too",
    want.every((x) => gr.includes(x)) && !gr.some((x) => x.includes(path.join("modules", "lib") + "/config")), gr.join(" "));
  ok("gitDenyRules: no rule for a worktree's config.worktree or proteus-hooks (#212 r5)", !gr.some((x) => x.includes("/worktrees/")), gr.join(" "));
  ok("gitDenyRules: every rule exact or ending in /**", gr.every(linuxOk), gr.filter((x) => !linuxOk(x)).join(" "));
  ok("--sandbox sets extensions.worktreeConfig in <common>/config before any session", /worktreeConfig = true/i.test(fs.readFileSync(path.join(dotGit, "config"), "utf8")));

  // 3: the in-repo script prepares a worktree whole, sandboxed; the copy that runs outside the sandbox writes nothing
  // under <common> (#212 r5), only the profile's deny rules
  const runCopy = (...a) => run(copy, "", { cwd: repo, args: a });
  const runTree = (...a) => run(path.join(ROOT, "templates", "hooks", "proteus-worktree.js"), "", { cwd: repo, args: a });
  const w1 = path.join(repo, ".worktrees", "w1");
  g(repo, "worktree", "add", "-q", "-b", "w1", w1);
  const half = runTree(w1, "src/**");
  ok("in-repo script: writes the worktree's .claude, hooks and config.worktree, and names the copy",
    half.code === 0 && fs.existsSync(path.join(w1, ".claude", "settings.local.json")) && fs.existsSync(path.join(w1, ".claude", "proteus-owned"))
      && fs.existsSync(path.join(dotGit, "worktrees", "w1", "proteus-hooks", "pre-commit")) && /hooksPath = /.test(fs.readFileSync(path.join(dotGit, "worktrees", "w1", "config.worktree"), "utf8"))
      && half.out.includes(`node ${copy} ${fs.realpathSync(w1)}`), half.err + half.out);
  // the profile names the temp dir's other entries, and other test files make and remove those, so compare this one step
  const denyBefore = (read(file).permissions || {}).deny || [];
  const good = runCopy(w1);
  ok("copy: takes a listed worktree under .worktrees/", good.code === 0, good.err + good.out);
  ok("copy: sandbox-root.json names the profile", read(path.join(bin, "sandbox-root.json")).profile === file);
  const after = (read(file).permissions || {}).deny || [];
  ok("copy: adds no worktree rule to the profile", denyBefore.every((x) => after.includes(x)) && !after.some((x) => x.includes("/worktrees/")), after.filter((x) => x.includes("worktrees")).join(" "));
  const sub = path.join(dotGit, "modules", "sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "HEAD"), "ref: refs/heads/main\n");
  const subRule = `${rule("Edit", path.join(sub, "config"))})`;
  const withSub = runCopy(w1), after1 = (read(file).permissions || {}).deny || [];
  ok("copy: adds a new submodule's deny rules to the profile", withSub.code === 0 && !after.includes(subRule) && after1.includes(subRule), withSub.err + after1.filter((x) => x.includes("modules")).join(" "));
  const again = runCopy(w1);
  ok("copy: a re-run adds no rule twice", again.code === 0 && ((read(file).permissions || {}).deny || []).length === after1.length, again.err);
  fs.rmSync(path.join(dotGit, "modules"), { recursive: true, force: true });
  g(repo, "config", "--unset", "extensions.worktreeConfig");
  const off = runCopy(w1);
  ok("copy: refuses when extensions.worktreeConfig is missing, naming install.js --sandbox, and sets nothing",
    off.code === 1 && /extensions\.worktreeConfig/.test(off.err) && /install\.js --sandbox/.test(off.err) && !/worktreeConfig/i.test(fs.readFileSync(path.join(dotGit, "config"), "utf8")), off.err);
  g(repo, "config", "extensions.worktreeConfig", "true");
  const al = runCopy(w1, "--allow", "force-push");
  ok("copy: refuses --allow, which the in-repo script writes", al.code === 1 && /in-repo/.test(al.err) && !files(path.join(dotGit, "proteus", "allow")).length, al.err);
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

  // the copy writes nothing a sandboxed command can write: every fs call that opens, reads, makes or moves a path is
  // traced, with the flags it opens with, and every command it runs
  const trace = path.join(W, "trace.js"), traced = path.join(W, "traced.txt");
  fs.writeFileSync(trace, `const fs = require("fs"), cp = require("child_process"), p = require("path"), log = fs.appendFileSync, out = ${JSON.stringify(traced)};
let busy = false;
const note = (s) => { if (!busy) { busy = true; try { log(out, s + "\\n"); } finally { busy = false; } } };
const READ = new Set(["readFileSync", "readdirSync", "opendirSync", "readlinkSync", "realpathSync", "statSync", "lstatSync", "existsSync", "accessSync"]);
const two = new Set(["renameSync", "copyFileSync", "symlinkSync", "linkSync", "cpSync"]);
for (const k of ["openSync", "readFileSync", "writeFileSync", "appendFileSync", "copyFileSync", "cpSync", "mkdirSync", "mkdtempSync", "readdirSync", "opendirSync", "renameSync", "rmSync", "unlinkSync", "rmdirSync", "symlinkSync", "linkSync", "chmodSync", "chownSync", "utimesSync", "truncateSync", "createWriteStream"]) {
  const f = fs[k];
  fs[k] = function (a, b, ...r) {
    const kind = k === "openSync" ? (b === undefined || b === "r" || (typeof b === "number" && (b & 3) === 0) ? "read" : "write") : READ.has(k) ? "read" : "write";
    for (const x of two.has(k) ? [a, b] : [a]) if (typeof x === "string") note(kind + " " + k + " " + p.resolve(x));
    return f.call(this, a, b, ...r);
  };
}
for (const k of ["execFileSync", "spawnSync", "execSync", "spawn", "execFile", "exec"]) {
  const f = cp[k];
  cp[k] = function (c, a, ...r) { note("run " + k + " " + JSON.stringify([c, Array.isArray(a) ? a : []])); return f.call(this, c, a, ...r); };
}
`);
  const writable = allowWrite.map((w) => fs.realpathSync(w));
  const underAny = (x, dirs) => dirs.some((d) => x === d || x.startsWith(d + path.sep));
  const w5 = path.join(repo, ".worktrees", "w5");
  g(repo, "worktree", "add", "-q", "-b", "w5", w5);
  ok("in-repo script: prepares w5", runTree(w5, "src/**").code === 0);
  for (const a of [[w5], [w5, "src/**"], [w5, "--allow", "force-push"]]) {
    fs.rmSync(traced, { force: true });
    const tr = run(copy, "", { cwd: repo, args: a, env: { NODE_OPTIONS: `--require ${JSON.stringify(trace)}` } });
    const lines = files(W).includes("traced.txt") ? fs.readFileSync(traced, "utf8").split("\n").filter(Boolean) : [];
    const fsLines = lines.filter((l) => !l.startsWith("run ")), at = (l) => l.split(" ").slice(2).join(" ");
    const realW5 = fs.realpathSync(w5);
    const inTree = fsLines.filter((l) => [w5, realW5].some((d) => at(l).startsWith(d + path.sep) || at(l) === d));
    const label = a.slice(1).join(" ") || "(no paths)";
    ok(`copy ${label}: opens no path under the worktree (${fsLines.length} traced)`, (a[1] === "--allow" ? tr.code === 1 : tr.code === 0) && fsLines.length > 0 && !inTree.length, inTree.join(" ") + tr.err);
    const writes = fsLines.filter((l) => l.startsWith("write ")), bad = writes.filter((l) => underAny(at(l), writable) || !underAny(at(l), [profileDir()]));
    ok(`copy ${label}: opens nothing for writing under a profile-writable path, only the profile (${writes.length} writes)`, !bad.length, bad.join(" "));
    const runs = lines.filter((l) => l.startsWith("run ")).map((l) => JSON.parse(l.split(" ").slice(2).join(" ")));
    const writer = runs.filter(([c, args]) => !(/git/.test(path.basename(String(c))) && args.includes("config") && args.includes("--get")));
    ok(`copy ${label}: runs only git config --get (${runs.length} runs)`, !writer.length, JSON.stringify(writer));
  }

  // a sandboxed swapper, while the copy runs: it plants every lock the copy used to make (config, config.worktree,
  // the worktree's hooks, info/exclude, allow) and flips every parent dir it used to write in for a link to a dir
  // outside allowWrite. Nothing under <common> or outside changes but what the swapper itself did (#212 r5 B3, B4)
  const w6 = path.join(repo, ".worktrees", "w6"), outsideDir = path.join(W, "outside");
  g(repo, "worktree", "add", "-q", "-b", "w6", w6);
  ok("in-repo script: prepares w6", runTree(w6, "src/**").code === 0);
  fs.mkdirSync(outsideDir);
  const swapper = path.join(W, "swapper.js"), sig = (n) => path.join(W, `swap-${n}`);
  fs.writeFileSync(swapper, `const fs = require("fs"), path = require("path");
const [common, outside, dir] = process.argv.slice(2), sig = (n) => path.join(dir, "swap-" + n);
const EVIL = "[core]\\n\\tfsmonitor = \\"touch PWNED; false\\"\\n", w = path.join(common, "worktrees", "w6");
const locks = ["config", "config.worktree", "info/exclude", "proteus/allow/w6.lock-target", "worktrees/w6/config.worktree", "worktrees/w6/proteus-hooks/pre-commit",
  "worktrees/w6/proteus-hooks/commit-msg", "worktrees/w6/proteus-hooks/orig-hooks-path"].map((f) => path.join(common, ...f.split("/")) + ".lock");
const parents = [path.join(w, "proteus-hooks"), path.join(common, "info"), path.join(common, "proteus", "allow"), w];
const plant = () => { let n = 0; for (const l of locks) { if (!fs.existsSync(l)) { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.writeFileSync(l, EVIL); n++; } } return n; };
plant();
fs.writeFileSync(sig("ready"), "");
while (!fs.existsSync(sig("go"))) {}
let flips = 0, replanted = 0;
const restore = () => { for (const q of [...parents].reverse()) { try { if (fs.lstatSync(q).isSymbolicLink()) { fs.unlinkSync(q); fs.renameSync(q + ".aside", q); } } catch {} } };
while (!fs.existsSync(sig("stop"))) {
  for (const q of parents) { try { fs.renameSync(q, q + ".aside"); fs.symlinkSync(outside, q); flips++; } catch {} }
  restore();
  replanted += plant();
}
restore();
fs.writeFileSync(sig("done"), JSON.stringify({ flips, replanted }));
`);
  const snap = (d) => {
    const m = {};
    const walk = (x, rel) => {
      const st = fs.lstatSync(x, { throwIfNoEntry: false });
      if (!st) return;
      if (st.isSymbolicLink()) m[rel] = "link " + fs.readlinkSync(x);
      else if (st.isDirectory()) { m[rel] = "dir"; for (const n of fs.readdirSync(x).sort()) walk(path.join(x, n), rel + "/" + n); }
      else m[rel] = "file " + (st.mode & 0o777).toString(8) + " " + fs.readFileSync(x, "utf8");
    };
    walk(d, "");
    return JSON.stringify(m);
  };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const waitFor = (f) => { for (let i = 0; i < 600 && !fs.existsSync(f); i++) nap(50); return fs.existsSync(f); };
  const sw = require("child_process").spawn(process.execPath, [swapper, dotGit, outsideDir, W], { stdio: "ignore" });
  const ready = waitFor(sig("ready"));
  const before = [snap(dotGit), snap(outsideDir)];
  fs.writeFileSync(sig("go"), "");
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push(runCopy(w6).code);
  fs.writeFileSync(sig("stop"), "");
  const done = waitFor(sig("done"));
  const swapped = done ? JSON.parse(fs.readFileSync(sig("done"), "utf8")) : {};
  sw.kill();
  ok(`swapper: ran while the copy did (${swapped.flips} parent flips; copy exits ${codes.join(",")})`, ready && done && swapped.flips > 0, JSON.stringify(swapped));
  ok("swapper: every lock it planted is left as planted and none was taken, nothing under <common> changed",
    swapped.replanted === 0 && snap(dotGit) === before[0], `replanted ${swapped.replanted}`);
  ok("swapper: nothing landed in the dir outside allowWrite, and <common>/config holds none of its text",
    snap(outsideDir) === before[1] && !files(outsideDir).length && !/PWNED/.test(fs.readFileSync(path.join(dotGit, "config"), "utf8")) && !/PWNED/.test(fs.readFileSync(path.join(dotGit, "config.worktree"), "utf8")));
  for (const f of fs.readdirSync(dotGit, { recursive: true })) if (String(f).endsWith(".lock")) fs.rmSync(path.join(dotGit, String(f)), { force: true });

  // the copy's main root and state dir come from sandbox-root.json: a worktree's planted .git file and commondir,
  // the cwd and CLAUDE_PROJECT_DIR move neither
  const w3 = path.join(repo, ".worktrees", "w3"), evil = path.join(w3, "evil");
  g(repo, "worktree", "add", "-q", "-b", "w3", w3);
  ok("in-repo script and copy: prepare w3", runTree(w3, "src/**").code === 0 && runCopy(w3).code === 0);
  fs.mkdirSync(path.join(evil, "gd"), { recursive: true });
  fs.mkdirSync(path.join(evil, "common", "info"), { recursive: true });
  fs.writeFileSync(path.join(evil, "gd", "commondir"), "../common\n");
  fs.writeFileSync(path.join(w3, ".git"), `gitdir: ${path.join(evil, "gd")}\n`);
  fs.writeFileSync(path.join(dotGit, "worktrees", "w3", "commondir"), path.join(evil, "common") + "\n");
  const plantEnv = { env: { CLAUDE_PROJECT_DIR: evil } };
  const pa = run(copy, "", { cwd: w3, args: [w3, "--allow", "force-push"], ...plantEnv });
  ok("copy: with a planted .git file and commondir, still refuses --allow", pa.code === 1 && /in-repo/.test(pa.err), pa.err + pa.out);
  const pp = run(copy, "", { cwd: w3, args: [w3, "src/**"], ...plantEnv });
  ok("copy: ... and writes none of the planted dirs", !files(path.join(evil, "common", "info")).length && !fs.existsSync(path.join(evil, "gd", "proteus-hooks"))
    && !fs.existsSync(path.join(evil, "common", "proteus")), pp.err + pp.out);
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
  const cfg2Env = { CLAUDE_CONFIG_DIR: path.join(W, "cfg2") }; // the copies sit in its config dir's bin (#234)
  fs.mkdirSync(bare, { recursive: true });
  for (const f of files(bin)) if (f !== "sandbox-root.json") fs.copyFileSync(path.join(bin, f), path.join(bare, f));
  const w1Hooks = path.join(dotGit, "worktrees", "w1", "proteus-hooks");
  fs.rmSync(w1Hooks, { recursive: true, force: true });
  const nopin = run(path.join(bare, "proteus-worktree.js"), "", { cwd: repo, args: [path.join(repo, ".worktrees", "w1"), "src/**"], env: cfg2Env });
  ok("copy: no sandbox-root.json refuses and writes nothing", nopin.code === 1 && /sandbox-root\.json/.test(nopin.err) && !fs.existsSync(w1Hooks), nopin.err + nopin.out);
  const noallow = run(path.join(bare, "proteus-worktree.js"), "", { cwd: repo, args: [w1, "--allow", "force-push"], env: cfg2Env });
  ok("copy: no sandbox-root.json refuses --allow too", noallow.code === 1 && /sandbox-root\.json/.test(noallow.err), noallow.err);
  fs.writeFileSync(path.join(bare, "sandbox-root.json"), "{not json");
  const badpin = run(path.join(bare, "proteus-worktree.js"), "", { cwd: repo, args: [w1, "src/**"], env: cfg2Env });
  ok("copy: an unreadable sandbox-root.json refuses", badpin.code === 1 && /sandbox-root\.json/.test(badpin.err) && !fs.existsSync(w1Hooks), badpin.err);

  // #212 B8: a Proteus statusLine whose script sandboxed commands can write (--project's teams/ copy) is pointed at the
  // copy in bin; Claude Code runs it outside the sandbox. One outside the write set and a foreign one are left alone,
  // the foreign one named in a warning. Then the rewritten command runs, as Claude Code runs it, after an agent edit
  {
    const local = path.join(repo, ".claude", "settings.local.json"), shared = path.join(repo, ".claude", "settings.json");
    const teamHooks = path.join(repo, "teams", "templates", "hooks");
    fs.mkdirSync(path.dirname(teamHooks), { recursive: true });
    fs.cpSync(path.join(ROOT, "templates", "hooks"), teamHooks, { recursive: true });
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const inRepo = path.join(teamHooks, "proteus-statusline.js").split(path.sep).join("/");
    fs.writeFileSync(local, JSON.stringify({ statusLine: { type: "command", command: `node "${inRepo}"`, padding: 0 }, theme: "x" }));
    const foreign = "bash ~/my-status.sh";
    fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: "command", command: foreign } }));
    const rs = sandbox({ XDG_CONFIG_HOME: XDG });
    const pw = ((read(file).sandbox || {}).filesystem || {}).allowWrite || [];
    const sl = read(local).statusLine || {}, cmd = String(sl.command || "");
    const named = (/^node "([^"]+)"$/.exec(cmd) || [])[1] || "";
    ok("statusLine: the repo's Proteus statusLine now runs the copy in bin", rs.code === 0 && named === path.join(bin, "proteus-statusline.js").split(path.sep).join("/") && fs.existsSync(named) && sl.padding === 0 && read(local).theme === "x", cmd + rs.err);
    ok("statusLine: under the generated profile its command names no path inside allowWrite", Boolean(named) && !pw.some((w) => named === w || named.startsWith(w + "/")), cmd);
    ok("statusLine: a foreign statusLine is left alone and named in a warning", read(shared).statusLine.command === foreign && rs.err.includes(foreign) && /not Proteus's/.test(rs.err), rs.err);
    const PWNED = path.join(W, "PWNED-statusline");
    fs.appendFileSync(path.join(teamHooks, "proteus-lib.js"), `require("fs").writeFileSync(${JSON.stringify(PWNED)}, "ran");\n`);
    run(named, { cwd: repo, workspace: { project_dir: repo } }, { cwd: repo });
    ok("statusLine: run as Claude Code runs it, it loads nothing an agent wrote in teams/", !fs.existsSync(PWNED));
    const outside = path.join(W, "elsewhere", "proteus-statusline.js").split(path.sep).join("/");
    fs.writeFileSync(local, JSON.stringify({ statusLine: { type: "command", command: `node "${outside}"` } }));
    sandbox({ XDG_CONFIG_HOME: XDG });
    ok("statusLine: one whose script is outside the write set is left as it is", read(local).statusLine.command === `node "${outside}"`);
    fs.rmSync(path.join(repo, ".claude"), { recursive: true });
    fs.rmSync(path.join(repo, "teams"), { recursive: true });
  }

  // #212 B10: /proteus:setup (--plugin-setup) after --sandbox in a repo with no statusLine adds one that runs bin's
  // copy, in settings.local.json only. A Proteus statusLine in settings.json counts as set: settings.json is left as it
  // is, and settings.local.json overrides it with bin's copy
  {
    const local = path.join(repo, ".claude", "settings.local.json"), shared = path.join(repo, ".claude", "settings.json");
    const setup = () => run(INSTALL, "", { cwd: repo, args: ["--plugin-setup", "--only-here"], env: { TMPDIR: TMP, XDG_CONFIG_HOME: XDG } });
    const status = (f) => { const c = String((read(f).statusLine || {}).command || ""); return (/^node "([^"]+)"$/.exec(c) || [])[1] || c; };
    const pw = ((read(file).sandbox || {}).filesystem || {}).allowWrite || [];
    const binLine = path.join(bin, "proteus-statusline.js").split(path.sep).join("/");
    const ps = setup();
    ok("--plugin-setup after --sandbox: the statusLine it adds runs bin's copy, no path in allowWrite", ps.code === 0 && status(local) === binLine
      && !pw.some((w) => status(local) === w || status(local).startsWith(w + "/")), status(local) + ps.err + ps.out);
    ok("--plugin-setup after --sandbox: settings.json gets no statusLine", !("statusLine" in read(shared)), JSON.stringify(read(shared)));
    fs.rmSync(local);
    const teamsLine = path.join(repo, "teams", "templates", "hooks", "proteus-statusline.js").split(path.sep).join("/");
    fs.writeFileSync(shared, JSON.stringify({ ...read(shared), statusLine: { type: "command", command: `node "${teamsLine}"` } }, null, 2) + "\n");
    const before = fs.readFileSync(shared, "utf8");
    const ps2 = setup();
    ok("--plugin-setup after --sandbox: a Proteus statusLine in settings.json counts as set and is left as it is", ps2.code === 0 && fs.readFileSync(shared, "utf8") === before, ps2.err + ps2.out);
    ok("--plugin-setup after --sandbox: settings.local.json overrides it with bin's copy", status(local) === binLine, status(local) + ps2.err);
    fs.rmSync(local);
    const rs = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox: a Proteus statusLine in settings.json is overridden in settings.local.json, settings.json left as it is", rs.code === 0
      && fs.readFileSync(shared, "utf8") === before && status(local) === binLine, status(local) + rs.err);
    fs.rmSync(path.join(repo, ".claude"), { recursive: true });
    fs.rmSync(path.join(repo, "teams"), { recursive: true, force: true });
  }

  // a settings file that is a link: --sandbox refuses before it writes anything (the profile included), and writes
  // nothing through the link
  {
    const victim = path.join(W, "victim.json"), local = path.join(repo, ".claude", "settings.local.json");
    fs.writeFileSync(victim, JSON.stringify({ original: true }));
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.symlinkSync(victim, local);
    const old = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    const rl = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox refuses a linked settings.local.json, writing no profile and nothing through the link", rl.code === 1 && /not a regular file/.test(rl.err)
      && !fs.existsSync(file) && fs.readFileSync(victim, "utf8") === JSON.stringify({ original: true }), rl.err);
    fs.rmSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(file, old);
  }

  // profiles that cannot be read, this checkout or the config dir in another profile's write set: refused, nothing written
  {
    const old = fs.readFileSync(file, "utf8"), cfg = path.join(CLAUDE, "proteus.json"), had = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null;
    const elsewhere = path.join(W, "release-home");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ home: elsewhere }));
    fs.writeFileSync(path.join(profileDir(), "broken.json"), "{");
    const rb = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox with a 1.x home dies on a profile it cannot read", rb.code === 1 && /cannot read the profiles in/.test(rb.err) && fs.readFileSync(file, "utf8") === old, rb.err);
    if (had === null) fs.rmSync(cfg); else fs.writeFileSync(cfg, had);
    const rb2 = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox dies on a profile it cannot read", rb2.code === 1 && /cannot be read/.test(rb2.err) && fs.readFileSync(file, "utf8") === old, rb2.err);
    fs.rmSync(path.join(profileDir(), "broken.json"));
    fs.writeFileSync(path.join(profileDir(), "self.json"), JSON.stringify({ sandbox: { filesystem: { allowWrite: [ROOT] } } }));
    const rh = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox refuses when this Proteus checkout is in a profile's write set", rh.code === 2 && /this Proteus checkout/.test(rh.err) && fs.readFileSync(file, "utf8") === old, rh.err);
    fs.rmSync(path.join(profileDir(), "self.json"));
    const shared2 = path.join(W, "shared-place"), cfg2 = path.join(shared2, "cfg");
    fs.mkdirSync(profileDir(cfg2), { recursive: true });
    fs.writeFileSync(path.join(profileDir(cfg2), "other.json"), JSON.stringify({ sandbox: { filesystem: { allowWrite: [shared2] } } }));
    const rp = sandbox({ CLAUDE_CONFIG_DIR: cfg2 });
    ok("--sandbox refuses a config dir inside another profile's write set", rp.code === 2 && /CLAUDE_CONFIG_DIR/.test(rp.err) && !fs.existsSync(path.join(profileDir(cfg2), "bin")), rp.err);
    fs.rmSync(shared2, { recursive: true });
  }

  // a plugin install sandboxed commands can write (claude --plugin-dir <repo>, a directory source in the repo): warned
  {
    const inst = path.join(CLAUDE, "plugins", "installed_plugins.json");
    fs.mkdirSync(path.dirname(inst), { recursive: true });
    const devPlugin = path.join(repo, "plugin");
    fs.mkdirSync(devPlugin, { recursive: true });
    fs.writeFileSync(inst, JSON.stringify({ plugins: { "proteus@proteus": [{ scope: "user", installPath: devPlugin }] } }));
    const pw1 = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox warns when the installed plugin is inside allowWrite", pw1.code === 0 && pw1.err.includes(`the Proteus plugin at ${devPlugin}`), pw1.err);
    const pw2 = sandbox({ XDG_CONFIG_HOME: XDG, CLAUDE_PLUGIN_ROOT: devPlugin });
    ok("--sandbox warns when CLAUDE_PLUGIN_ROOT is inside allowWrite", pw2.err.includes(`the Proteus plugin at ${devPlugin}`), pw2.err);
    fs.writeFileSync(inst, JSON.stringify({ plugins: { "proteus@proteus": [{ scope: "user", installPath: OUTHOME }] } }));
    const pw3 = sandbox({ XDG_CONFIG_HOME: XDG });
    ok("--sandbox does not warn about a plugin outside every write set", pw3.code === 0 && !/the Proteus plugin at/.test(pw3.err), pw3.err);
    fs.rmSync(path.join(CLAUDE, "plugins"), { recursive: true });
    fs.rmSync(devPlugin, { recursive: true });
  }

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
  ok("guest: an agent write to the guest dir's .claude/ is denied, by a rule Linux honours", (((read(file).permissions || {}).deny) || []).includes(`${rule("Edit", path.join(fixedGuest, ".claude"))}/**)`));
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

// #212 B7: the 1.x install (no flag) from a checkout a sandbox profile makes writable is refused, nothing written
{
  const pd = profileDir();
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, "self.json"), JSON.stringify({ sandbox: { filesystem: { allowWrite: [ROOT] } } }));
  const cfg = path.join(CLAUDE, "proteus.json"), had = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null;
  const ru = run(INSTALL, "", { cwd: path.join(W, "work", "sibling"), args: [] });
  ok("1.x install: a checkout in a profile's write set is refused, no skill link and no config written", ru.code === 1 && /this Proteus checkout/.test(ru.err)
    && !fs.existsSync(path.join(CLAUDE, "skills", "proteus")) && (fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null) === had, ru.err);
  fs.rmSync(path.join(pd, "self.json"));
}

// docs
const install = fs.readFileSync(path.join(ROOT, "docs", "install.md"), "utf8");
const sec = (/^## Sandboxed bypass\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(install) || [])[1] || "";
ok("docs/install.md: a Sandboxed bypass section", Boolean(sec));
ok("docs/install.md: it names the residuals (prompt injection, file tools, gh token, identity=separate)",
  /prompt injection/i.test(sec) && /Read, Edit and Write/.test(sec) && /identity=separate/.test(sec) && /token/.test(sec), sec.slice(0, 300));
ok("docs/install.md: the review session runs outside bypass", /proteus-review/.test(sec) && /outside|without/.test(sec));

lib.summary();
