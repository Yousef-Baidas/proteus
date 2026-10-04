// Branch guard tests: node tests/guard.test.js (needs git). The lead and worker guards refuse --admin merges,
// pushes to the default branch or an existing run branch, deleting either, and changes to protection or rulesets.
// Temp repo with a local bare remote; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("guard");

// remote whose default branch is trunk: proteus/r1 pushed, proteus/r2 and the pre-rename worker proteus/r1-4 local only
const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "trunk", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "trunk", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE);
g(REPO, "push", "-q", "-u", "origin", "trunk");
g(REPO, "remote", "set-head", "origin", "trunk");
g(REPO, "checkout", "-q", "-b", "proteus/r1"); g(REPO, "push", "-q", "-u", "origin", "proteus/r1");
g(REPO, "branch", "proteus/r1-4"); g(REPO, "branch", "proteus/r2");

const LG = path.join(SRC, "proteus-lead-guard.js");
const sub = { agent_id: "a1", agent_type: "proteus-worker" };
const shell = (command, extra = {}, env = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Bash", tool_input: { command }, ...extra }, { cwd: REPO, env });
const denied = (command, re, extra) => { const r = shell(command, extra); return r.code === 2 && (!re || re.test(r.err)); };
const allowed = (command, extra) => shell(command, extra).code === 0;
const all = (f, cmds) => cmds.filter((c) => !f(c));

// pushes
ok("push: to the default branch, main, master or by HEAD:refs/heads/main denied",
  !all((c) => denied(c, /never push to/), ["git push origin trunk", "git push origin HEAD:main", "git push origin HEAD:refs/heads/master", "git -C . push origin +HEAD:trunk"]).length);
ok("push: updating the existing run branch denied, bare, forced or by refspec",
  !all((c) => denied(c, /changes only by a PR/), ["git push", "git push -f", "git push origin HEAD", "git push --force-with-lease origin proteus/r1", "git push origin +HEAD:proteus/r1"]).length);
ok("push: creating a run branch, pushing a worker or evidence branch allowed",
  !all(allowed, ["git push -u origin proteus/r2", "git push origin proteus/r1-4", "git push -u origin HEAD:proteus-work/r1/5", "git push origin HEAD:refs/heads/proteus-evidence/r1", "git push origin v1.0"]).length);
ok("push: deleting main or a run branch denied, an evidence branch allowed",
  denied("git push origin --delete proteus/r1", /never delete/) && denied("git push origin :trunk", /never delete/) && denied("git push -d origin proteus/r2", /never delete/) &&
  allowed("git push origin --delete proteus-evidence/r1") && allowed("git push origin :proteus-work/r1/5"));
ok("push: a run branch to a remote this repo does not name denied", denied("git push https://example.invalid/x.git HEAD:proteus/r9", /changes only by a PR/));
ok("push: --all, --branches, --mirror and --prune denied", !all((c) => denied(c, /push one branch by name/), ["git push --all", "git push origin --branches", "git push --mirror", "git push --prune origin proteus-work/r1/5"]).length);
ok("push: through rtk, env, an assignment or after cd denied",
  !all((c) => denied(c), ["rtk git push origin trunk", "env GIT_TRACE=0 git push origin trunk", "X=1 git push origin trunk", "cd . && git push origin trunk", "git status; git push origin trunk"]).length);
ok("push: the words only in text, a heredoc body or a comment allowed",
  !all(allowed, ['echo "git push origin trunk"', "gh issue create --title x --body-file - <<'EOF'\ngit push origin trunk\ngh pr merge 3 --admin\nEOF", "git status # git push origin trunk"]).length);

// merges and protection
ok("gh: pr merge --admin denied, a plain merge allowed", denied("gh pr merge 4 --merge --admin", /--admin/) && allowed("gh pr merge 4 --merge --delete-branch"));
ok("gh: deleting branch protection denied in every method spelling",
  !all((c) => denied(c, /never lift or rewrite/), ['gh api -X DELETE "repos/o/r/branches/proteus%2Fr1/protection"', "gh api --method=DELETE repos/o/r/branches/trunk/protection", "gh api -XDELETE repos/o/r/branches/proteus%2Fr1/protection/enforce_admins", "gh api repos/o/r/branches/proteus%2Fr1/protection -X delete"]).length);
ok("gh: the per-run protection PUT allowed, any other protection write denied",
  allowed('gh api -X PUT "repos/{owner}/{repo}/branches/proteus%2Fr1/protection" --input - <<\'EOF\'\n{"enforce_admins":true}\nEOF') &&
  denied("gh api -X PUT repos/o/r/branches/trunk/protection --input x.json") && denied("gh api -X POST repos/o/r/branches/proteus%2Fr1/protection/required_signatures"));
ok("gh: writing a ruleset denied, reading one allowed",
  denied("gh api repos/o/r/rulesets -f name=x") && denied("gh api -X PUT repos/o/r/rulesets/7 --input -") && denied("gh api --method DELETE orgs/o/rulesets/7") &&
  allowed("gh api repos/o/r/rulesets --jq '.[].name'") && allowed('gh api "repos/o/r/rules/branches/proteus%2Fr1" --jq "[.[].type]"'));
ok("gh: a graphql mutation on protection or a ruleset denied, a query allowed",
  denied("gh api graphql -f query='mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: \"x\"}) { clientMutationId } }'") &&
  allowed("gh api graphql -f query='{ viewer { login } }'"));

// who it binds
ok("subagents are refused the same", denied("gh pr merge 4 --admin", /--admin/, sub) && denied("git push origin trunk", /never push/, sub) && allowed("git push -u origin HEAD:proteus-work/r1/6", sub));
ok("PROTEUS=0 passes", shell("git push origin trunk", {}, { PROTEUS: "0" }).code === 0);
const hl = require(path.join(SRC, "proteus-lib.js"));
ok("workerDenial (the worker guard) refuses them too", /--admin/.test(hl.workerDenial({ tool: "shell", command: "gh pr merge 1 --admin", cwd: REPO }) || ""));
// scratch (#27): a subagent writes under proteus-scratch.js --path while a run is open; nothing else in the main checkout
const write = (file) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Write", tool_input: { file_path: file, content: "x" }, ...sub }, { cwd: REPO });
const SCR = path.join(REPO, ".git", "proteus", "scratch");
ok("scratch: a subagent Write under <git-common-dir>/proteus/scratch/<key>/ passes while a run is open",
  write(path.join(SCR, "r1-4", "log.txt")).code === 0 && write(path.join(SCR, "r1-4", "mut", "a.js")).code === 0);
const src = write(path.join(REPO, "src", "a.js"));
ok("scratch: src/a.js in the main checkout is still refused", src.code === 2 && /src\/a\.js is in the main checkout while a run is open/.test(src.err), src.err);
ok("scratch: a .. out of scratch, the scratch root itself and a sibling of it are refused",
  write([SCR, "r1-4", "..", "..", "..", "..", "src", "a.js"].join(path.sep)).code === 2 && write(SCR).code === 2 &&
  write(path.join(REPO, ".git", "proteus", "scratch-ledger.jsonl")).code === 2 && write(path.join(REPO, ".git", "proteus", "scratchy", "f")).code === 2);
ok("shellCommands splits, unquotes and skips heredocs",
  JSON.stringify(hl.shellCommands("a \"b c\" d\\ e; f|g && h # x\ncat <<EOF\ngit push\nEOF\nX=1 git push")) === JSON.stringify([["a", "b c", "d e"], ["f"], ["g"], ["h"], ["cat"], ["X=1", "git", "push"]]));

lib.summary();
