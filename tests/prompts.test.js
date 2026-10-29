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

// #203: authorization in one place; no verifier fixture harness exists, so the text is the contract
const authz = ["Authorization lives in one module, the one `CONVENTIONS.md` names: the single source of truth, field-level rules included", "Every handler or service call goes through it", "Query filters are derived from it, not copied"];
for (const team of ["backend", "security"]) {
  const p = read("templates", "teams", team, "PROFILE.md");
  ok(`${team} PROFILE.md: the three authorization rules`, authz.every((r) => p.includes(`- ${r}`)), p);
  ok(`${team} PROFILE.md: the verifier fails an inline permission check, quoting the rule`, /new inline permission check outside the authorization module is `BACK-TO-WORKER` quoting the rule/.test(p), p);
}
ok("conventions interview asks where the authorization module is", /^ {3}- authorization: the path of the one module/m.test(read("skills", "proteus", "references", "conventions.md")));

// #200: security pass per milestone and audit at close; the lead's instructions hold the gate, so the text is the contract
const enf = read("skills", "proteus", "references", "enforcement.md");
const s10b = (/^## 10b\. Security pass per milestone and audit at close\n([\s\S]*?)\n## /m.exec(enf) || [])[1] || "";
ok("enforcement.md §10b sits right after §10", /^## 10\. .*\n\n[^\n]*\n\n## 10b\. /m.test(enf), s10b);
ok("§10b: milestone mode on the milestone diff checks authz, input reaching I/O and the abuse cases", /`milestone`/.test(s10b) && /milestone diff/.test(s10b) && /authorization on every new route/.test(s10b) && /input that reaches .*I\/O/.test(s10b) && /abuse cases/.test(s10b), s10b);
ok("§10b: close mode audits the whole repo with the scout-picked audit skill", /`close` over the whole repo/.test(s10b) && /audit skill the scout picked/.test(s10b), s10b);
ok("§10b: blockers are WAVE-RED tickets as in §10, and the gate does not open over them", /Blockers become `WAVE-RED` tickets exactly as §10/.test(s10b) && /gate does not open over a security blocker/.test(s10b), s10b);
ok("§10b: says the lead's instructions hold the gate and no hook enforces it yet", /lead's instructions hold the gate/.test(s10b) && /no hook enforces it yet/.test(s10b), s10b);
ok("§10b: no security path skips both modes with the logged line", /skipped/.test(s10b) && s10b.includes("`security-pass: skipped (no security path)` on the run log"), s10b);
const secv = read("agents", "proteus-security-verifier.md");
const modes = (/^## Milestone and close modes\n([\s\S]*?)\n## /m.exec(secv) || [])[1] || "";
ok("security verifier: milestone mode names its input and checks", /^- `milestone`: inputs .*milestone diff.*authorization on every new route.*I\/O.*abuse case/m.test(modes), modes);
ok("security verifier: close mode names its input and the scout-picked audit skill", /^- `close`: inputs .*whole repo with the audit skill the scout picked/m.test(modes), modes);
ok("security verifier: both modes answer WAVE-GREEN or WAVE-RED", /`WAVE-GREEN <run>` or `WAVE-RED <run> sent`/.test(modes), modes);
const flow = read("skills", "proteus", "references", "flow.md");
ok("flow.md points to §10b at the QA milestone pass and at close", /word `milestone`.*`proteus-security-verifier` in `milestone` mode.*§10b/.test(flow) && /word `close`.*`proteus-security-verifier` in `close` mode.*§10b/.test(flow));

// the prose points to --help for the scripts' flags, so --help must explain them and exit 0
const { spawnSync } = require("child_process");
ok("SKILL.md points to the scripts' --help for their flags", /--help/.test(skill));
const help = (name) => spawnSync(process.execPath, [path.join(ROOT, "templates", "hooks", `proteus-${name}.js`), "--help"], { encoding: "utf8", cwd: ROOT });
for (const [name, flags] of [["worktree", ["--tier", "--human"]], ["tier", ["--staged", "--ci"]], ["scratch", ["--path", "--sweep", "--all-done", "--stale", "--size"]], ["close-report", ["--no-cost", "--cost-json"]], ["status", ["[run]"]], ["ready", ["[run]", "speculative"]], ["gates-cache", ["<gate command>", "PROTEUS_GATES_CACHE"]], ["skillpath", ["<skill>", "PROTEUS_SKILL_DIRS"]], ["inbox", ["--refresh", "--count"]]]) {
  const r = help(name);
  ok(`proteus-${name}.js --help: exits 0 and explains ${flags.join(", ")}`, r.status === 0 && r.stdout.startsWith("usage: ") && r.stdout.split("\n").length > 2 && flags.every((f) => r.stdout.includes(f)), r.stdout + r.stderr);
}

summary();
