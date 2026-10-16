// A subagent's shell (#48 part A): node tests/agentshell.test.js (needs git). Both guards refuse a force-push to
// any branch, git aimed at a checkout other than the worker's own worktree, and a shell write to the paths
// lib.AGENT_NEVER guards; the worker's own worktree, a plain push of its branch and writes to owned paths pass.
// Temp repo with a local bare remote; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("agentshell");
const slash = (p) => p.split(path.sep).join("/");

const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, "src"));
fs.writeFileSync(path.join(REPO, "src", "a.js"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE);
g(REPO, "push", "-q", "-u", "origin", "main");
g(REPO, "remote", "set-head", "origin", "main");
g(REPO, "push", "-q", "origin", "main:proteus/r1");
const WT1 = path.join(REPO, ".worktrees", "r1-1"), WT2 = path.join(REPO, ".worktrees", "r1-2");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT1, "main");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/2", WT2, "main");
for (const wt of [WT1, WT2]) lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [wt, "src/**", "teams/backend/**"] });

const LG = path.join(SRC, "proteus-lead-guard.js");
const sub = { agent_id: "a1", agent_type: "proteus-backend-worker" };
const ev = (tool_name, tool_input, extra) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name, tool_input, ...extra });
const lead = (command, extra = sub, env = {}) => lib.run(LG, ev("Bash", { command }, extra), { cwd: REPO, env });
// the binding: a1's first edit is in WT1
const bind = lib.run(LG, ev("Write", { file_path: path.join(WT1, "src", "a.js"), content: "b\n" }, sub), { cwd: REPO });
ok("setup: a1's first edit in its worktree passes and binds it", bind.code === 0 && fs.existsSync(path.join(REPO, ".git", "proteus", "agents", "agent-a1")), bind.err);

const denied = (command, re, extra, env) => { const r = lead(command, extra, env); return r.code === 2 && (!re || re.test(r.err)) ? "" : `${command} => ${r.code} ${r.err}`; };
const allowed = (command, extra, env) => { const r = lead(command, extra, env); return r.code === 0 ? "" : `${command} => ${r.code} ${r.err}`; };
const each = (f, cmds) => cmds.map((c) => f(c)).filter(Boolean);
const cd1 = `cd ${JSON.stringify(slash(WT1))} && `;
let bad;

// 1. force-push, the worker's own branch included
bad = each((c) => denied(c, /never force-push/), [
  cd1 + "git push --force origin proteus-work/r1/1", cd1 + "git push -f origin HEAD:proteus-work/r1/1", cd1 + "git push -uf origin proteus-work/r1/1",
  cd1 + "git push --force-with-lease origin proteus-work/r1/1", cd1 + "git push --force-with-lease=proteus-work/r1/1:abc origin proteus-work/r1/1",
  cd1 + "git push origin +HEAD:proteus-work/r1/1", cd1 + "git push origin +proteus-work/r1/1", cd1 + "git push origin -- +HEAD:proteus-work/r1/1",
  cd1 + "git push --force-if-includes --force-with-lease origin proteus-work/r1/1",
  cd1 + "rtk proxy git push --force origin proteus-work/r1/1", cd1 + "timeout 30 git push -f origin proteus-work/r1/1", cd1 + "env GIT_TRACE=0 git push -f origin x",
  "bash -c " + JSON.stringify(cd1 + "git push -f origin proteus-work/r1/1"),
]);
ok("force: --force, -f in a cluster, --force-with-lease, a +refspec, through wrappers and sh -c, refused", !bad.length, bad.join("\n"));
const force = lead(cd1 + "git push -f origin proteus-work/r1/1");
ok("force: the message says what, why and what instead", /`-f`/.test(force.err) && /own branch included/.test(force.err) && /merge the base in/.test(force.err), force.err);
bad = each(allowed, [cd1 + "git push -u origin proteus-work/r1/1", cd1 + "git push origin HEAD:proteus-work/r1/1", cd1 + "git push -o ci.skip origin proteus-work/r1/1", cd1 + "git fetch -f origin"]);
ok("force: a plain push of the worker's own branch, a push option and fetch -f pass", !bad.length, bad.join("\n"));
ok("force: the lead's own shell is not judged by it", !allowed(cd1 + "git push -f origin proteus-work/r1/1", {}));

// 2. git -C and its relatives
bad = each((c) => denied(c, /not your worktree/), [
  `git -C ${JSON.stringify(slash(WT2))} status`, `git -C ${JSON.stringify(slash(REPO))} log`, "git -C . status", `git -C ${JSON.stringify(slash(WT1))} -C .. status`,
  `git --git-dir=${JSON.stringify(slash(path.join(REPO, ".git")))} log`, `git --work-tree ${JSON.stringify(slash(WT2))} status`,
  `GIT_DIR=${JSON.stringify(slash(path.join(REPO, ".git")))} git log`, `env GIT_WORK_TREE=${JSON.stringify(slash(WT2))} git status`,
  `git -C ${JSON.stringify(slash(W))} status`, cd1 + `git -C ${JSON.stringify(slash(WT2))} commit -qm x`, `rtk git -C ${JSON.stringify(slash(WT2))} diff`,
]);
ok("git -C: another worktree, the main checkout, outside git, --git-dir, --work-tree and GIT_DIR refused", !bad.length, bad.join("\n"));
const minus = lead(`git -C ${JSON.stringify(slash(WT2))} status`);
ok("git -C: the message names the path, the worker's own worktree and the cd form", minus.err.includes(slash(WT2)) && minus.err.includes(`yours is ${slash(WT1)}`) && /cd <your worktree> && /.test(minus.err), minus.err);
bad = each(allowed, [`git -C ${JSON.stringify(slash(WT1))} status`, `git -C ${JSON.stringify(slash(path.join(WT1, "src")))} diff`, cd1 + "git -C . status", cd1 + "git -C src log", cd1 + "git status"]);
ok("git -C: the worker's own bound worktree, a dir in it, and -C . after cd into it pass", !bad.length, bad.join("\n"));
ok("git -C: an unbound agent is refused even its cwd's checkout", !denied(`git -C ${JSON.stringify(slash(WT1))} status`, /not your worktree/, { agent_id: "a9", agent_type: "proteus-verifier" }));
ok("git -C: an unbound agent passes after cd into a prepared worktree", !allowed(cd1 + "git -C . status", { agent_id: "a9", agent_type: "proteus-verifier" }));
ok("git -C: the lead's own shell is not judged by it", !allowed(`git -C ${JSON.stringify(slash(WT2))} status`, {}));

// 3. shell writes to the always-refused paths
const write = (prog) => new RegExp("`" + prog.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^`]*` writes [^,]+, which holds Proteus's hooks");
bad = each((c) => denied(c, /which holds Proteus's hooks, gates, git internals or CLI settings/), [
  "sed -i s/Read/Agent/ .claude/agents/proteus-verifier.md", "echo x > .claude/proteus-owned", // the issue's repro, from the lead's checkout
  cd1 + "sed -i s/Read/Agent/ .claude/agents/proteus-verifier.md", cd1 + "sed -i.bak -e s/a/b/ .claude/settings.json", cd1 + "sed --in-place s/a/b/ .claude/settings.local.json",
  cd1 + "sed -Ei s/a/b/ .codex/hooks/proteus-lib.js", cd1 + "perl -pi -e s/a/b/ .claude/hooks/proteus-worker-guard.js", cd1 + "perl -i.orig -pe s/a/b/ .agents/skills/x/SKILL.md",
  cd1 + "ruby -i -pe 'gsub(/a/, %q(b))' .claude/skills/x/SKILL.md",
  cd1 + "echo x > .claude/settings.json", cd1 + "echo x >> .claude/settings.json", cd1 + "echo x >| .claude/x", cd1 + "echo x 2> .claude/x", cd1 + "echo x &> .claude/x",
  cd1 + "echo x &>> .claude/x", cd1 + "echo x>.claude/x", cd1 + "echo x >&.claude/x", cd1 + "cat <<EOF > .claude/x\nbody\nEOF",
  cd1 + "echo x | tee .claude/settings.json", cd1 + "echo x | tee -a src/log .github/workflows/ci.yml",
  cd1 + "cp src/a.js .claude/hooks/proteus-lib.js", cd1 + "cp src/a.js src/b.js .claude/hooks/", cd1 + "cp -t .claude/hooks src/a.js", cd1 + "cp --target-directory=.git/hooks src/a.js",
  cd1 + "mv src/a.js .github/actions/x/action.yml", cd1 + "mv .claude/proteus-owned src/x", cd1 + "ln -sf ../src/a.js .git/hooks/pre-commit", cd1 + "install -m 755 src/a.js .git/hooks/pre-push",
  cd1 + "dd if=src/a.js of=lefthook.yml", cd1 + "truncate -s 0 .lefthook.yml", cd1 + "truncate -s0 .config/lefthook.yml", cd1 + "rm -f .claude/proteus-owned",
  cd1 + "touch .claude/hooks/x.js", cd1 + "cp src/a.js teams/templates/hooks/commit-msg.js",
  // spelled to get around a string match: case, a trailing dot, a Windows separator, an 8.3 alias, .. out of src
  cd1 + "echo x > .CLAUDE/Settings.JSON", cd1 + "echo x > .claude./settings.json", cd1 + "printf x > '.claude\\agents\\x.md'", cd1 + "echo x > CLAUDE~1/x",
  cd1 + "echo x > src/../.claude/x", `echo x > ${JSON.stringify(slash(path.join(WT1, ".claude", "x")))}`,
  // through wrappers, a nested shell, eval, and a cd chain
  cd1 + "timeout 5 sed -i s/a/b/ .claude/settings.json", cd1 + "env X=1 tee .claude/x", cd1 + "sudo -u x cp src/a.js .git/config",
  "bash -c " + JSON.stringify(cd1 + "sed -i s/a/b/ .claude/settings.json"), cd1 + "sh -c 'echo x > .claude/x'", cd1 + "eval 'echo x > .claude/x'",
  cd1 + "cd .claude && sed -i s/a/b/ settings.json", `cd ${JSON.stringify(slash(REPO))} && cd .git && echo x > config`,
  // the user's own CLI settings
  "echo x > ~/.claude/settings.json", "cp x $HOME/.codex/config.toml",
]);
ok("write: in-place editors, redirects, tee, cp/mv/ln/install, dd, truncate to the guarded paths refused", !bad.length, bad.join("\n"));
const sedr = lead(cd1 + "sed -i s/a/b/ .claude/agents/proteus-verifier.md");
ok("write: the message names the program and the file, and says what to do instead",
  write("sed").test(sedr.err) && /\.claude\/agents\/proteus-verifier\.md/.test(sedr.err) && !/s\/a\/b/.test(sedr.err) && /Edit or Write/.test(sedr.err) && /NEEDS \.claude\/agents\/proteus-verifier\.md: <why>/.test(sedr.err), sedr.err);
const redr = lead(cd1 + "echo x > .claude/proteus-owned");
ok("write: a redirect's message names the redirect", write("> .claude/proteus-owned").test(redr.err), redr.err);

// a link in an owned path that leads into .claude
let linked = true;
try { fs.symlinkSync(path.join(WT1, ".claude"), path.join(WT1, "src", "cfg"), "dir"); } catch { linked = false; }
if (linked) ok("write: through a link into .claude refused", !denied(cd1 + "echo x > src/cfg/settings.json", /\.claude\/settings\.json/));

const SCR = path.join(REPO, ".git", "proteus", "scratch", "r1-1");
bad = each(allowed, [
  cd1 + "echo x > src/a.js", cd1 + "echo x >> src/new.js", cd1 + "sed -i s/a/b/ src/a.js", cd1 + "perl -pi -e s/a/b/ src/a.js", cd1 + "echo x | tee src/t.txt",
  cd1 + "cp src/a.js src/b.js", cd1 + "mv src/b.js src/c.js", cd1 + "echo x > teams/backend/notes.md", cd1 + "dd if=src/a.js of=src/d.js",
  // reads of the guarded paths, and descriptor copies
  cd1 + "sed -n 1p .claude/settings.json", cd1 + "cat .claude/proteus-owned > src/owned.txt", cd1 + "cp .claude/proteus-owned src/x", cd1 + "grep -r x .claude 2>&1 >/dev/null",
  cd1 + "git log > src/log.txt 2>&1", cd1 + "echo '> .claude/x'", cd1 + "echo x # > .claude/x", cd1 + "perl -Mstrict -e 1 .claude/settings.json",
  // scratch under .git is the agents' temp space
  `mkdir -p ${JSON.stringify(slash(SCR))} && echo x > ${JSON.stringify(slash(path.join(SCR, "log.txt")))}`,
]);
ok("write: owned paths, reads of guarded paths, descriptor copies, quoted or commented text and scratch pass", !bad.length, bad.join("\n"));
ok("write: the lead's own shell is not judged by it", !allowed("echo x > .claude/x", {}));

// the worker guard: a session opened inside the worktree, no agent id; the same rules through lib.workerDenial
const WG = path.join(WT1, ".claude", "hooks", "proteus-worker-guard.js");
const wg = (command) => lib.run(WG, { hook_event_name: "PreToolUse", session_id: "s2", cwd: WT1, tool_name: "Bash", tool_input: { command } }, { cwd: WT1 });
ok("worker guard: force-push, git -C elsewhere and a sed -i of .claude refused",
  wg("git push -f origin proteus-work/r1/1").code === 2 && wg(`git -C ${JSON.stringify(slash(WT2))} status`).code === 2 && wg("sed -i s/a/b/ .claude/agents/x.md").code === 2);
ok("worker guard: its own worktree, a plain push and an owned write pass",
  wg("git -C . status").code === 0 && wg("git push -u origin proteus-work/r1/1").code === 0 && wg("echo x > src/a.js").code === 0);

// Codex routes Bash through the same lead guard and lib.workerDenial
const cx = { PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(lib.HOME, ".codex") };
const cxSub = { agent_id: "c1", agent_type: "proteus-backend-worker" };
ok("codex: a subagent's force-push, git -C and sed -i of .codex refused",
  !denied(cd1 + "git push -f origin proteus-work/r1/1", /never force-push/, cxSub, cx) && !denied(`git -C ${JSON.stringify(slash(WT2))} status`, /not your worktree/, cxSub, cx) &&
  !denied(cd1 + "sed -i s/a/b/ .codex/hooks/proteus-lib.js", /\.codex\/hooks\/proteus-lib\.js/, cxSub, cx));
ok("codex: a subagent's plain push and owned write pass", !allowed(cd1 + "git push -u origin proteus-work/r1/1", cxSub, cx) && !allowed(cd1 + "echo x > src/a.js", cxSub, cx));

// the parser: redirect targets leave the words
const hl = require(path.join(SRC, "proteus-lib.js"));
const sc = hl.shellCommands("echo a>b 2>&1 &> c; x >&d >> e 1>&2; > f");
ok("shellCommands: redirect targets on .redirects, descriptors dropped, words unchanged",
  JSON.stringify(sc) === JSON.stringify([["echo", "a"], ["x"], []]) && JSON.stringify(sc.map((w) => w.redirects)) === JSON.stringify([["b", "c"], ["d", "e"], ["f"]]), JSON.stringify(sc.map((w) => [w, w.redirects])));
ok("lead-edits: the shared always-refused list still covers teams/ for the lead only",
  /no lead-edits line/.test(hl.leadEditDenial(REPO, path.join(REPO, "teams", "x.md"), "teams/x.md")) && hl.AGENT_NEVER.every((re) => !re.test("teams/backend/x.md")));

lib.summary();
