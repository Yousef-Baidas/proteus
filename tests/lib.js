// Shared harness for tests/*.test.js: assertions, a per-file temp dir, fake gh and fakeCli for others, homeEnv and SYS_PATH for stripped envs, spawn helpers, an SSH tag signer.
// summary() prints "N passed, M failed" and sets exit code 1 if any assertion failed, else 0.
// workdir() exits 1 with a message, before writing anything, when os.tmpdir() is in the user's home or a git worktree.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const WIN = process.platform === "win32";
let pass = 0, fail = 0;
let W, HOME, BIN, ENV;

// dirs a stripped PATH still needs: git, and on win32 cmd.exe for shell: true
const SYS_PATH = WIN
  ? [...new Set([...(spawnSync("where", ["git"], { encoding: "utf8" }).stdout || "").split(/\r?\n/).filter(Boolean).map((p) => path.dirname(p)), path.join(process.env.SystemRoot || "C:\\Windows", "System32")])]
  : ["/usr/bin", "/bin"];

// a fake HOME: os.homedir() reads USERPROFILE on win32, and node there needs SystemRoot, ComSpec and a temp dir in a stripped env
function homeEnv(home) {
  const e = { HOME: home, USERPROFILE: home };
  if (WIN) {
    for (const k of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) if (process.env[k]) e[k] = process.env[k];
    // forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape
    e.NODE_OPTIONS = `--require "${path.join(__dirname, "fixtures", "fake-cli-shim.js").replace(/\\/g, "/")}"`;
  }
  return e;
}

// the script a fake CLI made by fakeCli runs, for a fake that hands calls on with process.execPath
const fakeScript = (dir, name) => path.join(dir, WIN ? `${name}.fake.js` : name);

// a fake CLI named name in dir running the node source: a shebang script on POSIX; on win32 a copy of node.exe
// that fixtures/fake-cli-shim.js (preloaded by homeEnv) points at name.fake.js, so it runs without a shell
function fakeCli(dir, name, source) {
  const body = source.replace(/^#!.*\n/, "");
  if (!WIN) { fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\n${body}`, { mode: 0o755 }); return; }
  fs.writeFileSync(path.join(dir, `${name}.fake.js`), body);
  const exe = path.join(dir, `${name}.exe`);
  try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
}

function need() {
  if (!W) throw new Error("call workdir(name) first");
}

// a tmpdir in the real home or in a git worktree puts the installer's walks next to real files (#13): stop before any write
function refuseTmpdir() {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const tmp = real(os.tmpdir());
  let why = null;
  try { if (inside(tmp, real(os.userInfo().homedir))) why = `inside your home ${os.userInfo().homedir}`; } catch {}
  for (let d = tmp; !why; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) why = `inside the git worktree ${d}`;
    if (path.dirname(d) === d) break;
  }
  if (!why) return;
  console.error(`refusing to run: os.tmpdir() ${os.tmpdir()} is ${why}; run with TMPDIR outside it (the default /tmp)`);
  process.exit(1);
}

function workdir(name) {
  refuseTmpdir();
  // the real path: macOS reaches the temp dir through the /var symlink, and git reports /private/var
  W = path.join(fs.realpathSync(os.tmpdir()), "proteus-test", name);
  fs.rmSync(W, { recursive: true, force: true });
  fs.mkdirSync(W, { recursive: true });
  HOME = path.join(W, "home");
  BIN = path.join(W, "bin");
  fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
  fs.mkdirSync(BIN);
  fakeCli(BIN, "gh", fs.readFileSync(path.join(__dirname, "fakegh.js"), "utf8"));
  ENV = { PATH: [BIN, path.dirname(process.execPath), ...SYS_PATH].join(path.delimiter), ...homeEnv(HOME), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  return W;
}

function ok(name, cond, extra) {
  if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? " :: " + String(extra).slice(0, 600) : ""}`); }
}

function run(script, input, { cwd = process.cwd(), env = {}, args = [] } = {}) {
  need();
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [script, ...args], { cwd, input: typeof input === "string" ? input : JSON.stringify(input || {}), env: { ...ENV, CLAUDE_PROJECT_DIR: cwd, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

function g(cwd, ...args) {
  need();
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// a throwaway SSH signing key in dir for signed release tags: { allowed, tag(cwd, name) }, where allowed is an
// allowed-signers file trusting it; null when ssh-keygen is missing or cannot sign here (some Windows runners)
function sshSigner(dir, name = "maintainer") {
  need();
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, name);
  const ssh = (args) => spawnSync("ssh-keygen", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let r = ssh(["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  if (r.error || r.status !== 0) return null;
  const probe = path.join(dir, `${name}.probe`);
  fs.writeFileSync(probe, "probe\n");
  r = ssh(["-Y", "sign", "-q", "-n", "git", "-f", key, probe]);
  if (r.error || r.status !== 0) return null;
  const allowed = path.join(dir, `${name}.allowed_signers`);
  fs.writeFileSync(allowed, `${name}@example.com ${fs.readFileSync(key + ".pub", "utf8").trim()}\n`);
  return { allowed, tag: (cwd, tag) => g(cwd, "-c", "gpg.format=ssh", "-c", `user.signingkey=${key}`, "tag", "-s", tag, "-m", `release ${tag}`) };
}

function summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

module.exports = {
  ok, run, g, workdir, summary, fakeCli, fakeScript, homeEnv, SYS_PATH, sshSigner,
  get ENV() { need(); return ENV; },
  get BIN() { need(); return BIN; },
  get HOME() { need(); return HOME; },
  get W() { need(); return W; },
};
