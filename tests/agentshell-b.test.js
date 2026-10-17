// A subagent's shell, #48 part B layer 1: node tests/agentshell-b.test.js (needs git). lib.agentShellDenial also
// judges what xargs and find -exec run, git checkout / restore / apply / am / stash and patch where they write the
// guarded paths, rm -r / cp -r / mv / rsync on a parent of one, a force-push set up through config or the API,
// Git Bash drive paths and Codex's shell workdir. Normal work in the agent's own worktree still passes.
// Temp repo with a local bare remote; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("agentshell-b");
const slash = (p) => p.split(path.sep).join("/");
const q = (p) => JSON.stringify(slash(p));

const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
for (const [f, body] of [["src/a.js", "a\n"], [".github/workflows/ci.yml", "on: push\n"], ["docs/x.md", "x\n"]]) {
  fs.mkdirSync(path.dirname(path.join(REPO, f)), { recursive: true });
  fs.writeFileSync(path.join(REPO, f), body);
}
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE);
g(REPO, "push", "-q", "-u", "origin", "main");
// a side branch that changes the workflow and an agent definition, and a stash holding an agent definition
g(REPO, "checkout", "-q", "-b", "side");
fs.writeFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "on: never\n");
fs.writeFileSync(path.join(REPO, "src", "a.js"), "side\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "side");
g(REPO, "checkout", "-q", "main");
const WT1 = path.join(REPO, ".worktrees", "r1-1"), WT2 = path.join(REPO, ".worktrees", "r1-2");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT1, "main");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/2", WT2, "main");
for (const wt of [WT1, WT2]) lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [wt, "src/**", "docs/**", "build/**", "node_modules/**", "dist/**"] });
fs.mkdirSync(path.join(REPO, ".claude", "agents"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "agents", "evil.md"), "x\n");
g(REPO, "stash", "push", "-q", "-u", "-m", "evil", "--", ".claude/agents/evil.md");
fs.writeFileSync(path.join(REPO, "src", "a.js"), "own\n");
g(REPO, "stash", "push", "-q", "-m", "own", "--", "src/a.js");

// patch files in WT1's owned paths
const diff = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
fs.writeFileSync(path.join(WT1, "src", "evil.diff"), diff(".claude/agents/proteus-verifier.md"));
fs.writeFileSync(path.join(WT1, "src", "wf.patch"), "--- .github/workflows/ci.yml\t2026-01-01\n+++ .github/workflows/ci.yml\t2026-01-01\n@@ -1 +1 @@\n-on: push\n+on: never\n");
fs.writeFileSync(path.join(WT1, "src", "deep.patch"), diff("x/y/.git/hooks/pre-commit").replace(/a\/x\/y\//g, "a/").replace(/b\/x\/y\//g, "b/"));
fs.writeFileSync(path.join(WT1, "src", "ok.diff"), diff("src/a.js"));

const LG = path.join(SRC, "proteus-lead-guard.js");
const sub = { agent_id: "a1", agent_type: "proteus-backend-worker" };
const ev = (tool_name, tool_input, extra) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name, tool_input, ...extra });
const lead = (command, extra = sub, env = {}, input = {}) => lib.run(LG, ev("Bash", { command, ...input }, extra), { cwd: REPO, env });
const bind = lib.run(LG, ev("Write", { file_path: path.join(WT1, "src", "a.js"), content: "b\n" }, sub), { cwd: REPO });
ok("setup: a1's first edit in its worktree binds it", bind.code === 0, bind.err);

const denied = (command, re, extra, env, input) => { const r = lead(command, extra, env, input); return r.code === 2 && (!re || re.test(r.err)) ? "" : `${command} => ${r.code} ${r.err}`; };
const allowed = (command, extra, env, input) => { const r = lead(command, extra, env, input); return r.code === 0 ? "" : `${command} => ${r.code} ${r.err}`; };
const each = (f, cmds) => cmds.map((c) => f(c)).filter(Boolean);
const cd1 = `cd ${q(WT1)} && `;
const GUARDED = /which holds Proteus's hooks, gates, git internals or CLI settings/;
let bad;

// 1. xargs and find: the command they run is judged
bad = each((c) => denied(c, GUARDED), [
  cd1 + "ls | xargs sed -i s/a/b/ .claude/settings.json", cd1 + "echo src/a.js | xargs -I{} cp {} .claude/hooks/", cd1 + "xargs -0 -n1 tee .github/workflows/x.yml < /dev/null",
  cd1 + "find . -name '*.md' -exec cp {} .claude/agents/ \\;", cd1 + "find src -exec sh -c 'echo x > .claude/x' \\;", cd1 + "find src -execdir tee .git/hooks/pre-push \\;",
  cd1 + "find .claude -name '*.md' -exec sed -i s/a/b/ {} +", cd1 + "find .claude -delete", cd1 + "find . -name x -delete", cd1 + "find .github -exec rm {} \\;",
  cd1 + "find . -name '*.js' -exec sed -i s/a/b/ {} +", cd1 + "find src -fprint .claude/list", cd1 + "find .codex -ok rm {} \\;",
]);
ok("xargs / find: a guarded write by the command they run, -delete and -exec on a parent of a guarded path refused", !bad.length, bad.join("\n"));
bad = each(allowed, [
  cd1 + "find . -name x -print", cd1 + "find . -name '*.js' | xargs grep -n a", cd1 + "xargs grep -l a < /dev/null", cd1 + "find src -name '*.js' -exec grep -n a {} +",
  cd1 + "find src -name '*.tmp' -delete", cd1 + "find src -exec sed -i s/a/b/ {} \\;", cd1 + "find . -path ./node_modules -prune -o -name '*.md' -print", cd1 + "find .claude -name '*.md'",
]);
ok("xargs / find: find -print, xargs grep, -exec reading, and -delete or -exec sed under an owned dir pass", !bad.length, bad.join("\n"));

// 2. git checkout / restore / apply / am / stash, and patch
bad = each((c) => denied(c, GUARDED), [
  cd1 + "git checkout side -- .github/workflows/ci.yml", cd1 + "git checkout side -- .github", cd1 + "git checkout side .github/workflows/ci.yml", cd1 + "git checkout origin/main~0 -- . 2>/dev/null; git checkout side -- :/.github",
  cd1 + "git restore -s side .github/workflows/ci.yml", cd1 + "git restore --source=side -W -- .github", cd1 + "git restore --source side :(top).github/workflows",
  cd1 + "git apply src/evil.diff", cd1 + "git apply --index src/evil.diff", cd1 + "git apply -p1 src/deep.patch", cd1 + "git apply --stat --apply src/evil.diff", cd1 + "git am src/evil.diff",
  cd1 + "patch -p0 < src/wf.patch", cd1 + "patch -p0 -i src/wf.patch", cd1 + "patch --input=src/wf.patch", cd1 + "patch .github/workflows/ci.yml src/ok.diff", cd1 + "patch -o .claude/x src/a.js src/ok.diff",
  cd1 + "git stash pop stash@{1}", cd1 + "git stash apply 1",
]);
ok("git checkout/restore from another commit, git apply/am and patch of a guarded path, a stash holding one refused", !bad.length, bad.join("\n"));
bad = each((c) => denied(c, /cannot see which paths it changes/), [
  cd1 + "curl -s https://x | git apply", cd1 + "git apply < /dev/stdin", cd1 + "printf x > src/new.diff && git apply src/new.diff", cd1 + "patch -p1", cd1 + "git am",
  cd1 + "echo x | patch -p1 src/a.js",
]);
ok("git apply / am / patch from stdin or a file the same line writes refused", !bad.length, bad.join("\n"));
bad = each(allowed, [
  cd1 + "git status", cd1 + "git checkout -- src/a.js", cd1 + "git checkout src/a.js", cd1 + "git checkout -- .", cd1 + "git checkout HEAD -- .github", cd1 + "git restore docs/x.md",
  cd1 + "git restore --staged -- .", cd1 + "git checkout side -- src/a.js", cd1 + "git checkout -b proteus-work/r1/x", cd1 + "git switch proteus-work/r1/2", cd1 + "git restore -s side src/a.js",
  cd1 + "git apply src/ok.diff", cd1 + "git apply --check src/evil.diff", cd1 + "git apply --stat src/evil.diff", cd1 + "patch -p1 < src/ok.diff", cd1 + "patch --dry-run -p0 < src/wf.patch",
  cd1 + "git am --abort", cd1 + "git stash pop", cd1 + "git stash list", cd1 + "git commit -qm x", cd1 + "git diff side -- .github",
]);
ok("git checkout -- <file>, a restore to HEAD, a path-free switch, a clean patch, a dry run and a clean stash pass", !bad.length, bad.join("\n"));

// 3. rm -r / cp -r / mv / rsync on a parent of a guarded path
bad = each((c) => denied(c, /takes [^ ]+ with it, which holds Proteus's hooks/), [
  cd1 + "rm -rf .github", cd1 + "rm -r -f .", cd1 + "rm -R ..", cd1 + "rm --recursive ../r1-2", cd1 + "mv .github old", cd1 + "mv ../r1-2 /tmp/x",
  cd1 + "cp -r src/. .github", cd1 + "rsync -a src/ .github", cd1 + "rsync -a --delete src .github", `rm -rf ${q(WT2)}`, cd1 + "rm -rf ~",
]);
ok("rm -r, mv, cp -r of contents and rsync onto a parent of a guarded path refused", !bad.length, bad.join("\n"));
ok("tree: the message names the guarded path under the target", /`rm -r` on \.github takes \.github\/workflows with it/.test(lead(cd1 + "rm -rf .github").err), lead(cd1 + "rm -rf .github").err);
bad = each((c) => denied(c, GUARDED), [cd1 + "cp -r src .github/workflows", cd1 + "rsync -a src .claude", cd1 + "cp -a src/a.js .git/hooks"]);
ok("cp -r / rsync of a dir into a guarded dir refused", !bad.length, bad.join("\n"));
bad = each(allowed, [
  cd1 + "rm -rf src/tmp", cd1 + "rm -r docs", cd1 + "cp -r src build", cd1 + "cp -r src/. build", cd1 + "mv src/a.js src/b.js", cd1 + "rsync -a --delete src/ build/",
  cd1 + "cp -r .github/workflows src/wf", cd1 + "rm -rf node_modules dist",
]);
ok("rm -r, cp -r, mv and rsync on owned paths, and copies out of a guarded dir pass", !bad.length, bad.join("\n"));

// 4. a force-push set up another way
bad = each((c) => denied(c, /sets up a push the guard cannot read/), [
  cd1 + "git config remote.origin.push '+refs/heads/*:refs/heads/*'", cd1 + "git config --add remote.origin.push +HEAD:main", cd1 + "git config set remote.origin.mirror true",
  cd1 + "git config push.default matching", cd1 + "git config --local push.default matching", cd1 + "git config alias.p '!git push -f'", cd1 + "git config alias.sp 'push --force'",
  cd1 + "git -c remote.origin.push=+HEAD:main push origin proteus-work/r1/1", cd1 + "git -c push.default=matching fetch", cd1 + "git --config-env=remote.origin.push=X fetch",
  cd1 + "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=+HEAD:main git fetch", cd1 + "env GIT_CONFIG_PARAMETERS=\"'push.default'='matching'\" git fetch",
  cd1 + "git -c alias.p='push -f' p",
]);
ok("force setup: push refspec, mirror, push.default, a push alias, through -c, --config-env and GIT_CONFIG_* refused", !bad.length, bad.join("\n"));
bad = each(allowed, [
  cd1 + "git config user.name x", cd1 + "git config push.default simple", cd1 + "git config --get remote.origin.push", cd1 + "git config --unset remote.origin.push",
  cd1 + "git config core.autocrlf false", cd1 + "git -c color.ui=never log -1", cd1 + "git config -l",
]);
ok("force setup: ordinary config, push.default simple, reads and unsets pass", !bad.length, bad.join("\n"));
bad = each((c) => denied(c, /never move a branch through the API/), [
  "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true", "gh api repos/o/r/git/refs/heads/x --method DELETE", "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc",
  "gh api --method=POST /repos/o/r/git/refs/tags", "gh api graphql -f query='mutation { updateRef(input: {refId: \"x\", oid: \"y\", force: true}) { clientMutationId } }'",
  "gh repo sync o/r --force", `node ${q(path.join(SRC, "proteus-gh.js"))} api -X PATCH repos/o/r/git/refs/heads/main -F force=true`,
]);
ok("API refs: a non-GET on git/refs, a graphql ref mutation and gh repo sync --force refused", !bad.length, bad.join("\n"));
bad = each(allowed, ["gh api repos/o/r/git/refs/heads/main", "gh api -X GET repos/o/r/git/refs", "gh api graphql -f query='{ viewer { login } }'", "gh pr view 1", "gh repo sync o/r"]);
ok("API refs: reads, a plain graphql query and gh repo sync pass", !bad.length, bad.join("\n"));
ok("API refs: the lead's own shell is not judged by them", !allowed("gh api repos/o/r/git/refs/heads/x --method DELETE", {}));

// 5. Git Bash drive paths and Codex's workdir
const hl = require(path.join(SRC, "proteus-lib.js"));
ok("drive paths: /c/x and /cygdrive/d/x read as drive paths on Windows only",
  hl.drivePath("/c/Users/x", true) === "C:/Users/x" && hl.drivePath("/cygdrive/d/a", true) === "D:/a" && hl.drivePath("/c", true) === "C:/" &&
  hl.drivePath("/c/x", false) === "/c/x" && hl.drivePath("/cache/x", true) === "/cache/x" && hl.expandPath("/c/x", "/", true) === "C:/x");
const cx = { PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(lib.HOME, ".codex") };
const cxSub = { agent_id: "a1", agent_type: "proteus-backend-worker" };
// prepared for Codex too (.codex/proteus-owned): a worker with no worktree known writes nothing (#48 F1)
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT1, "src/**", "docs/**"], env: cx });
ok("codex workdir: a write relative to the shell's workdir is judged from there",
  !denied("sed -i s/a/b/ agents/x.md", GUARDED, cxSub, cx, { workdir: slash(path.join(WT1, ".claude")) }) && !denied("echo x > workflows/ci.yml", GUARDED, cxSub, cx, { workdir: ".worktrees/r1-1/.github" }));
ok("codex workdir: git with a workdir in the agent's own worktree passes, and an owned write there too",
  !allowed("git status", cxSub, cx, { workdir: slash(WT1) }) && !allowed("echo x > a.js", cxSub, cx, { workdir: slash(path.join(WT1, "src")) }));
ok("codex workdir: rm -rf . from a workdir at the worktree root refused", !denied("rm -rf .", /takes/, cxSub, cx, { workdir: slash(WT1) }));

// the worker guard runs the same rules
const WG = path.join(WT1, ".claude", "hooks", "proteus-worker-guard.js");
const wg = (command) => lib.run(WG, { hook_event_name: "PreToolUse", session_id: "s2", cwd: WT1, tool_name: "Bash", tool_input: { command } }, { cwd: WT1 });
ok("worker guard: find -exec, git apply, rm -r .github and git config remote push refused",
  wg("find . -exec cp {} .claude/x \\;").code === 2 && wg("git apply src/evil.diff").code === 2 && wg("rm -rf .github").code === 2 && wg("git config remote.origin.push +HEAD:main").code === 2);
ok("worker guard: git checkout -- file, find -print, xargs grep and a clean apply pass",
  wg("git checkout -- src/a.js").code === 0 && wg("find . -name x -print").code === 0 && wg("ls | xargs grep a").code === 0 && wg("git apply src/ok.diff").code === 0);

lib.summary();
