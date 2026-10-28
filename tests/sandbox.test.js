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

if (WIN) {
  const r = sandbox();
  ok("win32: --sandbox refuses (no native sandbox) and writes nothing", r.code === 2 && /WSL2/.test(r.err) && !files(profileDir()).length, r.err);
} else {
  const r = sandbox();
  const made = files(profileDir());
  ok("--sandbox exits 0 and writes one profile under ~/.claude/proteus-sandbox", r.code === 0 && made.length === 1 && /^app-[0-9a-f]{8}\.json$/.test(made[0]), r.err + r.out);
  const file = path.join(profileDir(), made[0] || "x");
  ok("--sandbox prints the launch command with the file and bypassPermissions", r.out.includes(`claude --settings ${file} --permission-mode bypassPermissions`), r.out);
  ok("--sandbox says the review session runs without the profile", /proteus-review\) without it/.test(r.out), r.out);
  ok("--sandbox leaves the user's settings.json byte for byte", fs.readFileSync(userSettings, "utf8") === mine);
  ok("--sandbox writes nothing into the repo's .claude", !fs.existsSync(path.join(repo, ".claude")));
  let p = {};
  try { p = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const sb = p.sandbox || {}, fsx = sb.filesystem || {}, net = sb.network || {}, deny = (p.permissions || {}).deny || [];
  ok("profile: sandbox on, fail if unavailable, no unsandboxed retry", sb.enabled === true && sb.failIfUnavailable === true && sb.allowUnsandboxedCommands === false, JSON.stringify(sb));
  ok("profile: never sets a permission mode itself", !("defaultMode" in (p.permissions || {})));
  const realRepo = fs.realpathSync(repo), tmp = TMP;
  ok("profile: writes allowed to the repo and the temp dir", (fsx.allowWrite || []).includes(realRepo) && (fsx.allowWrite || []).includes(path.resolve(tmp)), JSON.stringify(fsx.allowWrite));
  ok("profile: reads of ~/.ssh and cloud credentials denied, in the sandbox and to Read", ["~/.ssh", "~/.aws", "~/.config/gcloud"].every((s) => (fsx.denyRead || []).includes(s) && deny.includes(`Read(${s}/**)`)), JSON.stringify(fsx.denyRead));
  ok("profile: strict allowlist of GitHub plus npm from ## Learned, nothing from other sections",
    net.strictAllowlist === true && ["github.com", "*.github.com", "registry.npmjs.org"].every((d) => net.allowedDomains.includes(d)) && !net.allowedDomains.includes("pypi.org"), JSON.stringify(net));
  ok("profile: token env vars kept from sandboxed commands", ["GH_TOKEN", "GITHUB_TOKEN"].every((n) => ((sb.credentials || {}).envVars || []).some((e) => e.name === n && e.mode === "deny")));
  ok("profile: proteus-worktree.js and install.js --project run outside the sandbox, by exact path",
    (sb.excludedCommands || []).includes("node .claude/hooks/proteus-worktree.js *") && (sb.excludedCommands || []).includes(`node ${INSTALL} --project *`)
    && (sb.excludedCommands || []).every((c) => /^node \S*(proteus-worktree\.js \*|install\.js --project( \*)?)$/.test(c) || c.startsWith('node "')), JSON.stringify(sb.excludedCommands));
  ok("profile: WebFetch denied (the sandbox does not cover it)", deny.includes("WebFetch"));
  const rule = (p2) => `Edit(/${p2.split(path.sep).join("/")}`;
  ok("profile: Edit denied beside the repo, under each dir on the way", deny.includes(`${rule(path.join(fs.realpathSync(W), "work", "sibling"))}/**)`), deny.slice(0, 40).join(" "));
  ok("profile: Edit denied for new dotfiles beside the repo's parent", deny.includes(`${rule(path.join(fs.realpathSync(W), "work", ".*"))})`));
  const ancestors = [];
  for (let d = realRepo; ; d = path.dirname(d)) { ancestors.push(d); if (path.dirname(d) === d) break; }
  const opened = (r2) => ancestors.some((a) => r2 === `${rule(a)}/**)` || r2 === `${rule(a)})`) || r2 === `${rule(path.resolve(tmp))}/**)`;
  ok("profile: no Edit rule covers the repo, a dir above it, or the temp dir", !deny.some(opened), deny.filter(opened).join(" "));
  ok("profile: Edit denied for the repo's .claude dirs, git config and hooks",
    [`${rule(realRepo)}/**/.claude/**)`, `${rule(path.join(realRepo, ".git", "config"))})`, `${rule(path.join(realRepo, ".git", "hooks"))}/**)`].every((x) => deny.includes(x)), deny.slice(0, 12).join(" "));

  // agentGh set: the human's gh dir is unreadable too; the profile is rewritten in place
  const agent = path.join(HOME, ".config", "gh-proteus"), xdg = path.join(HOME, "xdg");
  fs.writeFileSync(path.join(CLAUDE, "proteus.json"), JSON.stringify({ agentGh: agent, human: "me" }));
  const r2 = sandbox({ XDG_CONFIG_HOME: xdg });
  let p2 = {};
  try { p2 = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const human = path.join(xdg, "gh");
  ok("agentGh: the human's gh config dir is denied to the sandbox and to Read", r2.code === 0 && files(profileDir()).length === 1
    && (p2.sandbox.filesystem.denyRead || []).includes(human) && p2.permissions.deny.includes(`${rule(human)}/**)`.replace("Edit(", "Read(")), JSON.stringify(p2.sandbox && p2.sandbox.filesystem));
  ok("agentGh: the agents' own gh dir stays readable", !(p2.sandbox.filesystem.denyRead || []).includes(agent));

  // CLAUDE_CONFIG_DIR moves the profile with the rest of Claude Code's config
  const alt = path.join(W, "alt-claude");
  const r3 = sandbox({ CLAUDE_CONFIG_DIR: alt });
  ok("CLAUDE_CONFIG_DIR: the profile goes under it", r3.code === 0 && files(profileDir(alt)).length === 1, r3.err);
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
