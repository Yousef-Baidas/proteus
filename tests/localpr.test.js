// The stand-in's PRs, statuses, bare origin and local checks, proteus-local-pr.js (#310): node tests/localpr.test.js.
// --init and each origin case, each pre-receive case, each pr command, flag, field and filter, the merge refusals and a
// lost race, each check outcome, and proteus-status.js and proteus-merge.js on a real PR. Most tests post a head's pending
// status before it heads a PR, so no detached runner starts, and run its check in the foreground; the detached start has
// its own tests.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const SRC = path.join(__dirname, "..", "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("localpr");
const LOCAL = path.join(SRC, "proteus-local.js");
const local = require(LOCAL);
const pr = require(path.join(SRC, "proteus-local-pr.js"));
const hooksLib = require(path.join(SRC, "proteus-lib.js"));

const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const gate = (cmd) => `# Agents\n\n## Learned\n- gate: \`${cmd}\`\n`;
const ENV_OUT = path.join(W, "gate-env.json"), RAN = path.join(W, "gate-ran.txt"), EVIL = path.join(W, "evil.txt");
const GATE_JS = `const fs = require("fs");
fs.appendFileSync(${JSON.stringify(RAN)}, process.cwd() + "\\n");
fs.writeFileSync(${JSON.stringify(ENV_OUT)}, JSON.stringify(Object.keys(process.env)));
if (fs.existsSync("big.flag")) process.stdout.write("x".repeat(3 << 20));
if (fs.existsSync("slow.flag")) setTimeout(() => {}, 60000);
else process.exitCode = fs.existsSync("fail.flag") ? 1 : 0;
`;

function repo(name, { agents = gate("node gate.js"), init = true } = {}) {
  const dir = path.join(W, name);
  fs.mkdirSync(dir, { recursive: true });
  lib.g(dir, "init", "-q", "-b", "main");
  lib.g(dir, "config", "user.name", "Repo Person");
  lib.g(dir, "config", "user.email", "repo@example.com");
  if (agents !== null) fs.writeFileSync(path.join(dir, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(dir, "gate.js"), GATE_JS);
  lib.g(dir, "add", ".");
  lib.g(dir, "commit", "-q", "-m", "init");
  const r = { dir, common: path.join(dir, ".git"), bare: path.join(dir, ".git", "proteus-local", "origin.git") };
  r.gh = (args, { input = "", env = {} } = {}) => lib.run(LOCAL, input, { cwd: dir, args, env: { CLAUDE_PROJECT_DIR: dir, ...env } });
  r.bareG = (...a) => lib.g(r.bare, ...a);
  r.claim = (sha) => path.join(r.common, "proteus-local", "checks", `${sha}.claim`);
  // sha on the origin with a pending gates status, so no runner starts for it: a check is this test's to run
  r.hold = (sha) => {
    lib.g(dir, "push", "-q", "origin", `${sha}:refs/heads/hold-${sha}`);
    r.status(sha, "pending");
  };
  // a commit on a new branch off start, pushed, held
  r.work = (branch, file, { start = "main", text = "x\n" } = {}) => {
    lib.g(dir, "checkout", "-q", "-b", branch, start);
    fs.writeFileSync(path.join(dir, file), text);
    lib.g(dir, "add", ".");
    lib.g(dir, "commit", "-q", "-m", `feat: ${file}`);
    const sha = lib.g(dir, "rev-parse", "HEAD");
    r.hold(sha);
    lib.g(dir, "push", "-q", "origin", `${branch}:${branch}`);
    lib.g(dir, "checkout", "-q", "main");
    return sha;
  };
  r.open = (branch, file, o = {}) => {
    const sha = r.work(branch, file, o);
    const made = r.gh(["pr", "create", "--base", o.base || "main", "--head", branch, "--title", `t ${branch}`, "--body", "b"]);
    return { sha, n: Number(/\/pull\/(\d+)$/.exec(made.out.trim())?.[1]), made };
  };
  r.status = (sha, state, context = "gates") => r.gh(["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", "description=d"]);
  r.check = (sha) => lib.run(LOCAL, "", { cwd: dir, args: ["--run-check", r.common, sha] });
  r.view = (n, fields) => json(r.gh(["pr", "view", String(n), "--json", fields]));
  if (init) {
    const made = r.gh(["--init"]);
    if (made.code !== 0) throw new Error(made.err);
    lib.g(dir, "push", "-q", "origin", "main");
  }
  return r;
}
async function until(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const bg = (r, args) => new Promise((res) => {
  const c = spawn(process.execPath, [LOCAL, ...args], { cwd: r.dir, env: { ...lib.ENV, CLAUDE_PROJECT_DIR: r.dir }, stdio: "ignore" });
  c.on("close", res);
});

function origins() {
  // ---- fresh, idempotent
  const a = repo("fresh", { init: false });
  let r = a.gh(["--init"]);
  ok("--init: exit 0", r.code === 0, r.err);
  ok("--init: a bare origin", a.bareG("rev-parse", "--is-bare-repository") === "true");
  ok("--init: the bare's own core.hooksPath", a.bareG("config", "core.hooksPath") === "hooks");
  ok("--init: origin added", fs.realpathSync(lib.g(a.dir, "remote", "get-url", "origin")) === fs.realpathSync(a.bare));
  ok("--init: default branch taken from the repo", a.bareG("symbolic-ref", "HEAD") === "refs/heads/main");
  for (const f of ["pre-receive", "post-receive"]) ok(`--init: hook ${f}`, fs.existsSync(path.join(a.bare, "hooks", f)));
  r = a.gh(["--init"]);
  ok("--init: idempotent with the origin in place", r.code === 0, r.err);
  ok("--init: one origin value", lib.g(a.dir, "config", "--get-all", "remote.origin.url").split("\n").length === 1);
  const gh = path.join(a.common, "proteus-local", "bin", "gh"), hook = path.join(a.bare, "hooks", "pre-receive");
  fs.writeFileSync(gh, "stale\n");
  fs.writeFileSync(hook, "stale\n");
  r = a.gh(["--init"]);
  ok("--init: a stale launcher and hook are refreshed", fs.readFileSync(gh, "utf8") !== "stale\n" && fs.readFileSync(hook, "utf8") !== "stale\n" && r.code === 0);
  const before = fs.statSync(gh).mtimeMs;
  a.gh(["--init"]);
  ok("--init: an unchanged launcher is not rewritten", fs.statSync(gh).mtimeMs === before);
  ok("--init: hook runs node on the hooks dir script, quoted", fs.readFileSync(hook, "utf8").includes(`node '${LOCAL.replace(/'/g, "'\\''")}' '--pre-receive'`));

  // ---- an origin elsewhere
  const b = repo("elsewhere", { init: false });
  lib.g(b.dir, "remote", "add", "origin", "https://example.invalid/o/r.git");
  r = b.gh(["--init"]);
  ok("--init: origin elsewhere refused, named", r.code === 1 && /https:\/\/example\.invalid\/o\/r\.git/.test(r.err), r.err);
  ok("--init: refusal writes no marker", !fs.existsSync(path.join(b.common, "proteus-lead", "local-mode")));
  ok("--init: refusal writes no store", !fs.existsSync(path.join(b.common, "proteus-local")));
  ok("--init: refusal never rewrites the remote", lib.g(b.dir, "remote", "get-url", "origin") === "https://example.invalid/o/r.git");
  const c = repo("pushurl", { init: false });
  lib.g(c.dir, "remote", "add", "origin", c.bare);
  lib.g(c.dir, "remote", "set-url", "--push", "origin", "https://example.invalid/o/r.git");
  r = c.gh(["--init"]);
  ok("--init: a push URL elsewhere refused", r.code === 1 && /example\.invalid/.test(r.err) && !fs.existsSync(path.join(c.common, "proteus-lead", "local-mode")), r.err);

  // ---- a link on the bare's path
  const d = repo("link", { init: false });
  const target = path.join(W, "link-target");
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(d.common, "proteus-local"));
  let linked = true;
  try { fs.symlinkSync(target, d.bare, "junction"); } catch { linked = false; }
  if (linked) {
    r = d.gh(["--init"]);
    ok("--init: a link at the bare path refused", r.code === 1 && !fs.readdirSync(target).length && !fs.existsSync(path.join(d.common, "proteus-lead", "local-mode")), r.err);
  }
  const f = repo("hooklink", { init: false });
  f.gh(["--init"]);
  const decoy = path.join(W, "decoy");
  fs.writeFileSync(decoy, "decoy\n");
  fs.rmSync(path.join(f.bare, "hooks", "pre-receive"));
  let hookLinked = true;
  try { fs.symlinkSync(decoy, path.join(f.bare, "hooks", "pre-receive")); } catch { hookLinked = false; }
  if (hookLinked) ok("--init: a link at a hook refused, its target kept", f.gh(["--init"]).code === 1 && fs.readFileSync(decoy, "utf8") === "decoy\n");

  // ---- an origin already here, a tracked default branch
  const g = repo("existing", { init: false });
  lib.g(g.dir, "remote", "add", "origin", pathToFileURL(g.bare).href);
  r = g.gh(["--init"]);
  ok("--init: a file URL at the bare stands", r.code === 0 && lib.g(g.dir, "remote", "get-url", "origin") === pathToFileURL(g.bare).href, r.err);
  const h = repo("tracked", { init: false });
  lib.g(h.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  h.gh(["--init"]);
  ok("--init: the tracked default branch wins", h.bareG("symbolic-ref", "HEAD") === "refs/heads/trunk");

  // ---- inherited GIT_DIR
  const e = repo("gitdir", { init: false });
  r = e.gh(["--init"], { env: { GIT_DIR: path.join(W, "fresh", ".git"), GIT_WORK_TREE: path.join(W, "fresh") } });
  ok("--init: an inherited GIT_DIR changes nothing", r.code === 0 && fs.existsSync(e.bare) && e.bareG("rev-parse", "--is-bare-repository") === "true", r.err);
}

function receive() {
  const a = repo("recv");
  const push = (...args) => { try { lib.g(a.dir, "push", "-q", ...args); return { ok: true, err: "" }; } catch (e) { return { ok: false, err: String(e.stderr) }; } };
  const tip = a.bareG("rev-parse", "refs/heads/main");
  ok("pre-receive: the first default push into the empty origin passed", /^[0-9a-f]{40}/.test(tip));
  lib.g(a.dir, "commit", "-q", "--allow-empty", "-m", "more");
  let r = push("origin", "main");
  ok("pre-receive: updating the default branch refused, ref named", !r.ok && /refs\/heads\/main/.test(r.err) && a.bareG("rev-parse", "refs/heads/main") === tip, r.err);
  r = push("origin", ":refs/heads/main");
  ok("pre-receive: deleting the default branch refused", !r.ok && a.bareG("rev-parse", "refs/heads/main") === tip);
  lib.g(a.dir, "reset", "-q", "--hard", tip);
  r = push("origin", "main:refs/heads/proteus/run1");
  ok("pre-receive: creating a run branch passes", r.ok, r.err);
  lib.g(a.dir, "commit", "-q", "--allow-empty", "-m", "more2");
  r = push("origin", "main:refs/heads/proteus/run1");
  ok("pre-receive: updating a run branch refused, ref named", !r.ok && /refs\/heads\/proteus\/run1/.test(r.err), r.err);
  r = push("origin", ":refs/heads/proteus/run1");
  ok("pre-receive: deleting a run branch refused", !r.ok);
  r = push("origin", "main:refs/heads/topic");
  ok("pre-receive: creating another branch passes", r.ok, r.err);
  lib.g(a.dir, "reset", "-q", "--hard", tip);
  r = push("-f", "origin", "main:refs/heads/topic");
  ok("pre-receive: forcing another branch passes", r.ok, r.err);
  ok("pre-receive: the two gates are one function", hooksLib.branchKind("main", "main", a.bare) === "main" && hooksLib.branchKind("proteus/run1", "main", a.bare) === "run" && hooksLib.branchKind("topic", "main", a.bare) === "");

  // a global core.hooksPath and a hook run by hand from elsewhere
  const off = path.join(W, "noop-hooks");
  fs.mkdirSync(off, { recursive: true });
  const glob = path.join(W, "global.gitconfig");
  fs.writeFileSync(glob, `[core]\n\thooksPath = ${off.replace(/\\/g, "/")}\n`);
  lib.g(a.dir, "checkout", "-q", "-B", "main");
  lib.g(a.dir, "commit", "-q", "--allow-empty", "-m", "more3");
  const refused = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: a.dir, env: { ...lib.ENV, GIT_CONFIG_GLOBAL: glob }, encoding: "utf8" });
  ok("pre-receive: a global core.hooksPath does not disable it", refused.status !== 0 && a.bareG("rev-parse", "refs/heads/main") === tip, refused.stderr);
  r = lib.run(LOCAL, "0 1 refs/heads/x\n", { cwd: a.dir, args: ["--pre-receive"] });
  ok("pre-receive: fails closed outside an origin", r.code === 1 && /not a local origin/.test(r.err), r.err);
  ok("merge-tree: exit 129 names the old git", (() => { try { pr.treeResult(129, "", "usage"); return false; } catch (e) { return /2\.38/.test(e.message); } })());
  ok("merge-tree: exit 1 is a conflict", pr.treeResult(1, "tree\nconflict", "").conflict === true);
  ok("merge-tree: unrelated histories read as a conflict", pr.treeResult(128, "", "fatal: refusing to merge unrelated histories").conflict === true);
  ok("merge-tree: exit 0 gives the tree", pr.treeResult(0, "abc\n", "").tree === "abc");
}

function commands() {
  const a = repo("cmds");
  const issue = a.gh(["issue", "create", "--title", "i", "--body", "b"]);
  ok("setup: an issue takes 1", issue.out.trim().endsWith("/issues/1"), issue.err);
  const one = a.open("feat/one", "one.txt");
  ok("pr create: prints a /pull/<n> URL, numbered with the issues", one.n === 2 && one.made.code === 0, one.made.out + one.made.err);
  let r = a.gh(["pr", "create", "--base", "main", "--head", "feat/one", "--title", "t", "--body", "b"]);
  ok("pr create: a duplicate open head and base refused in gh's words", r.code === 1 && /a pull request for branch "feat\/one" into branch "main" already exists/.test(r.err) && r.err.includes("/pull/2"), r.err);
  r = a.gh(["pr", "create", "--base", "nope", "--head", "feat/one", "--title", "t", "--body", "b"]);
  ok("pr create: missing base refused", r.code === 1 && /Base ref/.test(r.err), r.err);
  r = a.gh(["pr", "create", "--base", "main", "--head", "nope", "--title", "t", "--body", "b"]);
  ok("pr create: missing head refused", r.code === 1 && /Head ref/.test(r.err), r.err);
  r = a.gh(["pr", "create", "--base", "main", "--head", "main", "--title", "t", "--body", "b"]);
  ok("pr create: no commits refused", r.code === 1 && /No commits between/.test(r.err), r.err);
  r = a.gh(["pr", "create", "--draft", "--base", "main", "--head", "feat/one", "--title", "t"]);
  ok("pr create: an unused flag is a named refusal", r.code === 1 && /not supported/.test(r.err), r.err);
  r = a.gh(["pr", "create", "--base", "main", "--head", "feat/one"]);
  ok("pr create: no title refused", r.code === 1 && /--title/.test(r.err), r.err);

  a.work("feat/fill", "fill.txt");
  lib.g(a.dir, "checkout", "-q", "feat/fill");
  r = a.gh(["pr", "create", "--base", "main", "--fill"]);
  lib.g(a.dir, "checkout", "-q", "main");
  ok("pr create --fill: head from the checkout, title from the commit", r.code === 0 && a.view(3, "title,headRefName").title === "feat: fill.txt", r.out + r.err);
  ok("pr create --body-file -: reads stdin", (() => {
    a.work("feat/stdin", "stdin.txt");
    a.gh(["pr", "create", "--base", "main", "--head", "feat/stdin", "--title", "t", "--body-file", "-"], { input: "from stdin\n" });
    return a.view(4, "body").body === "from stdin\n";
  })());

  // ---- view
  const v = a.view(2, "number,title,body,state,url,baseRefName,headRefName,headRefOid,isDraft,reviews,comments,statusCheckRollup,mergeable,mergeStateStatus");
  ok("pr view --json: every field", v && v.number === 2 && v.state === "OPEN" && v.baseRefName === "main" && v.headRefName === "feat/one" && v.headRefOid === one.sha && v.isDraft === false && v.mergeable === "MERGEABLE" && v.mergeStateStatus === "BLOCKED" && Array.isArray(v.reviews) && Array.isArray(v.statusCheckRollup), JSON.stringify(v));
  ok("pr view -q filters", a.gh(["pr", "view", "2", "--json", "headRefOid", "-q", ".headRefOid"]).out.trim() === one.sha);
  ok("pr view: an unknown field is refused", a.gh(["pr", "view", "2", "--json", "nope"]).code === 1);
  ok("pr view: an unknown PR fails in gh's words", /Could not resolve to a PullRequest/.test(a.gh(["pr", "view", "99"]).err));
  ok("pr view: text form", /feat|t feat\/one/.test(a.gh(["pr", "view", "2"]).out));
  ok("pr view: a bad argument is a named refusal", /not supported/.test(a.gh(["pr", "view", "x"]).err));
  lib.g(a.dir, "checkout", "-q", "feat/one");
  ok("pr view: no argument finds the branch's PR", a.gh(["pr", "view", "--json", "number", "-q", ".number"]).out.trim() === "2");
  lib.g(a.dir, "checkout", "-q", "main");

  // ---- live head
  lib.g(a.dir, "checkout", "-q", "feat/one");
  lib.g(a.dir, "commit", "-q", "--allow-empty", "-m", "next");
  const next = lib.g(a.dir, "rev-parse", "HEAD");
  a.hold(next);
  lib.g(a.dir, "push", "-q", "origin", "feat/one");
  lib.g(a.dir, "checkout", "-q", "main");
  ok("pr view: an open PR's head is the live ref", a.view(2, "headRefOid").headRefOid === next);

  // ---- list
  ok("pr list: fields", (() => {
    const list = json(a.gh(["pr", "list", "--state", "open", "--json", "number,headRefName,headRefOid,body,isDraft,statusCheckRollup,reviews,comments,title,url", "--limit", "200"]));
    return list.length === 3 && list[0].number === 4 && list[2].headRefOid === next;
  })());
  ok("pr list --base and --head", json(a.gh(["pr", "list", "--base", "main", "--head", "feat/fill", "--json", "number"]))[0].number === 3 && json(a.gh(["pr", "list", "--base", "other", "--json", "number"])).length === 0);
  ok("pr list --limit", json(a.gh(["pr", "list", "--limit", "1", "--json", "number"])).length === 1);
  ok("pr list -q .[].number", a.gh(["pr", "list", "--json", "number", "-q", ".[].number"]).out === "4\n3\n2\n");
  ok("pr list: a bad --state refused", a.gh(["pr", "list", "--state", "x"]).code === 1);
  ok("pr list: text form", /feat\/fill/.test(a.gh(["pr", "list"]).out));

  // ---- diff
  r = a.gh(["pr", "diff", "2", "--name-only"]);
  ok("pr diff --name-only: from the merge base", r.out === "one.txt\n", r.out + r.err);
  ok("pr diff: the patch", /\+x/.test(a.gh(["pr", "diff", "2"]).out));

  // ---- comment, review, edit
  r = a.gh(["pr", "comment", "2", "--body-file", "-"], { input: "note\n" });
  ok("pr comment --body-file -: stored and returned", r.code === 0 && /#issuecomment-/.test(r.out) && a.view(2, "comments").comments[0].body === "note\n", r.err);
  ok("pr comment: an empty body refused", a.gh(["pr", "comment", "2", "--body", " "]).code === 1);
  a.gh(["pr", "review", "2", "--comment", "--body", "looks"]);
  a.gh(["pr", "review", "2", "--request-changes", "--body", "fix"]);
  ok("pr review: stored and returned", a.view(2, "reviews").reviews.map((x) => x.state).join() === "COMMENTED,CHANGES_REQUESTED");
  ok("pr review --approve: a named refusal", /not supported/.test(a.gh(["pr", "review", "2", "--approve", "--body", "x"]).err));
  ok("pr review: needs one kind", a.gh(["pr", "review", "2", "--body", "x"]).code === 1);
  r = a.gh(["pr", "edit", "2", "--body-file", "-"], { input: "new body" });
  ok("pr edit: body replaced", r.code === 0 && a.view(2, "body").body === "new body", r.err);
  a.gh(["pr", "edit", "2", "--title", "new title"]);
  ok("pr edit: title replaced", a.view(2, "title").title === "new title");
  ok("pr edit: nothing to do refused", a.gh(["pr", "edit", "2"]).code === 1);
  ok("pr: an unknown command is a named refusal", /gh pr close is not supported|pr close/.test(a.gh(["pr", "close", "2"]).err));
  ok("pr merge --delete-branch: a named refusal", /not supported/.test(a.gh(["pr", "merge", "2", "--merge", "--delete-branch"]).err));

  // ---- statuses and the api paths
  r = a.status(next, "bogus");
  ok("api statuses: a bad state refused in gh's words", r.code === 1 && /Validation Failed \(HTTP 422\)/.test(r.err), r.err);
  r = a.status("f".repeat(40), "success");
  ok("api statuses: an unknown commit refused", r.code === 1);
  r = a.gh(["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${next}`, "-f", "state=success", "-f", "context=proteus/verdict", "-f", "description=MERGE", "--jq", ".state"]);
  ok("api statuses: posts, --jq reads it", r.out === "success\n", r.out + r.err);
  ok("api commits/<sha>/statuses", json(a.gh(["api", `repos/{owner}/{repo}/commits/${next}/statuses`]))[0].context === "proteus/verdict");
  a.status(next, "success");
  let combined = json(a.gh(["api", `repos/{owner}/{repo}/commits/${next}/status`]));
  ok("api commits/<sha>/status: combined success", combined.state === "success" && combined.total_count === 2, JSON.stringify(combined));
  a.status(next, "failure", "other");
  combined = json(a.gh(["api", `repos/{owner}/{repo}/commits/${next}/status`]));
  ok("api commits/<sha>/status: combined failure", combined.state === "failure");
  a.status(next, "success", "other");
  ok("statusCheckRollup: gh's StatusContext shape, newest per context", (() => {
    const list = a.view(2, "statusCheckRollup").statusCheckRollup, c = list.find((x) => x.context === "other");
    return list.length === 3 && c.__typename === "StatusContext" && c.state === "SUCCESS" && "startedAt" in c && "targetUrl" in c;
  })());
  ok("mergeStateStatus: an open PR's gates pending is BLOCKED", a.view(3, "mergeStateStatus").mergeStateStatus === "BLOCKED");
  ok("mergeStateStatus: all green is CLEAN", a.view(2, "mergeStateStatus").mergeStateStatus === "CLEAN");
  a.status(next, "failure", "other");
  ok("mergeStateStatus: gates green, another red is UNSTABLE", a.view(2, "mergeStateStatus").mergeStateStatus === "UNSTABLE");
  ok("api pulls/<n>/files", json(a.gh(["api", "--paginate", "repos/{owner}/{repo}/pulls/2/files"]))[0].filename === "one.txt");
  lib.g(a.dir, "checkout", "-q", "-b", "feat/move", "main");
  lib.g(a.dir, "mv", "gate.js", "moved.js");
  lib.g(a.dir, "commit", "-q", "-m", "move");
  a.hold(lib.g(a.dir, "rev-parse", "HEAD"));
  lib.g(a.dir, "push", "-q", "origin", "feat/move");
  lib.g(a.dir, "checkout", "-q", "main");
  r = a.gh(["pr", "create", "--base", "main", "--head", "feat/move", "--title", "m", "--body", "b"]);
  ok("api pulls/<n>/files: a rename keeps previous_filename", (() => {
    const f = json(a.gh(["api", "repos/{owner}/{repo}/pulls/5/files"]))[0];
    return f.filename === "moved.js" && f.previous_filename === "gate.js" && f.status === "renamed";
  })(), r.err);
  ok("api contents: base64 from the ref", Buffer.from(json(a.gh(["api", "repos/{owner}/{repo}/contents/AGENTS.md?ref=main"])).content, "base64").toString() === gate("node gate.js"));
  ok("api contents: a missing path is 404", /HTTP 404/.test(a.gh(["api", "repos/{owner}/{repo}/contents/nope?ref=main"]).err));
  ok("api contents: an option as a ref refused", /HTTP 404/.test(a.gh(["api", "repos/{owner}/{repo}/contents/AGENTS.md?ref=--all"]).err));
  ok("api contents: .. refused", /HTTP 404/.test(a.gh(["api", "repos/{owner}/{repo}/contents/a/../b?ref=main"]).err));
  ok("api: a write to a read path refused", a.gh(["api", "-X", "POST", `repos/{owner}/{repo}/commits/${next}/statuses`]).code === 1);
  ok("api: other paths stay refused", /not supported/.test(a.gh(["api", "repos/{owner}/{repo}/rules/branches/main"]).err));

  // ---- the store is untrusted
  const file = path.join(a.common, "proteus-local", "tracker", "pulls", "4.json");
  const keep = fs.readFileSync(file);
  for (const [what, edit] of [["a number that is not its name", { number: 9 }], ["a branch that is an option", { headRefName: "--upload-pack=x" }], ["a bad state", { state: "x" }], ["an open PR with a recorded head", { headRefOid: "a".repeat(40) }]]) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(keep), ...edit }));
    r = a.gh(["pr", "view", "4", "--json", "number"]);
    ok(`store: ${what} is malformed`, r.code === 1 && /malformed/.test(r.err), r.err);
  }
  fs.writeFileSync(file, keep);
  const sfile = path.join(a.common, "proteus-local", "tracker", "statuses", `${next}.json`), skeep = fs.readFileSync(sfile);
  fs.writeFileSync(sfile, JSON.stringify([{ state: "success" }]));
  ok("store: a bad status is malformed", /malformed/.test(a.gh(["pr", "view", "2", "--json", "statusCheckRollup"]).err));
  fs.writeFileSync(sfile, skeep);
  const pulls = path.join(a.common, "proteus-local", "tracker", "pulls");
  fs.renameSync(pulls, `${pulls}.real`);
  let dirLinked = true;
  try { fs.symlinkSync(`${pulls}.real`, pulls, "junction"); } catch { dirLinked = false; }
  if (dirLinked) {
    ok("store: a link at the PR dir refused", a.gh(["pr", "list"]).code === 1);
    fs.rmSync(pulls, { recursive: true });
  }
  fs.renameSync(`${pulls}.real`, pulls);
  a.bareG("update-ref", "-d", "refs/heads/feat/fill");
  r = a.gh(["pr", "view", "3", "--json", "headRefOid"]);
  ok("pr view: an open PR's missing head is an error", r.code === 1 && /missing/.test(r.err), r.err);
}

function merges() {
  const a = repo("merges");
  const one = a.open("feat/m1", "m1.txt");
  let r = a.gh(["pr", "merge", String(one.n)]);
  ok("pr merge: needs --merge", r.code === 1, r.err);
  r = a.gh(["pr", "merge", String(one.n), "--merge"]);
  ok("pr merge: a pending required status refused, named", r.code === 1 && /required status gates is pending/.test(r.err), r.err);
  const bare = a.work("feat/m0", "m0.txt");
  fs.rmSync(path.join(a.common, "proteus-local", "tracker", "statuses", `${bare}.json`));
  fs.writeFileSync(a.claim(bare), "");
  a.gh(["pr", "create", "--base", "main", "--head", "feat/m0", "--title", "t", "--body", "b"]);
  fs.rmSync(path.join(a.common, "proteus-local", "tracker", "statuses", `${bare}.json`));
  r = a.gh(["pr", "merge", "2", "--merge"]);
  ok("pr merge: a missing required status refused, named", r.code === 1 && /required status gates is missing/.test(r.err), r.err);
  a.status(one.sha, "failure");
  r = a.gh(["pr", "merge", String(one.n), "--merge"]);
  ok("pr merge: a red required status refused", r.code === 1 && /gates is failure/.test(r.err), r.err);
  a.status(one.sha, "success");
  r = a.gh(["pr", "merge", String(one.n), "--merge", "--admin"]);
  ok("pr merge --admin: unsupported", r.code === 1 && /not supported/.test(r.err), r.err);
  r = a.gh(["pr", "merge", String(one.n), "--merge", "--match-head-commit", "a".repeat(40)]);
  ok("pr merge: head moved fails as gh does", r.code === 1 && /Head branch was modified/.test(r.err), r.err);
  a.gh(["pr", "review", String(one.n), "--request-changes", "--body", "no"]);
  const before = a.bareG("rev-parse", "refs/heads/main");
  r = a.gh(["pr", "merge", String(one.n), "--merge", "--match-head-commit", one.sha]);
  ok("pr merge: clean, a changes-requested review does not hold it", r.code === 0, r.err);
  const tip = a.bareG("rev-parse", "refs/heads/main");
  ok("pr merge: both parents", a.bareG("rev-parse", "refs/heads/main^1") === before && a.bareG("rev-parse", "refs/heads/main^2") === one.sha);
  ok("pr merge: the repo's identity", a.bareG("log", "-1", "--format=%an <%ae>", tip) === "Repo Person <repo@example.com>");
  const done = a.view(one.n, "state,headRefOid,mergeable,mergeStateStatus");
  ok("pr view: a merged PR keeps its oid, UNKNOWN mergeable", done.state === "MERGED" && done.headRefOid === one.sha && done.mergeable === "UNKNOWN" && done.mergeStateStatus === "UNKNOWN", JSON.stringify(done));
  r = a.gh(["pr", "merge", String(one.n), "--merge"]);
  ok("pr merge: already merged refused", r.code === 1 && /already merged/.test(r.err), r.err);
  ok("pr list --state: merged hidden from open, in all", json(a.gh(["pr", "list", "--json", "number"])).length === 1 && json(a.gh(["pr", "list", "--state", "all", "--json", "number"])).length === 2 && json(a.gh(["pr", "list", "--state", "merged", "--json", "number"])).length === 1);
  ok("pr diff: an ended PR still shows its change", a.gh(["pr", "diff", String(one.n), "--name-only"]).out === "m1.txt\n");
  a.bareG("update-ref", "-d", "refs/heads/feat/m1");
  ok("pr view: an ended PR's head needs no ref", a.view(one.n, "headRefOid").headRefOid === one.sha);

  // ---- fallback identity
  const b = repo("merges-id");
  const pb = b.open("feat/id", "id.txt");
  b.status(pb.sha, "success");
  lib.g(b.dir, "config", "--unset", "user.name");
  lib.g(b.dir, "config", "--unset", "user.email");
  r = b.gh(["pr", "merge", String(pb.n), "--merge"]);
  ok("pr merge: a fixed identity only when the repo has none", r.code === 0 && b.bareG("log", "-1", "--format=%ae", "refs/heads/main") === "local@proteus.invalid", r.err);

  // ---- into a run branch
  lib.g(a.dir, "fetch", "-q", "origin");
  a.bareG("branch", "proteus/run2", "refs/heads/main");
  const run = a.open("feat/r1", "r1.txt", { start: "origin/main", base: "proteus/run2" });
  a.status(run.sha, "success");
  r = a.gh(["pr", "merge", String(run.n), "--merge"]);
  ok("pr merge: a run branch needs proteus/verdict, as the host's rules do", r.code === 1 && /required status proteus\/verdict is missing/.test(r.err), r.err);
  a.status(run.sha, "failure", "proteus/verdict");
  r = a.gh(["pr", "merge", String(run.n), "--merge"]);
  ok("pr merge: a failed proteus/verdict refused", r.code === 1 && /required status proteus\/verdict is failure/.test(r.err), r.err);
  a.status(run.sha, "success", "proteus/verdict");
  r = a.gh(["pr", "merge", String(run.n), "--merge"]);
  ok("pr merge: into a run branch", r.code === 0 && a.bareG("rev-parse", "refs/heads/proteus/run2^2") === run.sha, r.err);

  // ---- conflict
  const c = repo("conflict");
  const left = c.open("feat/left", "same.txt", { text: "left\n" });
  const right = c.open("feat/right", "same.txt", { text: "right\n" });
  c.status(left.sha, "success");
  c.status(right.sha, "success");
  c.gh(["pr", "merge", String(left.n), "--merge"]);
  ok("mergeable: a conflict reads CONFLICTING/DIRTY", (() => { const v = c.view(right.n, "mergeable,mergeStateStatus"); return v.mergeable === "CONFLICTING" && v.mergeStateStatus === "DIRTY"; })());
  const held = c.bareG("rev-parse", "refs/heads/main");
  r = c.gh(["pr", "merge", String(right.n), "--merge"]);
  ok("pr merge: a conflict refused, nothing moved", r.code === 1 && /cannot be cleanly created/.test(r.err) && c.bareG("rev-parse", "refs/heads/main") === held, r.err);

  // ---- closed
  const d = repo("closed");
  const pd = d.open("feat/c", "c.txt");
  d.status(pd.sha, "success");
  const file = path.join(d.common, "proteus-local", "tracker", "pulls", `${pd.n}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state: "CLOSED", headRefOid: pd.sha, baseRefOid: d.bareG("rev-parse", "refs/heads/main"), closedAt: "2026-01-01T00:00:00Z" }));
  r = d.gh(["pr", "merge", String(pd.n), "--merge"]);
  ok("pr merge: closed refused", r.code === 1 && /is closed/.test(r.err), r.err);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state: "OPEN", headRefOid: null, baseRefOid: null, closedAt: null, isDraft: true }));
  r = d.gh(["pr", "merge", String(pd.n), "--merge"]);
  ok("pr merge: a draft refused", r.code === 1 && /draft/.test(r.err), r.err);
  ok("mergeStateStatus: a draft is DRAFT", d.view(pd.n, "mergeStateStatus").mergeStateStatus === "DRAFT");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state: "CLOSED", headRefOid: pd.sha, baseRefOid: d.bareG("rev-parse", "refs/heads/main"), closedAt: "2026-01-01T00:00:00Z", isDraft: false }));
  ok("pr list --state closed holds it", json(d.gh(["pr", "list", "--state", "closed", "--json", "number"])).length === 1);

  // ---- a push that wins the race
  const e = repo("race");
  const pe = e.open("feat/race", "race.txt");
  const old = e.bareG("rev-parse", "refs/heads/main");
  const s = local.open(e.common);
  const tree = e.bareG("rev-parse", `${pe.sha}^{tree}`);
  e.bareG("update-ref", "refs/heads/main", e.bareG("commit-tree", "-p", old, "-m", "raced", tree), old);
  let lost = "";
  try { local.pr.commitMerge(s, { baseRefName: "main", headRefName: "feat/race" }, old, pe.sha, tree, pe.n, "t"); } catch (err) { lost = err.message; }
  ok("merge: a stale old value loses to the push, by name", /main moved during the merge/.test(lost), lost);
}

async function parallel() {
  const a = repo("parallel");
  const prs = [];
  for (const i of [1, 2, 3, 4]) {
    const p = a.open(`feat/p${i}`, `p${i}.txt`);
    a.status(p.sha, "success");
    prs.push(p);
  }
  const codes = await Promise.all(prs.map((p) => bg(a, ["pr", "merge", String(p.n), "--merge"])));
  ok("pr merge: parallel merges all land", codes.every((c) => c === 0) && prs.every((p) => a.gh(["pr", "view", String(p.n), "--json", "state", "-q", ".state"]).out.trim() === "MERGED"), codes.join());
  ok("pr merge: parallel merges chain", prs.every((p) => lib.run(LOCAL, "", { cwd: a.dir, args: ["pr", "diff", String(p.n), "--name-only"], env: { CLAUDE_PROJECT_DIR: a.dir } }).code === 0) && a.bareG("rev-list", "--count", "--merges", "refs/heads/main") === "4");

  const b = repo("parallel-create");
  for (const i of [1, 2, 3, 4]) b.work(`feat/q${i}`, `q${i}.txt`);
  await Promise.all([1, 2, 3, 4].map((i) => bg(b, ["pr", "create", "--base", "main", "--head", `feat/q${i}`, "--title", `q${i}`, "--body", "b"])));
  ok("pr create: parallel creates take distinct numbers", new Set(json(b.gh(["pr", "list", "--json", "number"])).map((p) => p.number)).size === 4);
}

async function checks() {
  const a = repo("chk");
  // ---- pass, with the worktree gone and tokens stripped
  const pass = a.open("feat/pass", "pass.txt");
  let list = json(a.gh(["pr", "checks", String(pass.n), "--json", "name,state,bucket,link,description"]));
  ok("pr checks: a pending row", list.length === 1 && list[0].name === "gates" && list[0].state === "PENDING" && list[0].bucket === "pending", JSON.stringify(list));
  let r = a.gh(["pr", "checks", String(pass.n)]);
  ok("pr checks: pending exits 8", r.code === 8, r.code + r.err);
  ok("pr checks: reads start nothing", !fs.existsSync(RAN));
  const tokens = Object.fromEntries(hooksLib.SANDBOX_TOKENS.map((k) => [k, "secret"]));
  r = lib.run(LOCAL, "", { cwd: a.dir, args: ["--run-check", a.common, pass.sha], env: { ...tokens, GIT_DIR: "/nonexistent", PLAIN_VAR: "kept" } });
  ok("runner: exit 0", r.code === 0, r.err);
  list = json(a.gh(["pr", "checks", String(pass.n), "--json", "name,state,bucket,link,description"]));
  ok("runner: gates success", list[0].state === "SUCCESS" && list[0].bucket === "pass", JSON.stringify(list));
  ok("pr checks: the log's path is the link", list[0].link === path.join(a.common, "proteus-local", "checks", `${pass.sha}.log`) && fs.existsSync(list[0].link), list[0].link);
  r = a.gh(["pr", "checks", String(pass.n)]);
  ok("pr checks: pass exits 0, tabbed row", r.code === 0 && r.out.split("\t")[0] === "gates" && r.out.split("\t")[1] === "pass", r.out);
  r = a.gh(["pr", "checks", String(pass.n), "--watch", "--interval", "0"]);
  ok("pr checks --watch: settles at once when nothing is pending", r.code === 0, r.err);
  ok("pr checks --watch with --json refused", a.gh(["pr", "checks", String(pass.n), "--watch", "--json", "name"]).code === 1);
  ok("pr checks: a bad --interval refused", a.gh(["pr", "checks", String(pass.n), "--interval", "x"]).code === 1);
  ok("pr checks: an unknown field refused", a.gh(["pr", "checks", String(pass.n), "--json", "nope"]).code === 1);
  const keys = JSON.parse(fs.readFileSync(ENV_OUT, "utf8"));
  ok("runner: tokens and git vars stripped, the rest kept", !keys.some((k) => hooksLib.SANDBOX_TOKENS.includes(k.toUpperCase()) || /^GIT_DIR$/i.test(k)) && keys.includes("PLAIN_VAR"), keys.join());
  const cwd = fs.readFileSync(RAN, "utf8").trim().split("\n").pop();
  ok("runner: ran under the state dir, and removed it", cwd.includes(path.join("proteus", "local-checks")) && !fs.existsSync(cwd), cwd);
  ok("runner: no worktree left", a.bareG("worktree", "list").trim().split("\n").length === 1);
  r = lib.run(LOCAL, "", { cwd: a.dir, args: ["--run-check", a.common, pass.sha] });
  const runs = fs.readFileSync(RAN, "utf8").trim().split("\n").length;
  ok("runner: one run per sha, the claim stands", r.code === 0 && runs === 1, runs);

  // ---- fail, big output, timeout
  const bad = a.open("feat/bad", "fail.flag");
  a.check(bad.sha);
  r = a.gh(["pr", "checks", String(bad.n)]);
  ok("pr checks: fail exits 1, failure status", r.code === 1 && /\tfail\t/.test(r.out) && /exit 1: node gate\.js/.test(r.out), r.out + r.err);
  ok("pr view: a failed gate is BLOCKED", a.view(bad.n, "mergeStateStatus").mergeStateStatus === "BLOCKED");
  const big = a.open("feat/big", "big.flag");
  a.check(big.sha);
  const log = path.join(a.common, "proteus-local", "checks", `${big.sha}.log`);
  ok("runner: the log is capped, the run passes", fs.statSync(log).size < (1 << 20) + 200 && /log cut/.test(fs.readFileSync(log, "utf8").slice(-40)), fs.statSync(log).size);
  const slow = a.open("feat/slow", "slow.flag");
  const posted = await local.pr.runCheck(a.common, slow.sha, 300);
  r = a.gh(["pr", "checks", String(slow.n)]);
  ok("runner: a timeout is a failure naming the command", posted === true && r.code === 1 && /timed out: node gate\.js/.test(r.out), r.out + r.err);
  ok("runner: no worktree left after a timeout", a.bareG("worktree", "list").trim().split("\n").length === 1);

  // ---- stale result
  const st = a.open("feat/stale", "st.txt");
  lib.g(a.dir, "checkout", "-q", "feat/stale");
  lib.g(a.dir, "commit", "-q", "--allow-empty", "-m", "newer");
  const newer = lib.g(a.dir, "rev-parse", "HEAD");
  a.hold(newer);
  lib.g(a.dir, "push", "-q", "origin", "feat/stale");
  lib.g(a.dir, "checkout", "-q", "main");
  a.check(st.sha);
  ok("runner: a stale head's result posts nowhere", json(a.gh(["api", `repos/{owner}/{repo}/commits/${st.sha}/statuses`])).length === 1);
  ok("runner: a stale result leaves the newer head pending", a.view(st.n, "statusCheckRollup").statusCheckRollup[0].state === "PENDING");

  // ---- no gates, gates from the default branch
  const none = repo("nogates", { agents: "# Agents\n" });
  const pn = none.open("feat/n", "n.txt");
  none.check(pn.sha);
  r = none.gh(["pr", "checks", String(pn.n)]);
  ok("no gate commands: failure with a description", r.code === 1 && /no gate command/.test(r.out), r.out + r.err);

  const evil = repo("evil");
  lib.g(evil.dir, "checkout", "-q", "-b", "feat/e");
  fs.writeFileSync(path.join(evil.dir, "AGENTS.md"), gate("node evil.js"));
  fs.writeFileSync(path.join(evil.dir, "evil.js"), `require("fs").writeFileSync(${JSON.stringify(EVIL)}, "x");`);
  lib.g(evil.dir, "add", ".");
  lib.g(evil.dir, "commit", "-q", "-m", "gates of its own");
  const sha = lib.g(evil.dir, "rev-parse", "HEAD");
  evil.hold(sha);
  lib.g(evil.dir, "push", "-q", "origin", "feat/e");
  lib.g(evil.dir, "checkout", "-q", "main");
  evil.gh(["pr", "create", "--base", "main", "--head", "feat/e", "--title", "t", "--body", "b"]);
  evil.check(sha);
  ok("runner: gates come from the default branch, never the head", !fs.existsSync(EVIL) && evil.gh(["pr", "checks", "1"]).code === 0);

  // ---- a dead claim, a runner that cannot start
  const dead = repo("dead");
  const pd = dead.open("feat/d", "d.txt");
  const sfile = path.join(dead.common, "proteus-local", "tracker", "statuses", `${pd.sha}.json`);
  const old = new Date(Date.now() - 3600000);
  fs.writeFileSync(dead.claim(pd.sha), "");
  fs.utimesSync(dead.claim(pd.sha), old, old);
  r = dead.gh(["pr", "checks", String(pd.n)]);
  ok("dead claim: an old claim turns pending to error on a read", r.code === 1 && /died/.test(r.out), r.out + r.err);
  ok("dead claim: posted once", JSON.parse(fs.readFileSync(sfile, "utf8")).filter((c) => c.state === "error").length === 1 && dead.gh(["pr", "checks", String(pd.n)]).code === 1);
  const quick = dead.open("feat/live", "l.txt");
  fs.writeFileSync(dead.claim(quick.sha), "");
  ok("a live claim stays pending", dead.gh(["pr", "checks", String(quick.n)]).code === 8);
  ok("a pending status with no claim yet stays pending", dead.gh(["pr", "checks", String(dead.open("feat/noclaim", "nc.txt").n)]).code === 8);

  const sf = dead.open("feat/gone", "g.txt");
  const held = path.join(dead.common, "proteus-local", "tracker", "statuses", `${sf.sha}.json`);
  fs.writeFileSync(held, JSON.stringify(JSON.parse(fs.readFileSync(held, "utf8")).map((c) => ({ ...c, createdAt: "2026-01-01T00:00:00Z" }))));
  r = dead.gh(["pr", "merge", String(sf.n), "--merge"]);
  ok("a run that never started: a merge reads it dead, and refuses", r.code === 1 && /gates is error/.test(r.err), r.err);

  // ---- detached, from pr create and from a push
  const d = repo("detached");
  lib.g(d.dir, "checkout", "-q", "-b", "feat/det");
  lib.g(d.dir, "commit", "-q", "--allow-empty", "-m", "det");
  lib.g(d.dir, "push", "-q", "origin", "feat/det");
  lib.g(d.dir, "checkout", "-q", "main");
  const head = d.bareG("rev-parse", "refs/heads/feat/det");
  r = d.gh(["pr", "create", "--base", "main", "--head", "feat/det", "--title", "t", "--body", "b"]);
  const settled = (n) => { const x = d.gh(["pr", "checks", String(n)]); return x.code === 0 ? "pass" : x.code === 1 ? x.out + x.err : ""; };
  ok("pr create: a detached run reaches success", (await until(() => settled(1))) === "pass", r.err);
  ok("pr create: pending was posted first", json(d.gh(["api", `repos/{owner}/{repo}/commits/${head}/statuses`])).pop().state === "pending");
  lib.g(d.dir, "checkout", "-q", "feat/det");
  lib.g(d.dir, "commit", "-q", "--allow-empty", "-m", "again");
  lib.g(d.dir, "push", "-q", "origin", "feat/det");
  lib.g(d.dir, "checkout", "-q", "main");
  ok("post-receive: a detached run reaches success on the new head", (await until(() => settled(1))) === "pass");
  ok("post-receive: on the new head", d.view(1, "statusCheckRollup").statusCheckRollup[0].state === "SUCCESS");
  const before = fs.readFileSync(RAN, "utf8");
  lib.g(d.dir, "push", "-q", "origin", "feat/det:refs/heads/plain");
  await sleep(200);
  ok("post-receive: a branch with no open PR starts nothing", fs.readFileSync(RAN, "utf8") === before);
}

function scripts() {
  // proteus-status.js and proteus-merge.js through lib.gh, on a real PR
  const a = repo("e2e");
  a.bareG("branch", "proteus/rr", "refs/heads/main");
  lib.g(a.dir, "fetch", "-q", "origin");
  const p = a.open("proteus/rr-t1", "t1.txt", { start: "origin/proteus/rr", base: "proteus/rr" });
  lib.g(a.dir, "branch", "proteus/rr", "origin/proteus/rr");
  const hooks = path.join(a.dir, ".claude", "hooks");
  fs.cpSync(SRC, hooks, { recursive: true });
  a.status(p.sha, "success");
  a.status(p.sha, "success", "proteus/verdict");
  const env = { CLAUDE_PROJECT_DIR: a.dir };
  let r = lib.run(path.join(hooks, "proteus-status.js"), "", { cwd: a.dir, args: ["rr", "--json"], env });
  const st = json(r);
  ok("proteus-status.js: reads a real local PR", st && st.state === "ok" && st.prs.open === 1, r.out + r.err);
  r = lib.run(path.join(hooks, "proteus-merge.js"), "", { cwd: a.dir, args: ["rr", "--suite", "node gate.js"], env });
  ok("proteus-merge.js: merges a real local PR", a.gh(["pr", "view", String(p.n), "--json", "state", "-q", ".state"]).out.trim() === "MERGED", r.out + r.err);
  ok("proteus-merge.js: the run branch took it", a.bareG("rev-parse", "refs/heads/proteus/rr^2") === p.sha);

  // outside local mode
  const b = path.join(W, "plain");
  fs.mkdirSync(b);
  lib.g(b, "init", "-q");
  r = lib.run(LOCAL, "", { cwd: b, args: ["pr", "list"], env: { CLAUDE_PROJECT_DIR: b } });
  ok("outside local mode: pr refused the same way", r.code === 1 && /not in local mode/.test(r.err), r.err);
  r = lib.run(LOCAL, "", { cwd: b, args: ["--run-check", path.join(b, ".git"), "a".repeat(40)] });
  ok("outside local mode: --run-check refused", r.code === 1, r.err);
}

// a PR that sets the first gate: no command ran, RAN stays absent; any other head on a gateless default branch fails
function firstGates() {
  const BARE = "# Agents\n\n## Learned\n- domain: code\n";
  const write = (r, file, text) => fs.writeFileSync(path.join(r.dir, file), text);
  // a head off main with what edit stages, opened and checked in the foreground
  const pr = (r, branch, edit) => {
    fs.rmSync(RAN, { force: true });
    lib.g(r.dir, "checkout", "-q", "-b", branch, "main");
    edit();
    lib.g(r.dir, "commit", "-q", "-m", `feat: ${branch}`);
    const sha = lib.g(r.dir, "rev-parse", "HEAD");
    r.hold(sha);
    lib.g(r.dir, "push", "-q", "origin", branch);
    lib.g(r.dir, "checkout", "-qf", "main");
    const made = r.gh(["pr", "create", "--base", "main", "--head", branch, "--title", `t ${branch}`, "--body", "b"]);
    r.check(sha);
    const n = Number(/\/pull\/(\d+)$/.exec(made.out.trim())?.[1]);
    return { sha, n, row: json(r.gh(["pr", "checks", String(n), "--json", "state,description"]))[0] };
  };
  const setGate = (r, text = BARE + "- gate: `node gate.js`\n") => { write(r, "AGENTS.md", text); lib.g(r.dir, "add", "AGENTS.md"); };
  const refused = (name, { row }) => {
    ok(`first gate: ${name} fails, naming the rule`, row.state === "FAILURE" && /no gate command/.test(row.description) && /AGENTS\.md alone/.test(row.description), JSON.stringify(row));
    ok(`first gate: ${name} runs nothing`, !fs.existsSync(RAN));
  };

  const a = repo("firstgate", { agents: BARE });
  const good = pr(a, "feat/gate", () => setGate(a));
  ok("first gate: a PR changing only AGENTS.md and adding the line passes", good.row.state === "SUCCESS" && /no command run/.test(good.row.description) && /first gate/.test(good.row.description), JSON.stringify(good.row));
  ok("first gate: no gate command ran for it", !fs.existsSync(RAN));
  ok("first gate: the PR reads mergeable", a.view(good.n, "mergeStateStatus").mergeStateStatus === "CLEAN");
  let r = a.gh(["pr", "merge", String(good.n), "--merge"]);
  ok("first gate: it merges, and main has the gate", r.code === 0 && /node gate\.js/.test(a.bareG("show", "main:AGENTS.md")), r.err);

  const b = repo("firstgate-extra", { agents: BARE });
  refused("an extra file", pr(b, "feat/extra", () => { setGate(b); write(b, "extra.txt", "x\n"); lib.g(b.dir, "add", "extra.txt"); }));
  const c = repo("firstgate-rename", { agents: null });
  const moved = pr(c, "feat/rename", () => {
    lib.g(c.dir, "mv", "gate.js", "AGENTS.md");
    fs.appendFileSync(path.join(c.dir, "AGENTS.md"), "\n## Learned\n- gate: `node gate.js`\n");
    lib.g(c.dir, "add", "AGENTS.md");
  });
  ok("first gate: the rename test really is a rename", lib.g(c.dir, "diff", "-M", "--name-status", "main", moved.sha).startsWith("R"));
  refused("a rename into AGENTS.md", moved);
  const d = repo("firstgate-noline", { agents: BARE });
  refused("a head with no gate line", pr(d, "feat/noline", () => setGate(d, BARE + "- note: later\n")));
  const e = repo("firstgate-mode", { agents: BARE });
  refused("a mode change", pr(e, "feat/mode", () => { setGate(e); lib.g(e.dir, "update-index", "--chmod=+x", "AGENTS.md"); }));
  const f = repo("firstgate-link", { agents: BARE });
  refused("a symlink", pr(f, "feat/link", () => {
    const body = path.join(W, "link-body");
    fs.writeFileSync(body, BARE + "- gate: `node gate.js`\n");
    lib.g(f.dir, "update-index", "--cacheinfo", `120000,${lib.g(f.dir, "hash-object", "-w", body)},AGENTS.md`);
  }));
  const u = repo("firstgate-unread", { agents: BARE });
  const nothing = pr(u, "feat/unread", () => setGate(u));
  fs.rmSync(path.join(u.common, "proteus-local", "tracker", "statuses", `${nothing.sha}.json`));
  fs.rmSync(u.claim(nothing.sha));
  const tree = lib.g(u.dir, "rev-parse", `${nothing.sha}^{tree}`), loose = path.join(u.bare, "objects", tree.slice(0, 2), tree.slice(2));
  const missing = fs.existsSync(loose);
  fs.rmSync(loose, { force: true });
  r = u.check(nothing.sha);
  const unread = json(u.gh(["pr", "checks", String(nothing.n), "--json", "state,description"]))[0];
  ok("first gate: a diff that cannot be read fails closed", missing && unread.state === "FAILURE" && !fs.existsSync(RAN) && /AGENTS\.md alone/.test(unread.description), JSON.stringify(unread) + r.err);

  // ---- once main has a gate line the path is closed
  const g = repo("firstgate-closed");
  const normal = pr(g, "feat/own", () => setGate(g, gate("node evil.js")));
  ok("first gate: on a gated main an AGENTS.md-only PR takes the normal path", normal.row.state === "SUCCESS" && /1 gate command\(s\) passed/.test(normal.row.description) && fs.existsSync(RAN), JSON.stringify(normal.row));
  // the two lines sit apart, so the second still merges cleanly
  const LONG = "- a: 1\n- b: 2\n- c: 3\n- d: 4\n", top = "# Agents\n\n## Learned\n";
  const h = repo("firstgate-stale", { agents: top + LONG });
  const one = pr(h, "feat/one", () => setGate(h, `${top}${LONG}- gate: \`node gate.js\`\n`));
  const two = pr(h, "feat/two", () => setGate(h, `${top}- gate: \`node evil.js\`\n${LONG}`));
  ok("first gate: two open PRs can both qualify", one.row.state === "SUCCESS" && two.row.state === "SUCCESS", JSON.stringify([one.row, two.row]));
  ok("first gate: the first merges", h.gh(["pr", "merge", String(one.n), "--merge"]).code === 0);
  ok("first gate: the other's pass reads blocked once main has a gate", h.view(two.n, "mergeStateStatus").mergeStateStatus === "BLOCKED");
  r = h.gh(["pr", "merge", String(two.n), "--merge"]);
  ok("first gate: the other's pass no longer merges", r.code === 1 && /first-gate pass/.test(r.err), r.err);
}

(async () => {
  origins();
  receive();
  commands();
  merges();
  firstGates();
  await parallel();
  await checks();
  scripts();
  lib.summary();
})();
