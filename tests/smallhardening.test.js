// Small hardening items from #104 and #96: Codex writable_roots case folding and the [[sandbox_workspace_write]]
// refusal, the journal recall not following links,
// link-skills saying "confined" only when it removed something, owned-path globs naming a plain directory, and
// tests/run.js totals for a file that crashes or is chatty and its check that the run left the checkout alone (#218), owned-path globs below a matched folder and the one
// samePath (#96). Temp dirs only; no network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("smallhardening");
const L = require(path.join(SRC, "proteus-lib.js"));
const cx = require(path.join(SRC, "proteus-harness-codex.js"));

// run fn as if on another platform: only process.platform changes, so path stays posix
function onPlatform(name, fn) {
  const was = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: name });
  try { return fn(); } finally { Object.defineProperty(process, "platform", was); }
}

// ---- Codex writable_roots: case-insensitive where the filesystem is; the array-of-tables form is refused
{
  const repo = path.join(W, "cx", "app"), guest = path.join(W, "cx", "Guest-Dir");
  const cfg = path.join(repo, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const put = (text) => fs.writeFileSync(cfg, text);
  put(`[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(guest.toUpperCase())}]\n`);
  const check = (platform) => onPlatform(platform, () => cx.sandboxRoots(repo, false, guest));
  ok("codex writable_roots: a root listed in another case is missing on linux", check("linux").missing === true);
  ok("codex writable_roots: the same root counts as listed on darwin and win32", check("darwin").missing === false && check("win32").missing === false);
  const was = fs.readFileSync(cfg, "utf8");
  const r = onPlatform("darwin", () => cx.sandboxRoots(repo, true, guest));
  ok("codex writable_roots: a root listed in another case is not added again on darwin", !r.changed && fs.readFileSync(cfg, "utf8") === was, JSON.stringify(r));

  for (const form of ["[[sandbox_workspace_write]]\nwritable_roots = []\n", '  [[ "sandbox_workspace_write" ]]\nnetwork_access = true\n']) {
    put(form);
    const e = cx.sandboxRoots(repo, true, guest);
    ok("codex writable_roots: the [[sandbox_workspace_write]] form is refused with a message and left alone",
      typeof e.error === "string" && e.error.includes("[[sandbox_workspace_write]]") && e.error.includes("add ") && fs.readFileSync(cfg, "utf8") === form, JSON.stringify(e));
  }
}

// ---- compaction recall reads the journal as a regular file only
if (process.platform !== "win32") {
  const repo = path.join(W, "said");
  fs.mkdirSync(path.join(repo, ".claude", "skills", "proteus"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nBODY\n");
  g(W, "init", "-q", "-b", "main", repo);
  const outside = path.join(W, "outside.jsonl");
  fs.writeFileSync(outside, JSON.stringify({ prompt: "from the linked file" }) + "\n");
  fs.mkdirSync(path.join(repo, ".git", "proteus"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, ".git", "proteus", "journal.jsonl"));
  const r = lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "compact", session_id: "s1", cwd: repo }, { cwd: repo, env: { FAKE_GH: "fail" } });
  ok("recall: a journal that is a link is not read", r.out.includes("BODY") && !r.out.includes("from the linked file"), r.out.slice(0, 400) + r.err);
}

// ---- link-skills: "confined" only when a global link was removed
{
  const repo = path.join(W, "ls", "repo");
  const teamDir = path.join(repo, "teams", "a");
  fs.mkdirSync(teamDir, { recursive: true });
  const skill = path.join(lib.HOME, ".agents", "skills", "demo-skill");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo-skill\n---\n");
  const script = path.join(ROOT, "templates", "teams", "link-skills.js");
  fs.writeFileSync(path.join(teamDir, "skills.txt"), "x/y not-installed-skill\n");
  let r = lib.run(script, "", { cwd: repo, args: ["--confine"] });
  ok("link-skills --confine: nothing linked, nothing removed: it does not claim to have confined", !/confined:/.test(r.out) && /nothing to remove/.test(r.out), r.out + r.err);
  fs.writeFileSync(path.join(teamDir, "skills.txt"), "x/y demo-skill\n");
  const global = path.join(lib.HOME, ".claude", "skills", "demo-skill");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.symlinkSync(skill, global, "dir");
  r = lib.run(script, "", { cwd: repo, args: ["--confine"] });
  ok("link-skills --confine: a global link removed is reported with its count", /confined: 1 linked skill removed/.test(r.out) && !fs.existsSync(global), r.out + r.err);
}

// ---- owned-path globs: a plain path covers itself and what is below it
{
  ok("ownedMatch: a plain directory path covers files below it, at any depth", L.ownedMatch("src/auth", "src/auth/login.js") && L.ownedMatch("src/auth", "src/auth/deep/x.js") && L.ownedMatch("./src/auth", "src/auth/x.js"));
  ok("ownedMatch: a plain path still covers exactly itself", L.ownedMatch("src/a.js", "src/a.js"));
  ok("ownedMatch: a plain path does not cover a sibling that shares its prefix", !L.ownedMatch("src/auth", "src/authz/x.js") && !L.ownedMatch("src/a.js", "src/a.json") && !L.ownedMatch("src/auth", "other/src/auth/x.js"));
  ok("ownedMatch: * stays inside a segment, ** spans any depth, a trailing / owns the whole folder", L.ownedMatch("src/*", "src/b.js") && !L.ownedMatch("src/*.js", "src/a/b.ts") && L.ownedMatch("src/", "src/a/b.js") && L.ownedMatch("**", "a/b") && L.ownedMatch("src/**/x.js", "src/a/b/x.js"));
  ok("ownedMatch: on win32 a plain path matches in any case", onPlatform("win32", () => L.ownedMatch("Src/Auth", "src/auth/x.js")) && onPlatform("linux", () => !L.ownedMatch("Src/Auth", "src/auth/x.js")));
}

// ---- owned-path globs: a glob owns what is below any folder it matches, wherever its wildcards sit (#96)
{
  ok("ownedMatch: a trailing * owns the files below the folders it matches", L.ownedMatch("src/*", "src/a/b.js") && L.ownedMatch("src/*", "src/a/b/c.js"));
  ok("ownedMatch: a * in the middle owns what is below the folders it matches", L.ownedMatch("packages/*/src", "packages/x/src/y.js") && L.ownedMatch("packages/*/src", "packages/x/src") && L.ownedMatch("a/*/b/*", "a/x/b/y/z.js"));
  ok("ownedMatch: a ** in the middle owns what is below the folders it matches", L.ownedMatch("src/**/test", "src/a/b/test/x.js") && L.ownedMatch("**/fixtures", "a/fixtures/b/c.json"));
  ok("ownedMatch: a glob does not own a sibling that only shares its prefix", !L.ownedMatch("src/*", "srcx/a") && !L.ownedMatch("src/*", "src") && !L.ownedMatch("packages/*/src", "packages/x/srcx/y.js") && !L.ownedMatch("packages/*/src", "packages/x/lib/src.js"));
  ok("ownedMatch: a glob does not own a path that matches only below its own depth", !L.ownedMatch("packages/*/src", "packages/x/y/src/z.js") && !L.ownedMatch("src/*", "other/src/a/b.js") && !L.ownedMatch("*.md", "docs/a.md"));
  ok("ownedMatch: on win32 a wildcard glob owns below its folders in any case", onPlatform("win32", () => L.ownedMatch("Packages/*/SRC", "packages/x/src/y.js")) && onPlatform("linux", () => !L.ownedMatch("Packages/*/SRC", "packages/x/src/y.js")));
}

// ---- samePath: one implementation, proteus-confine.js's, which the hooks and install.js all take (#96)
{
  const C = require(path.join(SRC, "proteus-confine.js"));
  ok("samePath: the lib and the Codex adapter re-export proteus-confine.js's, not a copy of their own", L.samePath === C.samePath && cx.samePath === C.samePath);
  ok("samePath: a missing side is never the same path", !C.samePath("", "") && !C.samePath(null, "/a") && !C.samePath("/a", undefined));
  ok("samePath: linux compares case exactly, ignores a trailing or doubled separator", C.samePath("/a/b/", "/a//b", "linux") && !C.samePath("/A/b", "/a/b", "linux"));
  ok("samePath: darwin folds case, win32 folds case and either separator", C.samePath("/Users/Me", "/users/me", "darwin") && C.samePath("C:\\Users\\Me", "c:/users/me/", "win32") && !C.samePath("C:\\a", "D:\\a", "win32"));
  const scratch = fs.readFileSync(path.join(SRC, "proteus-scratch.js"), "utf8");
  ok("samePath: no hook keeps its own case-folding path comparison", ["proteus-lib.js", "proteus-harness-codex.js", "proteus-scratch.js"].every((f) => !/toLowerCase\(\) === \w+\.toLowerCase\(\)/.test(fs.readFileSync(path.join(SRC, f), "utf8"))) && /lib\.samePath\(/.test(scratch));
}

// ---- tests/run.js: a crashing file is counted in the total, a chatty one keeps its summary line
{
  const dir = path.join(W, "runner");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "run.js"), path.join(dir, "run.js"));
  fs.writeFileSync(path.join(dir, "a.test.js"), 'console.log("3 passed, 0 failed");\n');
  fs.writeFileSync(path.join(dir, "b.test.js"), 'throw new Error("boom");\n');
  fs.writeFileSync(path.join(dir, "c.test.js"), 'process.stdout.write("y".repeat(3 * 1024 * 1024) + "\\n"); console.log("5 passed, 0 failed");\n');
  const r = spawnSync(process.execPath, [path.join(dir, "run.js")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  ok("run.js: a crashed file is named, counted as a failure and fails the run", r.status === 1 && /FAIL b\.test\.js: no summary line/.test(r.stdout) && /\n8 passed, 1 failed across 3 files \(1 did not finish cleanly\)\n/.test(r.stdout), r.stdout.slice(-300));
  ok("run.js: a file printing more than 1 MiB keeps its summary line in the total", /8 passed/.test(r.stdout) && !/FAIL c\.test\.js/.test(r.stdout), r.stdout.slice(-300));
  ok("run.js: outside a git repo the checkout check is skipped", !/changed the checkout/.test(r.stdout), r.stdout.slice(-300));
}

// ---- tests/run.js: files run at once, and their output stays in file order
{
  const dir = path.join(W, "runner-jobs");
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(__dirname, "run.js"), path.join(dir, "run.js"));
  const flag = JSON.stringify(path.join(dir, "flag"));
  // a waits for a file only b writes, so it passes only if b started before a ended
  fs.writeFileSync(path.join(dir, "a.test.js"), `const fs = require("fs"); const end = Date.now() + 20000;
const wait = () => { if (fs.existsSync(${flag})) console.log("1 passed, 0 failed"); else if (Date.now() > end) console.log("0 passed, 1 failed"); else setTimeout(wait, 20); };
wait();\n`);
  fs.writeFileSync(path.join(dir, "b.test.js"), `require("fs").writeFileSync(${flag}, ""); console.log("1 passed, 0 failed");\n`);
  const r = spawnSync(process.execPath, [path.join(dir, "run.js")], { encoding: "utf8", env: { ...process.env, PROTEUS_TEST_JOBS: "2" } });
  ok("run.js: with PROTEUS_TEST_JOBS=2 two files run at once", r.status === 0 && /\n2 passed, 0 failed across 2 files/.test(r.stdout), r.stdout.slice(-300));
  ok("run.js: output follows file order, not finish order", /test files\n1 passed, 0 failed\n1 passed, 0 failed\n/.test(r.stdout), r.stdout.slice(-300));
  fs.rmSync(path.join(dir, "flag"));
  fs.unlinkSync(path.join(dir, "b.test.js"));
  fs.writeFileSync(path.join(dir, "a.test.js"), `console.log("1 passed, 0 failed");\n`);
  fs.writeFileSync(path.join(dir, "b.test.js"), `require("fs").writeFileSync(${flag}, ""); console.log("1 passed, 0 failed");\n`);
  fs.writeFileSync(path.join(dir, "c.test.js"), `console.log(require("fs").existsSync(${flag}) ? "1 passed, 0 failed" : "0 passed, 1 failed");\n`);
  const one = spawnSync(process.execPath, [path.join(dir, "run.js")], { encoding: "utf8", env: { ...process.env, PROTEUS_TEST_JOBS: "1" } });
  ok("run.js: PROTEUS_TEST_JOBS=1 runs one file at a time, in order", one.status === 0 && /\n3 passed, 0 failed across 3 files/.test(one.stdout), one.stdout.slice(-300));
}

// ---- tests/run.js: a test that writes a tracked file into the checkout fails the run (#218)
{
  const repo = path.join(W, "runner-repo"), t = path.join(repo, "tests");
  fs.mkdirSync(t, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "run.js"), path.join(t, "run.js"));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# agents\n");
  fs.writeFileSync(path.join(t, "a.test.js"), 'console.log("2 passed, 0 failed");\n');
  g(W, "init", "-q", "-b", "main", repo);
  g(repo, "add", "-A"); g(repo, "commit", "-qm", "init");
  const run = () => spawnSync(process.execPath, [path.join(t, "run.js")], { encoding: "utf8" });
  let r = run();
  ok("run.js: a run that leaves the checkout alone passes", r.status === 0 && !/changed the checkout/.test(r.stdout), r.stdout.slice(-300));
  fs.writeFileSync(path.join(t, "b.test.js"), 'require("fs").writeFileSync(require("path").join(__dirname, "..", "AGENTS.md"), "x\\n"); console.log("1 passed, 0 failed");\n');
  r = run();
  ok("run.js: a test writing a tracked file fails the run and names the path", r.status === 1 && /FAIL the run changed the checkout .*:\n {2}AGENTS\.md\n/.test(r.stdout) && /\n3 passed, 1 failed across 2 files\n/.test(r.stdout), r.stdout.slice(-300));
}

lib.summary();
