// Codex prefix rules and the lead's scripts (#234): the rules name the main checkout's hooks by absolute path and
// are rewritten when that path changes, and each script a rule names, other than the two a worker's worktree runs
// itself (proteus-tier.js, proteus-scratch.js), refuses to run from a copy outside the main checkout's hooks dir or
// the plugin's. node tests/codexrules.test.js
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const HOOKS = path.join(ROOT, "templates", "hooks");
const cx = require(path.join(HOOKS, "proteus-harness-codex.js"));
const plib = require(path.join(HOOKS, "proteus-lib.js"));
const W = lib.workdir("codexrules");
const slash = (p) => p.split(path.sep).join("/");
const GUARDED = ["proteus-cli.js", "proteus-worktree.js", "proteus-status.js", "proteus-ready.js", "proteus-merge.js", "proteus-inbox.js", "proteus-skillpath.js", "proteus-skill-find.js", "proteus-verdict.js", "proteus-watchdog.js", "proteus-close-report.js", "proteus-intake.js"];
const WORKER_RUN = ["proteus-tier.js", "proteus-scratch.js"];
const REFUSAL = /^proteus: proteus-[\w-]+\.js runs only from the main checkout's hooks dir or the plugin's, not .+\n$/;

// the rules: absolute, and rewritten when the checkout moves
{
  const A = path.join(W, "a"), B = path.join(W, "b");
  fs.mkdirSync(A);
  cx.registerLead(A);
  const text = fs.readFileSync(path.join(A, ".codex", "rules", "proteus.rules"), "utf8");
  ok("rules: every script the rules run is named by the main checkout's absolute hooks path",
    [...GUARDED, ...WORKER_RUN].every((f) => text.includes(JSON.stringify(slash(path.join(A, ".codex", "hooks", f))))) && GUARDED.length + WORKER_RUN.length === cx.RULE_SCRIPTS.length, text);
  ok("rules: no rule names a relative .codex/hooks path", !/"\.codex\/hooks\//.test(text), text);
  fs.renameSync(A, B);
  const r = cx.registerLead(B);
  const moved = fs.readFileSync(path.join(B, ".codex", "rules", "proteus.rules"), "utf8");
  ok("rules: regenerated after a move, they name the new path and not the old one",
    r.changed && moved === cx.rules(B) && moved.includes(JSON.stringify(slash(path.join(B, ".codex", "hooks", "proteus-status.js")))) && !moved.includes(slash(A) + "/"), moved);
}

// a main checkout with the hooks in .codex/hooks, a linked worktree, and a copy of them in its nested .codex/hooks
const M = path.join(W, "main");
fs.mkdirSync(M);
g(M, "init", "-q");
g(M, "commit", "-q", "--allow-empty", "-m", "init");
const WT = path.join(M, ".worktrees", "x");
g(M, "worktree", "add", "-q", "-b", "x", WT);
const copyHooks = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(HOOKS)) if (fs.statSync(path.join(HOOKS, f)).isFile()) fs.copyFileSync(path.join(HOOKS, f), path.join(dir, f));
};
copyHooks(path.join(M, ".codex", "hooks"));
copyHooks(path.join(WT, ".codex", "hooks"));
const env = { PROTEUS_HARNESS: "codex" };

for (const f of GUARDED) {
  const nested = lib.run(path.join(".codex", "hooks", f), "", { cwd: WT, args: ["--help"], env });
  ok(`guard: ${f} copied into a worktree's nested .codex/hooks and run from there exits 2 with one line`, nested.code === 2 && REFUSAL.test(nested.err), `${nested.code} ${nested.err}`);
  const real = lib.run(path.join(M, ".codex", "hooks", f), "", { cwd: WT, args: ["--help"], env });
  ok(`guard: ${f} in the main checkout's .codex/hooks still runs`, !REFUSAL.test(real.err), `${real.code} ${real.err}`);
  const plugin = lib.run(path.join(HOOKS, f), "", { cwd: M, args: ["--help"] });
  ok(`guard: ${f} in the plugin's templates/hooks still runs`, !REFUSAL.test(plugin.err), `${plugin.code} ${plugin.err}`);
}
// tier and scratch have no guard: no generated rule matches a worker's nested copy, by relative or absolute path
{
  const text = cx.rules(M);
  const named = text.split("\n").filter((l) => l.startsWith('prefix_rule(pattern=["node"')).flatMap((l) => JSON.parse(/, (\[[^\]]*\])\]/.exec(l)[1]));
  const nested = (f) => [`.codex/hooks/${f}`, slash(path.join(WT, ".codex", "hooks", f)), slash(path.relative(M, path.join(WT, ".codex", "hooks", f)))];
  ok("rules: no generated rule matches a nested copy of proteus-tier.js or proteus-scratch.js",
    named.length === cx.RULE_SCRIPTS.length && WORKER_RUN.every((f) => named.includes(slash(path.join(M, ".codex", "hooks", f))) && nested(f).every((a) => !named.includes(a))), JSON.stringify(named));
}
for (const f of WORKER_RUN) {
  const r = lib.run(path.join(".codex", "hooks", f), "", { cwd: WT, args: ["--help"], env });
  ok(`guard: ${f} still runs from a worker's own hooks dir (its pre-commit and hooks use that copy)`, r.code === 0 && !REFUSAL.test(r.err), `${r.code} ${r.err}`);
}

// a copy in a plain folder inside the main checkout, not a registered worktree, is refused too
{
  const D = path.join(M, ".worktrees", "loose", ".codex", "hooks");
  copyHooks(D);
  const r = lib.run(path.join(D, "proteus-status.js"), "", { cwd: M, args: ["--help"], env });
  ok("guard: a copy in an unregistered folder under the checkout is refused", r.code === 2 && REFUSAL.test(r.err), `${r.code} ${r.err}`);
}

// the comparison is by real path, and case-insensitive on Windows
ok("guard: on win32 a hooks dir differing only in case still allows the script",
  plib.homeAllows("C:\\Repo\\.codex\\hooks\\proteus-status.js", ["c:\\repo\\.codex\\hooks"], "win32"));
ok("guard: on win32 a nested copy is not under the main hooks dir",
  !plib.homeAllows("C:\\Repo\\.worktrees\\x\\.codex\\hooks\\proteus-status.js", ["C:\\Repo\\.codex\\hooks"], "win32"));
ok("guard: on linux case counts", !plib.homeAllows("/Repo/.codex/hooks/proteus-status.js", ["/repo/.codex/hooks"], "linux"));
if (process.platform !== "win32") {
  const L = path.join(M, ".worktrees", "link");
  fs.symlinkSync(path.join(M, ".codex", "hooks"), L);
  const r = lib.run(path.join(L, "proteus-status.js"), "", { cwd: M, args: ["--help"], env });
  ok("guard: a link to the main hooks dir runs the real script (judged by its real path)", !REFUSAL.test(r.err), `${r.code} ${r.err}`);
}

lib.summary();
