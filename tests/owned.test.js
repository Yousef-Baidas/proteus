// Owned-path check tests: node tests/owned.test.js (needs git). The worktree pre-commit hook and the CI step
// refuse changes outside the ticket's owned paths, which shell writes (sed -i, redirects) reach without an edit hook.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const { ok, g, workdir, summary } = require(path.join(__dirname, "lib.js"));
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
