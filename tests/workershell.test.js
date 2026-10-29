// A worker's shell, #48: node tests/workershell.test.js (needs git). lib.workerDenial confines a worker's shell
// writes to its owned paths and scratch dir, judges inline interpreter code, lets the lead allow one force-push
// (proteus-worktree.js <wt> --allow force-push), and refuses a command it cannot judge within its deadline. Both
// routes run each case: the lead guard for an in-process worker (agent_id/agent_type set) and the worktree's own
// worker guard. A verifier's shell keeps the old rules. Temp repo with a local bare remote; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const hooks = require(path.join(SRC, "proteus-lib.js"));
const harness = require(path.join(SRC, "proteus-harness.js"));
const { ok, g } = lib;
const W = lib.workdir("workershell");
const slash = (p) => p.split(path.sep).join("/");
const q = (p) => JSON.stringify(slash(p));

const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
for (const [f, body] of [["src/a.js", "a\n"], ["README.md", "r\n"], ["owned.js", "o\n"]]) {
  fs.mkdirSync(path.dirname(path.join(REPO, f)), { recursive: true });
  fs.writeFileSync(path.join(REPO, f), body);
}
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE);
g(REPO, "push", "-q", "-u", "origin", "main");
const WT1 = path.join(REPO, ".worktrees", "r1-1"), WT2 = path.join(REPO, ".worktrees", "r1-2");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT1, "main");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/2", WT2, "main");
const prepare = (...a) => lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: a });
prepare(WT1, "src/**", "owned.js");
prepare(WT2, "**"); // owns everything: the always-refused paths stay refused
const SCR = lib.run(path.join(SRC, "proteus-scratch.js"), "", { cwd: WT1, args: ["--path", "k"] }).out.trim();
ok("setup: a scratch dir", !!SCR && fs.existsSync(SCR), SCR);

const LG = path.join(SRC, "proteus-lead-guard.js");
const w1 = { agent_id: "a1", agent_type: "proteus-backend-worker" }, w2 = { agent_id: "a2", agent_type: "proteus-worker" };
const ver = { agent_id: "v1", agent_type: "proteus-verifier" };
const ev = (tool_name, tool_input, extra) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name, tool_input, ...extra });
for (const [wt, who] of [[WT1, w1], [WT2, w2]]) {
  const b = lib.run(LG, ev("Write", { file_path: path.join(wt, "src", "a.js"), content: "b\n" }, who), { cwd: REPO });
  ok(`setup: ${who.agent_id}'s first edit binds it to its worktree`, b.code === 0, b.err);
}

// the two routes; cd first on the lead route, as an in-process worker's shell starts in the lead's checkout
const cdTo = (wt) => `cd ${q(wt)} && `;
const viaLead = (c, { who = w1, wt = WT1, env = {}, guard = LG } = {}) => lib.run(guard, ev("Bash", { command: cdTo(wt) + c }, who), { cwd: REPO, env });
const viaWorker = (c, { wt = WT1, env = {} } = {}) => lib.run(path.join(wt, ".claude", "hooks", "proteus-worker-guard.js"), { hook_event_name: "PreToolUse", session_id: "s2", cwd: wt, tool_name: "Bash", tool_input: { command: c } }, { cwd: wt, env });
const both = (c, o) => [viaLead(c, o), viaWorker(c, o)];
const each = (fn, list) => list.map(fn).filter(Boolean);
const refused = (re, o) => (c) => both(c, o).map((r, i) => (r.code === 2 && (!re || re.test(r.err)) ? "" : `${["lead", "worker"][i]}: ${JSON.stringify(c)} => ${r.code} ${r.err}`)).filter(Boolean).join("\n");
const passes = (o) => (c) => both(c, o).map((r, i) => (r.code === 0 ? "" : `${["lead", "worker"][i]}: ${JSON.stringify(c)} => ${r.code} ${r.err}`)).filter(Boolean).join("\n");
const CONFINE = /A worker's shell writes only its owned paths and its scratch dir/, GUARDED = /holds Proteus's hooks, gates, git internals or CLI settings/;
const RUNTIME = /a path the shell builds when it runs/, INLINE = /Inline code may name only your worktree/, FORCE = /agents never force-push/;

// #48's Check section and comment: the force-push variants, git -C, the redirect cases, tee, sed -i, the owned list
const ISSUE = {
  force: ["git push --force origin proteus-work/r1/1", "git push -f origin proteus-work/r1/1", "git push --force-with-lease origin proteus-work/r1/1", "git push origin +proteus-work/r1/1", "git push --force-if-includes origin proteus-work/r1/1"],
  gitDir: ["git -C /x status", `git -C ${q(WT2)} status`, "git --git-dir=/x/.git log", `git --work-tree=${q(REPO)} status`],
  writes: ["cat > /abs/outside/f <<EOF\nx\nEOF", "echo x > ../r1-2/src/a.js", "echo x | tee /tmp/null", "echo x >> README.md", "sed -i s/a/b/ README.md", "cp src/a.js /tmp/x"],
  guarded: ["sed -i s/Read/Agent/ .claude/agents/proteus-verifier.md", "echo x > .claude/proteus-owned"],
};
let bad = each(refused(FORCE), ISSUE.force), r;
ok("issue: every force-push form refused on both routes", !bad.length, bad.join("\n"));
bad = each(refused(/proteus: `git (?:-C|--git-dir|--work-tree)/), ISSUE.gitDir);
ok("issue: git -C, --git-dir and --work-tree outside the worktree refused on both routes", !bad.length, bad.join("\n"));
bad = each(passes(), ["git -C src status", `git -C ${q(WT1)} log -1`, "git status", "git push origin proteus-work/r1/1"]);
ok("issue: git -C inside the worktree, and a plain push of the own branch, pass", !bad.length, bad.join("\n"));
bad = each(refused(CONFINE), ISSUE.writes);
ok("issue: redirects, tee, sed -i and cp outside the owned paths and scratch refused on both routes", !bad.length, bad.join("\n"));
bad = each(refused(GUARDED), ISSUE.guarded);
ok("issue: sed -i on .claude/agents and a write to the owned list refused on both routes", !bad.length, bad.join("\n"));

// G4: every write construct, outside the owned paths
bad = each(refused(CONFINE), [
  "echo x > README.md", "echo x >| README.md", "echo x &> README.md", "echo x 2> README.md", "echo x 1>>README.md", "echo x>README.md",
  "echo x | tee -a README.md", "echo x | tee src/ok.js README.md", "sed --in-place s/a/b/ README.md", "sed -i.bak s/a/b/ README.md",
  "perl -i -pe s/a/b/ README.md", "ruby -i -pe 1 README.md", "mv src/a.js README.md", "install -m644 src/a.js /tmp/x", "ln -s src/a.js /tmp/x",
  "rsync src/a.js /tmp/x", "dd if=src/a.js of=/tmp/x", "truncate -s0 README.md", "touch README.md", "rm README.md", "rm -rf ../r1-2/src",
  "cp src/a.js ../../src/a.js", "ls; echo x > README.md", "(cd src && echo x > ../README.md)", "true && cat src/a.js > notes.txt",
]);
ok("writes: redirects, tee, in-place editors and cp/mv/install/ln/rsync/dd/truncate/touch/rm outside refused", !bad.length, bad.join("\n"));
bad = each(passes(), [
  "echo x > owned.js", "echo x >> src/a.js", "echo x > src/new/deep.js", `echo x > ${q(SCR)}/f`, `cp README.md ${q(SCR)}/r`, `sed -i s/a/b/ src/a.js`,
  "ls > /dev/null 2>&1", "echo x > /dev/stderr", "echo x >/dev/stdout", "echo x > NUL", "npm test 2>&1 | tee /dev/null", "cp src/a.js src/b.js",
  "rm -rf src/tmp", "cat README.md", "grep -r foo .", "git diff > /dev/null", "ls -la", "echo a=b > src/c.txt",
]);
ok("writes: owned paths, scratch, devices and commands with no write pass", !bad.length, bad.join("\n"));

// G5: refused whatever the owned list says (WT2 owns **)
const o2 = { who: w2, wt: WT2 };
bad = each(refused(GUARDED, o2), [
  "echo x > .claude/agents/x.md", "echo {} > .claude/settings.json", "echo {} > .claude/settings.local.json", "echo x > .claude/hooks/proteus-lib.js",
  "echo '**' >> .claude/proteus-owned", "echo x > .git/hooks/pre-commit", "sed -i s/a/b/ .claude/agents/x.md", "cp src/a.js .claude/hooks/x.js",
]);
ok("guarded: .claude/agents, settings, hooks, the owned list and .git refused though the worker owns **", !bad.length, bad.join("\n"));
bad = each(passes(o2), ["echo x > README.md", "echo x > any/where.txt", "git commit -qm x --allow-empty"]);
ok("guarded: ...while the rest of an owned ** passes, and git writes .git itself", !bad.length, bad.join("\n"));
const CFG = path.join(W, "claude-config"), CDX = path.join(W, "codex-home");
for (const d of [CFG, CDX]) fs.mkdirSync(d, { recursive: true });
bad = each(refused(GUARDED, { ...o2, env: { CLAUDE_CONFIG_DIR: CFG, CODEX_HOME: CDX } }), [`echo x > ${q(path.join(CFG, "settings.json"))}`, `echo x > ${q(path.join(CDX, "config.toml"))}`]);
ok("guarded: $CLAUDE_CONFIG_DIR and $CODEX_HOME are the same anchors proteus-confine.js uses", !bad.length, bad.join("\n"));

// escapes, quoting and heredocs
bad = each(refused(GUARDED, o2), [
  "echo x > .clau\\de/agents/x.md", "echo x > \".claude\"/agents/x.md", "echo x > '.claude/agents/x.md'", "echo x > .claude/./agents/../agents/x.md",
  "echo x > src/../.claude/agents/x.md", "dd if=/dev/zero of=.claude/agents/x.md", "cat <<'EOF' > .claude/agents/x.md\nx\nEOF",
  "bash -c 'echo x > .claude/agents/x.md'", "sh -c \"sh -c 'echo x > .claude/hooks/x'\"", "eval 'echo x > .claude/agents/x.md'",
]);
ok("escapes: backslashes, quotes, dot segments, dd of= and nested shells reach the guarded path", !bad.length, bad.join("\n"));
bad = each(refused(CONFINE), [
  "echo x > \"READ\"ME.md", "echo x > READ\\ME.md", "cat <<EOF > README.md\nx\nEOF", "cat <<-EOF >README.md\n\tx\n\tEOF",
  "bash <<EOF\necho x > README.md\nEOF", "sh <<< 'echo x > README.md'", "echo 'echo x > README.md' | sh", "printf 'rm README.md' | bash -s",
]);
ok("heredocs: a heredoc's target, and a script fed to a shell on stdin, are judged", !bad.length, bad.join("\n"));
bad = each(passes(), ["cat <<EOF\n> README.md is only text here\nEOF", "cat <<'EOF' > src/gen.js\nrm README.md; echo x > /etc/passwd\nEOF", "git commit -qm \"> README.md\" --allow-empty"]);
ok("heredocs: a heredoc body or a quoted > fed to a non-shell is text, not a write", !bad.length, bad.join("\n"));
bad = each(refused(RUNTIME), ["F=README.md; echo x > \"$F\"", "echo x > $(echo README.md)", "echo x > `pwd`/README.md", "echo x | tee \"$TARGET\"", "cp src/a.js ${OUT}"]);
ok("runtime: a target the shell builds ($VAR, $( ), backticks) is refused as unjudgeable", !bad.length, bad.join("\n"));
bad = each(refused(/nesting|too complex/), ["sh -c \"sh -c 'sh -c \\\"sh -c ls\\\"'\""]);
ok("runtime: shells nested past 3 levels are too complex to judge", !bad.length, bad.join("\n"));

// G6: inline code
bad = each(refused(GUARDED, o2), [
  "python3 -c \"open('.claude/settings.json','w').write('x')\"", "python -c \"open('.claude/agents/x.md','w')\"", "node -e \"require('fs').writeFileSync('.claude/hooks/x','')\"",
  "node -p \"require('fs').rmSync('.git/hooks', {recursive: true})\"", "node --eval \"fs.writeFileSync(`.claude/proteus-owned`, '**')\"",
  "perl -e 'open(F, \">.claude/agents/x.md\")'", "ruby -e \"File.write('.claude/settings.json', '')\"", "python3 - <<EOF\nopen('.claude/agents/x.md','w')\nEOF",
  "echo \"open('.claude/agents/x.md','w')\" | python3",
]);
ok("inline: python/node/perl/ruby code naming a guarded path refused, on -c/-e/-p/--eval and on stdin", !bad.length, bad.join("\n"));
bad = each(refused(INLINE), ["node -e \"require('fs').writeFileSync('/tmp/x','y')\"", "python3 -c \"open('../r1-2/src/a.js','w')\"", "node -e \"fs.rmSync('" + slash(REPO) + "/README.md')\""]);
ok("inline: code naming a path outside the worktree and scratch refused", !bad.length, bad.join("\n"));
bad = each(passes(), [
  "node -e 'console.log(1)'", "python3 -c \"open('src/a.js','w').write('x')\"", "node -e \"require('fs').writeFileSync('owned.js','x')\"",
  `node -e "require('fs').writeFileSync('${slash(SCR)}/o','x')"`, "node -e \"/a\\/b/.test(process.argv[1])\" x", "python3 -c \"print('see https://example.com/x y')\"",
  "node -e \"console.log(require('./package.json').name)\"", "node scripts/build.js", "python3 tools/gen.py", "node -e \"process.stdout.write('\\n')\"",
]);
ok("inline: code on worktree paths, regex literals, URLs and scripts on disk pass", !bad.length, bad.join("\n"));

// #151 review (F1-F11): the probes that got through, and what must still pass
const PLAIN = path.join(W, "plain");
fs.mkdirSync(PLAIN, { recursive: true });
const w3 = { agent_id: "a3", agent_type: "proteus-frontend-worker" };
const NO_TREE = /no worktree known for this worker; the lead spawns workers into one/;
// F1: an in-process worker with no worktree known (no binding, the lead's checkout as cwd). The worker guard runs
// only in a prepared worktree, its project dir, so from any cwd it judges against that one
const noTreeLead = (c, guard = LG) => lib.run(guard, ev("Bash", { command: c }, w3), { cwd: REPO });
const fromPlain = (c) => lib.run(path.join(WT1, ".claude", "hooks", "proteus-worker-guard.js"), { hook_event_name: "PreToolUse", session_id: "s3", cwd: PLAIN, tool_name: "Bash", tool_input: { command: c } }, { cwd: PLAIN, env: { CLAUDE_PROJECT_DIR: WT1 } });
bad = ["echo x > README.md", "touch src/a.js", "sed -i s/a/b/ README.md", "python3 -c \"print(1)\"", "cp README.md /tmp/x", "awk '{print}' README.md", "bash -c 'echo x > src/a.js'"].flatMap((c) => {
  const x = noTreeLead(c);
  return x.code === 2 && NO_TREE.test(x.err) ? [] : [`${c} => ${x.code} ${x.err}`];
});
ok("F1: a worker with no worktree known has every write refused", !bad.length, bad.join("\n"));
bad = ["ls -la", "git status", "ls > /dev/null 2>&1", "cat README.md"].flatMap((c) => { const x = noTreeLead(c); return x.code === 0 ? [] : [`${c} => ${x.code} ${x.err}`]; });
ok("F1: ...while reads and the console devices pass", !bad.length, bad.join("\n"));
r = fromPlain("echo x > README.md");
ok("F1: the worker guard, from a cwd outside its worktree, confines to its project dir's worktree", r.code === 2 && CONFINE.test(r.err), r.err);
r = fromPlain(`echo x > ${q(path.join(WT1, "src", "a.js"))}`);
ok("F1: ...and lets its owned paths through", r.code === 0, r.err);
// F2: -c ending a flag cluster, other shells, and source / . reading stdin
bad = each(refused(CONFINE), [
  "bash -lc 'echo x > README.md'", "sh -ec 'rm README.md'", "bash -xc 'touch README.md'", "zsh -c 'echo x > README.md'", "dash -c 'rm README.md'",
  "bash -o pipefail -c 'rm README.md'", "source /dev/stdin <<< 'rm README.md'", ". /dev/stdin <<< 'echo x > README.md'", "echo 'rm README.md' | source /dev/stdin",
  "source <(echo 'rm README.md')", "echo 'rm README.md' | . /dev/fd/0", "echo 'touch README.md' | source",
]);
ok("F2: sh -lc/-ec/-xc, zsh and dash -c, and source/. of stdin or a here-string are judged", !bad.length, bad.join("\n"));
bad = each(passes(), ["bash -lc 'ls'", "source src/env.sh", ". ./src/env.sh", "bash -ec 'echo x > src/a.js'", "bash src/run.sh"]);
ok("F2: a script in the worktree, sourced or run, and a -c that writes owned paths pass", !bad.length, bad.join("\n"));
// F3: busybox applets
bad = each(refused(CONFINE), ["busybox rm README.md", "busybox sh -c 'echo x > README.md'", "busybox sed -i s/a/b/ README.md", "/bin/busybox touch README.md"]);
ok("F3: busybox <applet> is judged as the applet, and busybox sh -c recurses", !bad.length, bad.join("\n"));
ok("F3: ...while busybox ls passes", passes()("busybox ls") === "", passes()("busybox ls"));
// F4: xargs feeding a writer
const XARGS = /writes the paths xargs reads at run time/;
bad = each(refused(XARGS), ["echo README.md | xargs rm", "ls | xargs -I{} cp {} src/", "git ls-files | xargs sed -i s/a/b/", "echo x | xargs touch", "find . -name '*.js' | xargs -0 truncate -s0", "ls | xargs -n1 ln -s"]);
ok("F4: xargs followed by a writer is refused as unjudgeable", !bad.length, bad.join("\n"));
bad = each(passes(), ["ls | xargs echo", "git ls-files | xargs grep foo", "ls | xargs wc -l", "find src -name '*.js' | xargs cat"]);
ok("F4: ...while xargs followed by a reader passes", !bad.length, bad.join("\n"));
// F5: attached git -C
bad = each(refused(/proteus: `git (?:-C|--git-dir|--work-tree)/), ["git -C/x status", `git -C${q(WT2)} status`, "git -C.. status", `git --git-dir=${q(path.join(REPO, ".git"))} log`, `git --work-tree=${q(WT2)} status`]);
ok("F5: git -C<path>, -C\"<path>\", --git-dir= and --work-tree= outside the worktree refused", !bad.length, bad.join("\n"));
ok("F5: ...while git -Csrc passes", passes()("git -Csrc status") === "", passes()("git -Csrc status"));
// F6: sort -o, curl -o, wget -O, tar -x, unzip, awk
bad = each(refused(CONFINE), [
  "sort -o README.md src/a.js", "sort src/a.js -oREADME.md", "sort --output=README.md src/a.js", "curl -o README.md http://127.0.0.1:9/x", "curl -sSLo /tmp/x http://127.0.0.1:9/x",
  "curl --output=/tmp/x http://127.0.0.1:9/x", "wget -O README.md http://127.0.0.1:9/x", "wget --output-document=/tmp/x http://127.0.0.1:9/x", "wget -qO/tmp/x http://127.0.0.1:9/x",
  "tar -xf x.tar", "tar -xf x.tar -C /tmp", "tar --extract --file=x.tar --directory=/tmp", "tar xzf x.tgz", "unzip x.zip -d /tmp", "unzip -o x.zip", "gawk -i inplace '{print}' README.md",
]);
ok("F6: sort -o, curl -o, wget -O, tar -x (its -C or the cwd), unzip (its -d or the cwd) and gawk -i inplace outside refused", !bad.length, bad.join("\n"));
bad = each(refused(INLINE), ["awk '{print > \"/tmp/x\"}' src/a.js", "gawk 'BEGIN{print 1 > \"../r1-2/src/a.js\"}'", "awk -e '{print > \"/tmp/y\"}' src/a.js"]);
ok("F6: awk program text naming a path outside is refused like inline code", !bad.length, bad.join("\n"));
ok("F6: ...and naming a guarded path", refused(GUARDED, o2)("awk 'BEGIN{print 1 > \".claude/settings.json\"}'") === "", refused(GUARDED, o2)("awk 'BEGIN{print 1 > \".claude/settings.json\"}'"));
bad = each(passes(), [
  "sort -o src/s.txt src/a.js", "curl -o src/x http://127.0.0.1:9/x", "curl -o - http://127.0.0.1:9/x", "wget -O- http://127.0.0.1:9/x", "wget -qO - http://127.0.0.1:9/x",
  "tar -xf x.tar -C src", "tar -tf x.tar", "tar -cf src/x.tar src", "unzip x.zip -d src/z", "unzip -l x.zip", "awk '{print $1}' src/a.js", "awk -F, '{print $2}' src/a.js",
  "awk -f src/prog.awk src/a.js", "awk '{print > \"src/out.txt\"}' src/a.js",
]);
ok("F6: the same tools on owned paths, stdout or a listing pass", !bad.length, bad.join("\n"));
// F7: a link from the worktree to a path outside the owned paths and scratch
const LINK = /a write through the link lands there/;
bad = each(refused(LINK), ["ln -s /etc/passwd src/p", "ln -s ../README.md src/r", "ln -sf ../../r1-2/src src/x", "ln README.md src/h", "ln -s ../owned.js ../README.md src/", "ln -st src /etc/hosts"]);
ok("F7: ln and ln -s from the worktree to a path outside the owned paths and scratch refused", !bad.length, bad.join("\n"));
bad = each(passes(), ["ln -s a.js src/b.js", `ln -s ${q(SCR)}/f src/s`, "ln -sr src/a.js src/c.js", "ln src/a.js src/d.js", "ln -s ../owned.js src/o"]);
ok("F7: ...while links to owned paths and scratch pass", !bad.length, bad.join("\n"));
// F8: git config that runs a program or reads another file
const GITCFG = /sets git config that runs a program|sets up a push/;
bad = each(refused(GITCFG), [
  "git config core.hooksPath /tmp/h", "git config --global core.fsmonitor x", "git config --local alias.st status", "git -c core.sshCommand=x fetch", "git -c core.pager=x log",
  "git config filter.lfs.clean x", "git config diff.foo.textconv x", "git config credential.helper store", "git config include.path /tmp/c",
  "git config includeIf.gitdir:/x.path /tmp/c", "git config --worktree core.editor vim", "git config set --system core.hooksPath /tmp/h", "git -c alias.x=status x",
]);
ok("F8: git config and git -c setting hooks, fsmonitor, ssh, editor, pager, alias, filter, textconv, credential and include refused", !bad.length, bad.join("\n"));
bad = each(passes(), ["git config user.name x", "git config --get core.hooksPath", "git -c color.ui=never log -1", "git config --list"]);
ok("F8: ...while other config, and reading it, pass", !bad.length, bad.join("\n"));
// F9: checkout / restore / reset pathspecs against the guarded paths
bad = each(refused(GUARDED, o2), [
  "git checkout -- .claude/settings.json", "git restore .claude/hooks/proteus-lib.js", "git reset -- .claude/agents/x.md", "git checkout HEAD .claude/settings.json",
  "git restore --source=HEAD -- .claude/proteus-owned", "git reset HEAD .claude/hooks",
]);
ok("F9: git checkout, restore and reset of a guarded pathspec refused, whatever the source", !bad.length, bad.join("\n"));
bad = each(passes(o2), ["git checkout -- README.md", "git restore src/a.js", "git checkout main", "git reset --hard", "git checkout -b feat/x", "git checkout .", "git reset HEAD^"]);
ok("F9: ...while owned pathspecs, branches and a bare reset pass", !bad.length, bad.join("\n"));
// F10: > inside $(( )), (( )) and [[ ]] compares
bad = each(passes(), ["echo $((1 > 0))", "(( 2 > 1 )) && echo y", "[[ b > a ]] && echo y", "x=$(( 3 >> 1 )); echo $x", "[[ \"$a\" > \"$b\" ]]", "(( n >= 2 ))"]);
ok("F10: a comparison or shift inside $(( )), (( )) and [[ ]] is no redirect", !bad.length, bad.join("\n"));
bad = each(refused(CONFINE), ["echo $((1 > 0)) > README.md", "[[ a > b ]] && echo x > README.md", "((echo x > ./README.md))"]);
ok("F10: ...while a redirect after one, or a literal path dash would write, is still judged", !bad.length, bad.join("\n"));
// F11: inline code that only reads outside stays refused (enforcement.md §13 documents it)
ok("F11: inline code reading a path outside is refused by design", refused(INLINE)("python3 -c \"print(open('/etc/hostname').read())\"") === "", refused(INLINE)("python3 -c \"print(open('/etc/hostname').read())\""));

// G2: the lead's one-off force-push allow, consumed by the first force-push it lets through
const allow = (wt, what = "force-push") => prepare(wt, "--allow", what);
r = allow(WT1, "rebase");
ok("allow: an unknown authorisation is bad usage", r.code === 1 && /--allow force-push/.test(r.err), r.err);
r = allow(path.join(W, "nowhere"));
ok("allow: a worktree with no owned list is refused", r.code === 1, r.err);
r = allow(WT1);
ok("allow: the lead records one force-push", r.code === 0 && hooks.allowLines(WT1).join() === "force-push", r.err + r.out);
ok("allow: the owned list is left as it was", fs.readFileSync(hooks.ownedFile(WT1), "utf8") === "src/**\nowned.js\n");
r = viaLead("git push --force origin proteus-work/r1/1 > README.md");
ok("allow: a force-push refused for another reason leaves the entry", r.code === 2 && CONFINE.test(r.err) && hooks.allowLines(WT1).length === 1, r.err);
r = viaLead("git push -f origin a; git push -f origin b");
ok("allow: two force-pushes in one call are refused, the entry kept", r.code === 2 && FORCE.test(r.err) && hooks.allowLines(WT1).length === 1, r.err);
r = viaLead("git push --force-with-lease origin proteus-work/r1/1", { who: ver });
ok("allow: a verifier's force-push stays refused, the entry kept", r.code === 2 && hooks.allowLines(WT1).length === 1, r.err);
r = viaLead("git push --force-with-lease origin proteus-work/r1/1");
ok("allow: the worker's first force-push passes (lead route)", r.code === 0, r.err);
ok("allow: ...and consumes the entry (recorded under proteus-lead; the allow file is not written)", hooks.allowLines(WT1).length === 0 && fs.existsSync(hooks.allowFile(WT1)));
r = viaLead("git push --force-with-lease origin proteus-work/r1/1");
ok("allow: the next one is refused again", r.code === 2 && FORCE.test(r.err), r.err);
allow(WT1); allow(WT1);
r = viaWorker("git push -f origin proteus-work/r1/1");
ok("allow: two entries allow two force-pushes, one per call (worker route)", r.code === 0 && hooks.allowLines(WT1).length === 1, r.err);
r = viaWorker("git push -f origin proteus-work/r1/1");
ok("allow: ...the second consumes the last", r.code === 0 && hooks.allowLines(WT1).length === 0, r.err);
ok("allow: ...and a third is refused", viaWorker("git push -f origin proteus-work/r1/1").code === 2);
allow(WT2);
ok("allow: an entry is per worktree", viaLead("git push -f origin proteus-work/r1/1").code === 2 && hooks.allowLines(WT2).length === 1);
bad = each(refused(/an agent never grants one/), [`node .claude/hooks/proteus-worktree.js ${q(WT1)} --allow force-push`, `sh -c 'node ${slash(SRC)}/proteus-worktree.js . --allow force-push'`]);
ok("allow: a worker never grants itself one", !bad.length, bad.join("\n"));
r = viaLead(`node .claude/hooks/proteus-worktree.js ${q(WT1)} --allow force-push`, { who: ver });
ok("allow: ...nor does a verifier", r.code === 2, r.err);
ok("allow: the worker cannot write the allow file itself", refused(GUARDED)(`echo force-push >> ${q(hooks.allowFile(WT1))}`) === "", refused(GUARDED)(`echo force-push >> ${q(hooks.allowFile(WT1))}`));

// the lead's and a verifier's shells keep the old rules
bad = each((c) => { const x = viaLead(c, { who: ver }); return x.code === 0 ? "" : `${c} => ${x.code} ${x.err}`; }, ["echo x >> README.md", "cp src/a.js /tmp/x", "node -e \"require('fs').writeFileSync('/tmp/x','y')\"", "F=x; echo > $F"]);
ok("scope: a verifier's shell is not confined to an owned list", !bad.length, bad.join("\n"));
r = lib.run(LG, ev("Bash", { command: "echo x >> README.md" }, {}), { cwd: REPO });
ok("scope: the lead's own shell is not either", r.code === 0, r.err);
ok("scope: a verifier still never writes a guarded path", viaLead("echo x > .claude/agents/x.md", { who: ver }).code === 2);

// G7: the deadline
const big = Array.from({ length: 4000 }, (_, i) => `echo ${"x".repeat(40)} > src/f${i}.js`).join(" && ");
// a command sized to take ~300 ms to tokenise on this machine (no write construct, so cheap to judge once split)
const rate = (() => { const c = "echo " + "a ".repeat(5e5), s = performance.now(); hooks.shellCommands(c); return (performance.now() - s) / c.length; })();
const HUGE = "echo " + "a ".repeat(Math.min(16e6, Math.max(2e6, Math.ceil(300 / rate / 2))));
let threw = null;
try { hooks.shellCommands("echo a > b", { left: -1 }); } catch (e) { threw = e; }
ok("deadline: the tokeniser stops once its clock runs out", threw && threw.tooComplex === true, String(threw));
const t0 = performance.now(); const toks = hooks.shellCommands(big); const ms = performance.now() - t0;
ok("deadline: without a clock, the same tokeniser has no limit", toks.length === 4000, `${toks.length} commands in ${ms.toFixed(1)} ms`);
r = viaLead(HUGE);
ok("deadline: a command too big to judge in 50 ms is refused, not hung on", r.code === 2 && /command too complex to judge; split it/.test(r.err), `${r.code} ${r.err}`);
r = viaWorker(HUGE);
ok("deadline: ...on the worker route too", r.code === 2 && /too complex/.test(r.err), `${r.code} ${r.err}`);
r = viaLead(HUGE, { who: ver });
ok("deadline: a verifier's shell has none (its rules are unchanged)", r.code === 0, r.err);

// benchmark: a command with no write construct is not slowed for a worker
const NO_WRITE = ["ls -la", "git status", "git log --oneline -5", "npm test", "grep -rn foo src | head", "cat README.md && wc -l src/a.js", "node scripts/build.js --flag", "go test ./..."];
const time = (who) => {
  const evs = NO_WRITE.map((c) => harness.event(ev("Bash", { command: cdTo(WT1) + c }, who)));
  for (const e of evs) hooks.workerDenial(e); // warm
  const runs = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); for (const e of evs) hooks.workerDenial(e); runs.push((performance.now() - s) / evs.length); }
  return runs.sort((a, b) => a - b)[runs.length >> 1];
};
const tw = time(w1), tv = time(ver);
ok("bench: no denial for any no-write command", NO_WRITE.every((c) => !hooks.workerDenial(harness.event(ev("Bash", { command: cdTo(WT1) + c }, w1)))));
ok(`bench: a worker's no-write command costs no more than a verifier's (${tw.toFixed(3)} vs ${tv.toFixed(3)} ms median)`, tw <= tv * 1.5 + 0.5, `${tw} ${tv}`);

// red on broken: each rule neutralised in a copy of the hooks lets its case through
const BROKEN = [
  ["confinement", "const why = wt ? confineDenial(t, dir, wt, what) :", "const why = wt ? \"\" :", "echo x >> README.md"],
  ["no worktree", ": AGENT_MSG.noTree(what);", ": \"\";", "echo x >> README.md", { run: noTreeLead }],
  ["-c in a flag cluster", "if (/^-[a-zA-Z]*c$/.test(words[k])) { c = k; break; }", "if (words[k] === \"-c\") { c = k; break; }", "bash -lc 'echo x > README.md'"],
  ["source of stdin", "      if (f === undefined || ", "      if (false && ", "source /dev/stdin <<< 'rm README.md'"],
  ["busybox", "busybox: [], ", "", "busybox rm README.md"],
  ["xargs writer", "&& writesOperands(words)) return AGENT_MSG.xargs(prog);", "&& false) return null;", "echo README.md | xargs rm"],
  ["attached git -C", "else if (a.startsWith(\"-C\")) { const e = at(\"-C\", a.slice(2), d); if (e[1]) d = e[1]; out.push(e); }", "", "git -C/x status"],
  ["output options", "if (OUTPUT_OPT[prog]) {", "if (false) {", "curl -o /tmp/x http://127.0.0.1:9/x"],
  ["tar -x", "if (prog === \"tar\" && (", "if (false && (", "tar -xf x.tar -C /tmp"],
  ["unzip", "if (prog === \"unzip\") {", "if (false) {", "unzip x.zip -d /tmp"],
  ["awk program", "(interpreter(prog) || AWK.test(prog))", "interpreter(prog)", "awk '{print > \"/tmp/x\"}' src/a.js"],
  ["link target", "const wt = workerTree(ev, dir), why = wt && linkDenial(words, dir, wt);", "const why = \"\";", "ln -s /etc/passwd src/p"],
  ["git config", "worker && s && RUNS_CONFIG.test(s[0]) ?", "false ?", "git config core.hooksPath /tmp/h"],
  ["git -c", "if (worker && RUNS_CONFIG.test(k))", "if (false)", "git -c core.sshCommand=x fetch"],
  ["pathspecs", "const why = pathspecDenial(sub, args, d, ev);", "const why = null;", "git checkout -- .claude/settings.json"],
  // inverted: the comparison passes, and neutralised it reads as a redirect
  ["arithmetic", "} else if ((arith || cond) && c === \">\") {", "} else if (false) {", "echo $((1 > 0))", { invert: true }],
  ["inline code", "const why = inlineDenial(ev, text, dir, wt, prog, ctx.clock);", "const why = \"\";", "node -e \"require('fs').writeFileSync('/tmp/x','y')\""],
  ["stdin to a shell", "const why = agentShellDenial(ev, text, dir, depth + 1, ctx);", "const why = null;", "echo 'echo x > README.md' | sh"],
  ["force-push", "      if (force) {\n", "      if (false) {\n", "git push -f origin proteus-work/r1/1"],
  ["self-allow", "return AGENT_MSG.selfAllow;", "return null;", `node .claude/hooks/proteus-worktree.js ${q(WT1)} --allow force-push`],
  ["deadline", "if (late && !(i & 1023) && late()) throw tooComplex();", "", HUGE],
  ["runtime target", "return AGENT_MSG.runtime(what, t);", "continue;", "F=README.md; echo x > \"$F\""],
];
for (const [name, from, to, cmd, { run = (c, guard) => viaLead(c, { guard }), invert = false } = {}] of BROKEN) {
  const dir = path.join(W, "broken-" + name.replace(/\W+/g, "-"));
  fs.cpSync(SRC, dir, { recursive: true });
  const file = path.join(dir, "proteus-lib.js"), text = fs.readFileSync(file, "utf8");
  const n = text.split(from).length - 1;
  fs.writeFileSync(file, text.replace(from, to));
  const good = run(cmd, LG), broke = run(cmd, path.join(dir, "proteus-lead-guard.js"));
  const [g0, b0] = invert ? [0, 2] : [2, 0];
  ok(`red on broken: ${name} ${invert ? "passes" : "refuses"} its case, and ${invert ? "refuses" : "passes"} it once neutralised`, n === 1 && good.code === g0 && broke.code === b0, `${n} ${good.code} ${broke.code} ${good.err} ${broke.err}`);
}
// the G5 anchor: neutralised, the confinement still refuses, but no longer as a guarded path
{
  const dir = path.join(W, "broken-anchor");
  fs.cpSync(SRC, dir, { recursive: true });
  const file = path.join(dir, "proteus-lib.js"), text = fs.readFileSync(file, "utf8");
  const from = "for (const a of cliHomes()) {";
  fs.writeFileSync(file, text.replace(from, "for (const a of []) {"));
  const cmd = `echo x > ${q(path.join(CFG, "settings.json"))}`, env = { CLAUDE_CONFIG_DIR: CFG };
  const good = viaLead(cmd, { ...o2, env }), broke = viaLead(cmd, { ...o2, env, guard: path.join(dir, "proteus-lead-guard.js") });
  ok("red on broken: $CLAUDE_CONFIG_DIR as a guarded anchor", text.includes(from) && GUARDED.test(good.err) && !GUARDED.test(broke.err), `${good.err} | ${broke.err}`);
}

lib.summary();
