// P0 small fixes: commit-msg trailer matching, lead guard image names, lesson hit log, lesson regex safety,
// lead write list. Temp repo only; no network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run } = lib;
const W = lib.workdir("p0small");

// commit-msg: AI attribution trailers only
const CM = path.join(SRC, "commit-msg.js");
let n = 0;
const msg = (m) => { const f = path.join(W, `msg${n++}`); fs.writeFileSync(f, m); return run(CM, "", { args: [f] }).code; };
const head = "fix(x): do a thing\n\nwhy\n";
ok("commit-msg: Co-Authored-By naming Claude rejected", msg(head + "\nCo-Authored-By: Claude <noreply@anthropic.com>\n") === 1);
ok("commit-msg: Generated with trailer rejected", msg(head + "\nGenerated with [Claude Code](https://claude.com/claude-code)\n") === 1);
ok("commit-msg: robot emoji trailer rejected", msg(head + "\n🤖 Generated with [Claude Code](https://x)\n\nCo-Authored-By: Claude <a@b.c>\n") === 1);
ok("commit-msg: AI Signed-off-by name rejected", msg(head + "\nSigned-off-by: Claude <c@x.com>\n") === 1);
ok("commit-msg: human Signed-off-by on an .ai domain passes", msg(head + "\nSigned-off-by: Ada Lovelace <ada@acme.ai>\n") === 0);
ok("commit-msg: human Co-Authored-By passes", msg(head + "\nCo-Authored-By: Ada Lovelace <ada@acme.ai>\n") === 0);
ok("commit-msg: body prose starting Generated with passes", msg("fix(x): do a thing\n\nGenerated with the old tool, now replaced.\n\nSecond paragraph.\n") === 0);
ok("commit-msg: body mentions of AI outside the trailer pass", msg("fix(x): do a thing\n\nCo-Authored-By lines are not parsed here.\nthe ai module is renamed.\n\nSigned-off-by: Ada <a@b.ai>\n") === 0);

// lead guard: the image escape hatch needs the whole file name in the human's prompt
const g = lib.g;
const REPO = path.join(W, "repo");
fs.mkdirSync(REPO);
g(REPO, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(REPO, "AGENTS.md"), "x\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const LG = path.join(SRC, "proteus-lead-guard.js");
const tr = (name, text) => {
  const f = path.join(W, name);
  fs.writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" } }) + "\n");
  return f;
};
const read = (file, text) => run(LG, { hook_event_name: "PreToolUse", session_id: "s1", transcript_path: tr(`t${n++}.jsonl`, text), cwd: REPO, tool_name: "Read", tool_input: { file_path: file } }, { cwd: REPO });
const allowed = (file, text) => { const r = read(file, text); return r.code === 0 && r.out === ""; };
ok("image: exact name allowed", allowed("/r/a.png", "look at a.png please"));
ok("image: a.png does not match data.png", !allowed("/r/a.png", "look at data.png please"));
ok("image: a.png does not match a.png.bak", !allowed("/r/a.png", "delete a.png.bak"));
ok("image: a.png does not match xa.png or a.pngx", !allowed("/r/a.png", "see xa.png and a.pngx"));
ok("image: path segment and full stop allowed", allowed("/r/a.png", "open /tmp/out/a.png.") && allowed("/r/a.png", '"a.png",'));
ok("image: regex characters in the name are literal", !allowed("/r/a+b.png", "see aab.png") && allowed("/r/a+b.png", "see a+b.png"));

// lessons: a trigger that can backtrack without end is skipped, safe ones still fire
const LSP = path.join(SRC, "proteus-lessons.js");
const lesson = (name, trigger) => fs.writeFileSync(path.join(REPO, "docs", "lessons", name + ".md"), `---\ntrigger: ${trigger}\non: command\n---\nbody ${name}\n`);
fs.mkdirSync(path.join(REPO, "docs", "lessons"), { recursive: true });
const unsafe = ["(a+)+$", "(a*)*b", "(a|a)*$", "(a|ab)+c", "(x+x+)+y", "(?:a{2,})+$", "([a-z]+)*$"];
unsafe.forEach((t, i) => lesson(`bad${i}`, t));
lesson("safe", "(npm|yarn) (run )?build");
const evt = (command, session) => ({ hook_event_name: "PreToolUse", session_id: session, cwd: REPO, tool_name: "Bash", tool_input: { command } });
let r = run(LSP, evt("a".repeat(40) + "!", "redos"), { cwd: REPO });
ok("lessons: nested-quantifier triggers skipped, fast", r.code === 0 && r.out === "" && r.ms < 3000 && unsafe.every((t, i) => r.err.includes(`bad${i}.md`)), `${r.ms}ms ${r.err}`);
r = run(LSP, evt("npm run build", "redos2"), { cwd: REPO });
ok("lessons: safe trigger still hits", /body safe/.test(r.out) && !/body bad/.test(r.out), r.out);
lesson("long", "needle$");
r = run(LSP, evt("x".repeat(100000) + " needle", "redos3"), { cwd: REPO });
ok("lessons: input is cut before matching", !/body long/.test(r.out) && r.code === 0, r.out.slice(0, 200));
for (let i = 0; i < unsafe.length; i++) fs.unlinkSync(path.join(REPO, "docs", "lessons", `bad${i}.md`));
for (const f of ["safe", "long"]) fs.unlinkSync(path.join(REPO, "docs", "lessons", f + ".md"));

// async tests last; they print the summary
(async () => {
  // lessons: hits are appended, so parallel sessions lose none
  fs.mkdirSync(path.join(REPO, "docs", "lessons"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "docs", "lessons", "boom.md"), "---\ntrigger: boom\non: command\n---\nbody\n");
  const LS = path.join(SRC, "proteus-lessons.js");
  const launch = (session) => new Promise((resolve) => {
    const c = spawn(process.execPath, [LS], { cwd: REPO, env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: REPO } });
    c.on("close", resolve);
    c.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd: REPO, tool_name: "Bash", tool_input: { command: "boom" } }));
  });
  const hitFile = path.join(REPO, ".git", "proteus", "lesson-hits.jsonl");
  const count = () => { try { return fs.readFileSync(hitFile, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const before = count();
  await Promise.all(Array.from({ length: 12 }, (_, i) => launch(`race${i}`)));
  ok("lessons: concurrent sessions each leave one hit line", count() - before === 12, `${count() - before} of 12`);
  ok("lessons: no read-modify-write json left behind", !fs.existsSync(path.join(REPO, ".git", "proteus", "lesson-hits.json")));
  lib.summary();
})();
