// Owned-path check tests: node tests/owned.test.js (needs git). The worktree pre-commit hook and the CI step
// refuse changes outside the ticket's owned paths, which shell writes (sed -i, redirects) reach without an edit hook.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g, workdir, summary } = lib;
const W = workdir("owned");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
fs.writeFileSync(path.join(REPO, "src", "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
// a hook the repo already had (lefthook installs these): the worktree must still run it
const MARK = path.join(W, "commit-msg-ran");
fs.writeFileSync(path.join(REPO, ".git", "hooks", "commit-msg"), `#!/bin/sh\necho ran > '${MARK.replace(/\\/g, "/")}'\n`, { mode: 0o755 });

const WT = path.join(W, "wt");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/t1", WT);
const node = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...opts });
let r = node(path.join(HOOKS, "proteus-worktree.js"), [WT, "src/"]);
ok("worktree script installs the pre-commit hook", r.status === 0 && !r.stderr, r.stdout + r.stderr);

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const commit = (file) => {
  fs.mkdirSync(path.dirname(path.join(WT, file)), { recursive: true });
  fs.writeFileSync(path.join(WT, file), "x\n");
  g(WT, "add", file);
  return spawnSync("git", ["commit", "-qm", "feat: x"], { cwd: WT, encoding: "utf8", env: { ...process.env, ...ID } });
};
r = commit("docs/notes.md");
ok("pre-commit: a staged path outside the owned list blocks the commit and is named",
  r.status !== 0 && /not in \.claude\/proteus-owned:\n  docs\/notes\.md/.test(r.stderr), r.stderr);
g(WT, "reset", "-q");
fs.rmSync(path.join(WT, "docs"), { recursive: true });
r = commit("src/new.txt");
ok("pre-commit: an owned path commits, and the repo's own commit-msg hook still runs", r.status === 0 && fs.existsSync(MARK), r.stderr);
ok("pre-commit: the main checkout is untouched",
  spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: REPO, encoding: "utf8" }).stdout.trim() === "");
r = node(path.join(HOOKS, "proteus-worktree.js"), [WT, "src/"]);
ok("pre-commit: re-running the worktree script keeps the forwarding", r.status === 0 && !r.stderr, r.stderr);
fs.rmSync(MARK);
r = commit("src/second.txt");
ok("pre-commit: still forwards after a re-run", r.status === 0 && fs.existsSync(MARK), r.stderr);
ok("commit-msg: the repo's own hook is forwarded, not replaced by commit-msg.js",
  !fs.readFileSync(path.join(g(WT, "rev-parse", "--absolute-git-dir"), "proteus-hooks", "commit-msg"), "utf8").includes("commit-msg.js"));

// a repo with no hooks (no lefthook yet): the worktree still gets the commit-msg check CI runs (#28)
const bare = (name, hooksSrc, env) => {
  const repo = path.join(W, name), wt = path.join(W, `${name}-wt`);
  g(W, "init", "-q", "-b", "main", repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A"); g(repo, "commit", "-qm", "init");
  g(repo, "worktree", "add", "-q", "-b", "proteus-work/r1/t1", wt);
  const res = node(path.join(hooksSrc(repo), "proteus-worktree.js"), [wt, "src/"], { cwd: repo, env: { ...process.env, ...env } });
  const msgCommit = (file, msg) => {
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", file), "x\n");
    g(wt, "add", "src");
    return spawnSync("git", ["commit", "-qm", msg], { cwd: wt, encoding: "utf8", env: { ...process.env, ...ID } });
  };
  return { res, msgCommit };
};
const LONG = "feat(src): " + "a".repeat(62);
let b = bare("nohooks", () => HOOKS, {});
ok("commit-msg: the worktree script runs in a repo with no hooks", b.res.status === 0 && !b.res.stderr, b.res.stdout + b.res.stderr);
r = b.msgCommit("a.txt", LONG);
ok("commit-msg: a subject over 72 chars is rejected in the worktree", r.status !== 0 && /subject over 72 chars/.test(r.stderr), r.stderr);
r = b.msgCommit("a.txt", "feat(src): add a");
ok("commit-msg: a valid message commits", r.status === 0, r.stderr);
r = b.msgCommit("b.txt", "Added b");
ok("commit-msg: a non-Conventional subject is rejected", r.status !== 0 && /commit rejected/.test(r.stderr), r.stderr);
// Codex skips commit-msg.js in its hooks dir: the check comes from the lead's teams/templates/hooks
b = bare("codexhooks", (repo) => {
  const cxd = path.join(repo, ".codex", "hooks"), tpl = path.join(repo, "teams", "templates", "hooks");
  for (const d of [cxd, tpl]) fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(HOOKS)) {
    fs.copyFileSync(path.join(HOOKS, f), path.join(tpl, f));
    if (f !== "commit-msg.js") fs.copyFileSync(path.join(HOOKS, f), path.join(cxd, f));
  }
  return cxd;
}, { ...lib.homeEnv(lib.HOME), PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(lib.HOME, ".codex") });
ok("commit-msg (Codex): the worktree script runs", b.res.status === 0 && !b.res.stderr, b.res.stdout + b.res.stderr);
r = b.msgCommit("a.txt", LONG);
ok("commit-msg (Codex): teams/templates/hooks/commit-msg.js rejects a long subject", r.status !== 0 && /subject over 72 chars/.test(r.stderr), r.stderr);
ok("commit-msg (Codex): a valid message commits", b.msgCommit("a.txt", "fix(src): change a").status === 0);

// CI: paths changed since the base against the PR body's Owned: line
const CHK = path.join(HOOKS, "proteus-owned-check.js");
const ci = (body) => node(CHK, ["--ci", "main"], { cwd: WT, env: { ...process.env, PR_BODY: body } });
r = ci("Closes #4\n\nOwned: src/ docs/other.md\n");
ok("ci: every changed path owned passes", r.status === 0, r.stderr);
r = ci("Owned: tests/, lib.js");
ok("ci: a changed path outside the Owned: line fails and is named", r.status === 1 && /src\/new\.txt/.test(r.stderr) && /src\/second\.txt/.test(r.stderr), r.stderr);
r = ci("no owned line here");
ok("ci: no Owned: line fails rather than passing everything", r.status === 1 && /no "Owned:/.test(r.stderr), r.stderr);
ok("ci: bad usage exits 2", node(CHK, ["--nope"], { cwd: WT }).status === 2);

// #74: the owned-path list itself never commits, whatever its globs cover; nor passes CI whatever the Owned: line says
const LIST = path.join(WT, ".claude", "proteus-owned"), was = fs.readFileSync(LIST, "utf8");
fs.writeFileSync(LIST, "**\n");
g(WT, "add", "-f", ".claude/proteus-owned");
r = commit("src/third.txt");
ok("pre-commit: a staged owned-path list is refused even when its globs cover it, the rest passes",
  r.status !== 0 && /not in \.claude\/proteus-owned:\n {2}\.claude\/proteus-owned\n/.test(r.stderr) && !/src\/third\.txt/.test(r.stderr), r.stderr);
spawnSync("git", ["commit", "-qm", "feat: x", "--no-verify"], { cwd: WT, encoding: "utf8", env: { ...process.env, ...ID } });
r = ci("Owned: ** .claude/proteus-owned");
ok("ci: a PR that changes the owned-path list fails even when the Owned: line covers it",
  r.status === 1 && /\.claude\/proteus-owned/.test(r.stderr) && !/src\//.test(r.stderr), r.stderr);
g(WT, "reset", "-q", "--soft", "HEAD~1"); g(WT, "rm", "-q", "--cached", ".claude/proteus-owned"); g(WT, "commit", "-qm", "feat: x", "--no-verify");
fs.writeFileSync(LIST, was);

// the shipped CI template: every placeholder fails, the job id stays gates, the owned step is wired
const tpl = fs.readFileSync(path.join(ROOT, "templates", "ci", "proteus-gates.yml"), "utf8").replace(/\r\n/g, "\n"); // a win32 checkout may have CRLF
const steps = tpl.split("\n").filter((l) => /^\s*- run: echo "EDIT-/.test(l));
ok("template: six placeholders (five code gates, the Direct job's docs gate), each exits 1; job id is gates; owned-paths step runs on worker PRs",
  steps.length === 6 && steps.every((l) => /exit 1/.test(l)) && /^  gates:$/m.test(tpl) &&
  /startsWith\(github\.head_ref, 'proteus-work\/'\)[\s\S]*proteus-owned-check\.js --ci/.test(tpl) && !/required review|one approving review/.test(tpl));
// mechanical QA: every push to a run branch runs gates, then qa, whose steps the QA verifier reads by name
const qa = tpl.slice(tpl.indexOf("\n  qa:\n"));
const qaSteps = ["e2e", "smoke", "rebuild", "mutation"];
ok("template: pushes to proteus/** run gates and a qa job with e2e, smoke, rebuild and mutation placeholders that exit 1",
  /\n  push:\n    branches: \["proteus\/\*\*"\]/.test(tpl) && /if: github\.event_name == 'push'\n    needs: gates/.test(qa) &&
  qaSteps.every((n) => new RegExp(`- name: ${n}\\n(?:.*\\n)*?\\s+run: echo "EDIT-${n} not filled in" >&2; exit 1`).test(qa)), qa.slice(0, 300));
ok("template: a push runs the gates job, so qa (which needs it) runs too",
  !/^  gates:\n(?:    #[^\n]*\n)*    if: (?![^\n]*github\.event_name == 'push')/m.test(tpl));
ok("template: commit messages only on a PR (a push has no base ref), mutation skipped on the push that creates the branch",
  /- name: commit messages\n\s+if: github\.event_name == 'pull_request'/.test(tpl.slice(tpl.indexOf("\n  gates:\n"), tpl.indexOf("\n  direct:\n"))) && /- name: mutation\n\s+if: github\.event\.before != '0{40}'/.test(qa));

summary();
