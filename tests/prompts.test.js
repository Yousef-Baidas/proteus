// Prompt contract tests: node tests/prompts.test.js. Reads the shipped skill, roles and worker agents and
// checks the rules that split exploration from the approved pipeline: the lead may add steps only before
// the spec is approved, ponytail binds only Quick and mechanical tickets, and the verifier does not count
// a worker's own helpers as extras. Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { ok, summary } = require(path.join(__dirname, "lib.js"));

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const skill = read("skills", "proteus", "SKILL.md");
const roles = read("skills", "proteus", "references", "roles.md");
const block = (name) => (new RegExp(`## ${name}[^\\n]*\\n\`\`\`\\n([\\s\\S]*?)\`\`\``).exec(roles) || [])[1] || "";

const rule3 = (/^3\. .*$/m.exec(skill) || [""])[0];
ok("rule 3: before the spec is approved the lead may add exploratory steps", /Until the human approves the spec/.test(rule3) && /\/prototype/.test(rule3) && /devil's-advocate/.test(rule3), rule3);
ok("rule 3: exploration output is thrown away, so it is no deliverable", /thrown away/.test(rule3) && /no deliverable/.test(rule3), rule3);
ok("rule 3: after approval no step is skipped without an exit and a run-log line", /After approval/.test(rule3) && /none skipped/.test(rule3) && /run-log line/.test(rule3) && !/none added/.test(rule3), rule3);

const worker = block("Worker");
ok("worker prompt: ponytail is not unconditional", !/Ponytail full\.\s*$/m.test(worker.split("\n").find((l) => l.startsWith("Long jobs")) || ""), worker);
ok("worker prompt: ponytail only on Quick or mechanical tickets, craft on standard and hard", /<Quick or mechanical: Ponytail full[^>]*\| standard or hard:[^>]*good craft[^>]*>/.test(worker), worker);
ok("worker prompt: no IDEA report line", !/IDEA/.test(worker));

for (const f of fs.readdirSync(path.join(ROOT, "agents")).filter((n) => /^proteus-(\w+-)?verifier\.md$/.test(n) && n !== "proteus-qa-verifier.md")) {
  const a = read("agents", f);
  ok(`${f}: helpers and tests inside owned paths are not extras`, /not extras/.test(a) && !/nothing extra\)/.test(a));
}

for (const f of fs.readdirSync(path.join(ROOT, "agents")).filter((n) => /^proteus-(\w+-)?worker\.md$/.test(n))) {
  const a = read("agents", f);
  ok(`${f}: the design inside the contract is the worker's; minimal style only on Quick and mechanical`, /the design is yours/.test(a) && /Quick and mechanical/.test(a));
}

// the prose points to --help for the scripts' flags, so --help must explain them and exit 0
const { spawnSync } = require("child_process");
ok("SKILL.md points to the scripts' --help for their flags", /--help/.test(skill));
const help = (name) => spawnSync(process.execPath, [path.join(ROOT, "templates", "hooks", `proteus-${name}.js`), "--help"], { encoding: "utf8", cwd: ROOT });
for (const [name, flags] of [["worktree", ["--tier", "--human"]], ["tier", ["--staged", "--ci"]], ["scratch", ["--path", "--sweep", "--all-done", "--stale", "--size"]], ["close-report", ["--no-cost", "--cost-json"]], ["status", ["[run]"]]]) {
  const r = help(name);
  ok(`proteus-${name}.js --help: exits 0 and explains ${flags.join(", ")}`, r.status === 0 && r.stdout.startsWith("usage: ") && r.stdout.split("\n").length > 2 && flags.every((f) => r.stdout.includes(f)), r.stdout + r.stderr);
}

summary();
