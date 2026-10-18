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
ok("commit-msg: the rejection points to references/commits.md", /references\/commits\.md/.test(r.stderr), r.stderr);
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

// #96: pre-commit and CI own what is below a folder a mid-path wildcard matches, as the edit hooks do
r = node(path.join(HOOKS, "proteus-worktree.js"), [WT, "src/", "packages/*/src"]);
r = commit("packages/x/src/y.js");
ok("pre-commit: a mid-path wildcard glob owns a file below the folder it matches", r.status === 0, r.stderr);
r = commit("packages/x/srcx/y.js");
ok("pre-commit: a mid-path wildcard glob does not own a sibling that shares its prefix",
  r.status !== 0 && /packages\/x\/srcx\/y\.js/.test(r.stderr), r.stderr);
g(WT, "reset", "-q");
fs.rmSync(path.join(WT, "packages", "x", "srcx"), { recursive: true });
r = ci("Owned: src/* packages/*/src");
ok("ci: a trailing * and a mid-path * own the files below the folders they match", r.status === 0, r.stderr);
r = ci("Owned: src/* packages/*/srcx");
ok("ci: a glob that matches no folder above a changed path fails it", r.status === 1 && /packages\/x\/src\/y\.js/.test(r.stderr) && !/src\/new\.txt/.test(r.stderr), r.stderr);

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

// #86: on a run branch the owned paths come from the lead's record .proteus/owned/<id> on the base, never the
// PR body or the PR's own copy, both of which the worker writes
const RREPO = path.join(W, "records");
g(W, "init", "-q", "-b", "main", RREPO);
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const commitAll = (dir, msg) => { g(dir, "add", "-A"); spawnSync("git", ["commit", "-qm", msg, "--no-verify"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...ID } }); };
put(RREPO, "src/a.txt", "a\n");
put(RREPO, "AGENTS.md", "# agents\nlead-edits: .editorconfig\n");
commitAll(RREPO, "init");
g(RREPO, "branch", "proteus/old"); // a run cut before the records
g(RREPO, "checkout", "-q", "-b", "proteus/r1");
put(RREPO, ".proteus/owned/7", "# ticket 7\nsrc/\n");
put(RREPO, ".proteus/owned/8", "docs/\n");
commitAll(RREPO, "chore(proteus): record owned paths for r1");
g(RREPO, "checkout", "-q", "main");
const branchWt = (name, branch, from) => { const wt = path.join(W, name); g(RREPO, "worktree", "add", "-q", "-b", branch, wt, from); return wt; };
const rci = (wt, base, head, body) => {
  const env = { ...process.env, PR_BODY: body || "" };
  if (head === null) delete env.GITHUB_HEAD_REF; else env.GITHUB_HEAD_REF = head;
  return node(CHK, ["--ci", base], { cwd: wt, env });
};
const W7 = branchWt("rec7", "proteus-work/r1/7", "proteus/r1");
put(W7, "src/b.txt", "b\n");
commitAll(W7, "feat(src): add b");
r = rci(W7, "proteus/r1", "proteus-work/r1/7", "");
ok("record: a PR inside the base's .proteus/owned/<id> passes with no Owned: line in its body", r.status === 0, r.stderr);
r = rci(W7, "proteus/r1", null, "");
ok("record: without GITHUB_HEAD_REF the checked-out branch names the ticket", r.status === 0, r.stderr);
put(W7, "docs/c.md", "c\n");
commitAll(W7, "docs: add c");
r = rci(W7, "proteus/r1", "proteus-work/r1/7", "Owned: src/ docs/ **");
ok("record: the old bypass, a worker widening the PR body's Owned: line, now fails and names the path and the record",
  r.status === 1 && /not in \.proteus\/owned\/7 on proteus\/r1:\n {2}docs\/c\.md\n/.test(r.stderr), r.stderr);
put(W7, ".proteus/owned/7", "**\n");
commitAll(W7, "chore: widen");
r = rci(W7, "proteus/r1", "proteus-work/r1/7", "Owned: **");
ok("record: a worker rewriting its own record in the PR fails; the base's copy is the one read",
  r.status === 1 && /\.proteus\/owned\/7/.test(r.stderr.split("\n").slice(1).join("\n")) && /docs\/c\.md/.test(r.stderr) && !/src\/b\.txt/.test(r.stderr), r.stderr);
const W9 = branchWt("rec9", "proteus-work/r1/9", "proteus/r1");
put(W9, "src/d.txt", "d\n");
commitAll(W9, "feat(src): add d");
r = rci(W9, "proteus/r1", "proteus-work/r1/9", "Owned: src/");
ok("record: a ticket with no record fails, whatever the PR body says", r.status === 1 && /has no \.proteus\/owned\/9/.test(r.stderr), r.stderr);
r = rci(W9, "origin/proteus/r1", "proteus-work/r1/9", "Owned: src/");
ok("record: a base git cannot resolve fails and says so, rather than falling back to the body", r.status === 1 && /origin\/proteus\/r1 is not a commit/.test(r.stderr) && !/warning/.test(r.stderr), r.stderr);
// the lead's docs PR: its docs, teams/, the records and the base's lead-edits globs, nothing else
const WL = branchWt("lead-docs", "proteus-work/r1/lead-docs", "proteus/r1");
put(WL, "CONTEXT.md", "c\n"); put(WL, ".proteus/owned/9", "src/\n"); put(WL, "teams/backend/PROFILE.md", "p\n"); put(WL, ".editorconfig", "root = true\n");
commitAll(WL, "docs: record ticket 9");
r = rci(WL, "proteus/r1", "proteus-work/r1/lead-docs", "");
ok("lead-docs: the lead's docs, teams/, a new record and a lead-edits: glob pass with no Owned: line", r.status === 0, r.stderr);
put(WL, "src/e.txt", "e\n");
commitAll(WL, "feat: sneak");
r = rci(WL, "proteus/r1", "proteus-work/r1/lead-docs", "Owned: **");
ok("lead-docs: code on the lead's docs branch fails whatever the body says", r.status === 1 && /not in the lead's docs[\s\S]*src\/e\.txt/.test(r.stderr), r.stderr);
// fallback: a run cut before the records reads the PR body, with a warning, until it closes
const WO = branchWt("legacy", "proteus-work/old/3", "proteus/old");
put(WO, "src/f.txt", "f\n");
commitAll(WO, "feat(src): add f");
r = rci(WO, "proteus/old", "proteus-work/old/3", "Owned: src/");
ok("legacy run: a base with no .proteus/owned/ reads the PR body's line and warns", r.status === 0 && /warning: proteus\/old has no \.proteus\/owned\//.test(r.stderr), r.stderr);
r = rci(WO, "proteus/old", "proteus-work/old/3", "");
ok("legacy run: no Owned: line still fails", r.status === 1 && /no "Owned:/.test(r.stderr), r.stderr);
// into main (Quick, Direct: the human merges): the body's line, and never a record
const WQ = branchWt("quick", "proteus-work/quick/5", "main");
put(WQ, "src/g.txt", "g\n");
// staged with plumbing, not written: NTFS strips the trailing dot on disk, so a worktree file would
// reach the tree as .Proteus/Owned/5 on Windows; protectNTFS off lets git keep the spelling a push can
const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: WQ, input: "**\n", encoding: "utf8" }).stdout.trim();
g(WQ, "-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},.Proteus/Owned./5`);
g(WQ, "add", "src/g.txt"); // not commitAll: add -A would stage the record's absence from the disk
spawnSync("git", ["commit", "-qm", "fix(src): g", "--no-verify"], { cwd: WQ, encoding: "utf8", env: { ...process.env, ...ID } });
ok("into main: the fixture's tree holds the record under its trailing-dot spelling",
  g(WQ, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(".Proteus/Owned./5"));
r = rci(WQ, "main", "proteus-work/quick/5", "Owned: ** .Proteus/Owned./5");
ok("into main: the PR body's line counts, but a record (in any NTFS spelling) fails whatever it says",
  r.status === 1 && /\.Proteus\/Owned\.\/5/.test(r.stderr) && !/src\/g\.txt/.test(r.stderr) && !/warning/.test(r.stderr), r.stderr);
// the pre-commit hook refuses a record too, whatever the worktree's list covers
const PL = require(path.join(HOOKS, "proteus-lib.js"));
fs.writeFileSync(LIST, "**\n");
ok("pre-commit: a record under .proteus/owned/ is refused even when the list is **",
  /owned-path record/.test(PL.ownedDenial(WT, ".proteus/owned/1")) && /owned-path record/.test(PL.ownedDenial(WT, ".PROTEUS/owned/1")) && PL.ownedDenial(WT, "src/z.txt") === "");
fs.writeFileSync(LIST, was);
// proteus-worktree.js names a list that differs from the branch's record, which CI checks against
r = node(path.join(HOOKS, "proteus-worktree.js"), [path.join(W, "rec9"), "src/"], { cwd: RREPO });
ok("worktree script: a ticket with no record on its branch is warned about", r.status === 0 && /\.proteus\/owned\/9 is not on this branch/.test(r.stderr), r.stderr);
const W8 = branchWt("rec8", "proteus-work/r1/8", "proteus/r1");
r = node(path.join(HOOKS, "proteus-worktree.js"), [W8, "src/"], { cwd: RREPO });
ok("worktree script: paths that differ from the record are warned about", r.status === 0 && /differ from \.proteus\/owned\/8 \(docs\/\)/.test(r.stderr), r.stderr);
r = node(path.join(HOOKS, "proteus-worktree.js"), [W8, "docs/"], { cwd: RREPO });
ok("worktree script: the record's own paths raise no warning", r.status === 0 && !r.stderr, r.stderr);

// the shipped CI template: every placeholder fails, the job id stays gates, the owned step is wired
const tpl = fs.readFileSync(path.join(ROOT, "templates", "ci", "proteus-gates.yml"), "utf8").replace(/\r\n/g, "\n"); // a win32 checkout may have CRLF
const steps = tpl.split("\n").filter((l) => /^\s*- run: echo "EDIT-/.test(l));
ok("template: six placeholders (five code gates, the Direct job's docs gate), each exits 1; job id is gates; owned-paths step runs on worker PRs",
  steps.length === 6 && steps.every((l) => /exit 1/.test(l)) && /^  gates:$/m.test(tpl) &&
  /startsWith\(github\.head_ref, 'proteus-work\/'\)[\s\S]*proteus-owned-check\.js --ci/.test(tpl) && !/required review|one approving review/.test(tpl));
// #86: both owned steps run the base's checker from a detached worktree of the base, so a PR cannot change it
const baseRuns = tpl.match(/git worktree add -q --detach "\$RUNNER_TEMP\/base" "origin\/\$BASE_REF"\n\s+node "\$RUNNER_TEMP"\/base\/teams\/templates\/hooks\/proteus-owned-check\.js --ci "origin\/\$BASE_REF"/g) || [];
ok("template: the gates and direct owned steps run the base's checker, never the PR head's",
  baseRuns.length === 2 && !/node teams\/templates\/hooks\/proteus-owned-check\.js/.test(tpl), String(baseRuns.length));
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
