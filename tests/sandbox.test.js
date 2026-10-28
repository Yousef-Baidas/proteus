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
  // 7: git config and hooks, submodules' too
  ok("profile: Edit denied for the repo's .claude dirs, git config and hooks, submodules' included",
    [`${rule("Edit", realRepo)}/**/.claude/**)`, `${rule("Edit", path.join(realRepo, ".git", "config"))})`, `${rule("Edit", path.join(realRepo, ".git", "hooks"))}/**)`,
      `${rule("Edit", path.join(realRepo, ".git", "modules"))}/**/config)`, `${rule("Edit", path.join(realRepo, ".git", "modules"))}/**/hooks/**)`].every((x) => deny.includes(x)), deny.slice(0, 16).join(" "));

  // 3: the copy prepares only this repo's listed worktrees under .worktrees/
  const runCopy = (...a) => run(copy, "", { cwd: repo, args: a });
  g(repo, "worktree", "add", "-q", "-b", "w1", path.join(repo, ".worktrees", "w1"));
  const good = runCopy(path.join(repo, ".worktrees", "w1"), "src/**");
  ok("copy: prepares a listed worktree under .worktrees/", good.code === 0 && fs.existsSync(path.join(repo, ".worktrees", "w1", ".claude", "settings.local.json")), good.err + good.out);
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
  ok("copy: refuses a dir under .worktrees/ git does not list", esc3.code === 1 && /worktree list/.test(esc3.err) && !fs.existsSync(path.join(planted, ".claude")), esc3.err);
  const away = path.join(W, "work", "away");
  g(repo, "worktree", "add", "-q", "-b", "away", away);
  const esc4 = runCopy(away, "src/**");
  ok("copy: refuses a listed worktree outside .worktrees/", esc4.code === 1 && /not a checkout under/.test(esc4.err) && !fs.existsSync(path.join(away, ".claude")), esc4.err);
  const w2 = path.join(repo, ".worktrees", "w2"), victim = path.join(W, "victim");
  g(repo, "worktree", "add", "-q", "-b", "w2", w2);
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, path.join(w2, ".claude"));
  const esc5 = runCopy(w2, "src/**");
  ok("copy: refuses a worktree whose .claude is a link", esc5.code === 1 && /link/.test(esc5.err) && !files(victim).length, esc5.err);

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
