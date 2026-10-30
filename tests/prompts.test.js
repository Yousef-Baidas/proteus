// Prompt contract tests: node tests/prompts.test.js. Reads the shipped skill, roles and worker agents and
// checks the rules that split exploration from the approved pipeline: the lead may add steps only before
// the spec is approved, ponytail is full on Quick and mechanical tickets and lite on the rest, and the verifier does not count
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

const start = (/^## Session start\n[\s\S]*?(?=\n## )/m.exec(skill) || [""])[0];
ok("session start: no proteus-state line means no hand-run autostart; send the human to setup and a new session", /No `proteus-state` line[^\n]*never run `proteus-autostart\.js` by hand/.test(start) && /no `CLAUDE_ENV_FILE`[^\n]*post as the human/.test(start) && /`\/proteus:setup`[^\n]*new session; stop/.test(start), start);

const worker = block("Worker");
ok("worker prompt: ponytail is not unconditional", !/Ponytail full\.\s*$/m.test(worker.split("\n").find((l) => l.startsWith("Long jobs")) || ""), worker);
ok("worker prompt: ponytail full on Quick or mechanical tickets, lite on standard and hard", /<Quick or mechanical: Ponytail full[^>]*\| standard or hard: Ponytail lite;[^>]*the design is yours[^>]*>/.test(worker) && !/fewest lines/.test(worker), worker);
ok("worker prompt: no IDEA report line", !/IDEA/.test(worker));

for (const f of fs.readdirSync(path.join(ROOT, "agents")).filter((n) => /^proteus-(\w+-)?verifier\.md$/.test(n) && n !== "proteus-qa-verifier.md")) {
  const a = read("agents", f);
  ok(`${f}: helpers and tests inside owned paths are not extras`, /not extras/.test(a) && !/nothing extra\)/.test(a));
}

for (const f of fs.readdirSync(path.join(ROOT, "agents")).filter((n) => /^proteus-(\w+-)?worker\.md$/.test(n))) {
  const a = read("agents", f);
  ok(`${f}: the design inside the contract is the worker's; ponytail full on Quick and mechanical, lite on standard and hard`, /the design is yours/.test(a) && /Ponytail full on Quick and mechanical tickets, lite on `standard` and `hard`/.test(a) && !/fewest lines/.test(a));
}

// #203: authorization in one place; no verifier fixture harness exists, so the text is the contract
const authz = ["Authorization lives in one module, the one `CONVENTIONS.md` names: the single source of truth, field-level rules included", "Every handler or service call goes through it", "Query filters are derived from it, not copied"];
for (const team of ["backend", "security"]) {
  const p = read("templates", "teams", team, "PROFILE.md");
  ok(`${team} PROFILE.md: the three authorization rules`, authz.every((r) => p.includes(`- ${r}`)), p);
  ok(`${team} PROFILE.md: the verifier fails an inline permission check, quoting the rule`, /new inline permission check outside the authorization module is `BACK-TO-WORKER` quoting the rule/.test(p), p);
}
ok("conventions interview asks where the authorization module is", /^ {3}- authorization: the path of the one module/m.test(read("skills", "proteus", "references", "conventions.md")));

// #195: the refactor checkpoint in flow.md step 1
const flow = read("skills", "proteus", "references", "flow.md");
const step1 = (/^## 1\. [\s\S]*?(?=^## 2\. )/m.exec(flow) || [""])[0];
const checkpoint = (/^### Refactor checkpoint\n[\s\S]*/m.exec(step1) || [""])[0];
ok("flow.md step 1 has the refactor checkpoint", checkpoint !== "", step1);
ok("refactor checkpoint: Standard and Full only, Direct and Quick skip it", /Standard and Full only; Direct and Quick skip it/.test(checkpoint), checkpoint);
ok("refactor checkpoint: a helper scans with the §10 skill, at most three candidates", /`helper`/.test(checkpoint) && /improve-codebase-architecture/.test(checkpoint) && /§10/.test(checkpoint) && /at most three refactor candidates/.test(checkpoint), checkpoint);
ok("refactor checkpoint: no candidates, no question", /No candidates → no question/.test(checkpoint), checkpoint);
ok("refactor checkpoint: one picker with refactor first, defer to debt, ignore", /one picker question with three options: \*\*refactor first\*\*[^\n]*prep milestone[^\n]*\*\*defer to debt\*\*[^\n]*debt issue[^\n]*\*\*ignore\*\*/.test(checkpoint), checkpoint);
ok("refactor checkpoint: the answer is a run-log line", /run log as `refactor-checkpoint: <first\|defer\|ignore\|none>`/.test(checkpoint), checkpoint);
ok("enforcement.md §10 points to the refactor checkpoint", /refactor checkpoint in `flow\.md` step 1/.test((/^## 10\. [\s\S]*?(?=^## 11\. )/m.exec(read("skills", "proteus", "references", "enforcement.md")) || [""])[0]));

// #200: security pass per milestone and audit at close; the lead's instructions hold the gate, so the text is the contract
const enf = read("skills", "proteus", "references", "enforcement.md");
const s10b = (/^## 10b\. Security pass per milestone and audit at close\n([\s\S]*?)\n## /m.exec(enf) || [])[1] || "";
ok("enforcement.md §10b sits right after §10", /^## 10\. [^\n]*\n(?:(?!## )[^\n]*\n)*## 10b\. /m.test(enf), s10b);
ok("§10b: milestone mode on the milestone diff checks authz, input reaching I/O and the abuse cases", /`milestone`/.test(s10b) && /milestone diff/.test(s10b) && /authorization on every new route/.test(s10b) && /input that reaches .*I\/O/.test(s10b) && /abuse cases/.test(s10b), s10b);
ok("§10b: close mode audits the whole repo with the scout-picked audit skill", /`close` over the whole repo/.test(s10b) && /audit skill the scout picked/.test(s10b), s10b);
ok("§10b: blockers are WAVE-RED tickets as in §10, and the gate does not open over them", /Blockers become `WAVE-RED` tickets exactly as §10/.test(s10b) && /gate does not open over a security blocker/.test(s10b), s10b);
ok("§10b: names the hook that holds the gate (#254)", /`proteus-lead-guard\.js` holds the gate/.test(s10b) && /`proteus-verdict\.js` counts no `ACCEPT` or `AUTO-ACCEPT`/.test(s10b) && !/no hook enforces/.test(s10b), s10b);
ok("§10b: no security path skips both modes with the logged line", /skipped/.test(s10b) && s10b.includes("`security-pass: skipped (no security path)` on the run log"), s10b);
const secv = read("agents", "proteus-security-verifier.md");
const modes = (/^## Milestone and close modes\n([\s\S]*?)\n## /m.exec(secv) || [])[1] || "";
ok("security verifier: milestone mode names its input and checks", /^- `milestone`: inputs .*milestone diff.*authorization on every new route.*I\/O.*abuse case/m.test(modes), modes);
ok("security verifier: close mode names its input and the scout-picked audit skill", /^- `close`: inputs .*whole repo with the audit skill the scout picked/m.test(modes), modes);
ok("security verifier: both modes answer WAVE-GREEN or WAVE-RED", /`WAVE-GREEN <run>` or `WAVE-RED <run> sent`/.test(modes), modes);
ok("flow.md points to §10b at the QA milestone pass and at close", /word `milestone`.*`proteus-security-verifier` in `milestone` mode.*§10b/.test(flow) && /word `close`.*`proteus-security-verifier` in `close` mode.*§10b/.test(flow));

// lefthook install writes the shared git hooks, which agents may not do (#269): workers prove the hook, the human installs it
const boot = read("skills", "proteus", "references", "bootstrap.md");
const sec3 = (/^## 3\. lefthook[^\n]*\n[\s\S]*?(?=\n## )/m.exec(enf) || [""])[0];
ok("scaffold: the worker proves commit-msg with lefthook run on a bad and a good message", /`lefthook run commit-msg <file>` fails on a bad message and passes a good one/.test(sec3), sec3);
ok("scaffold: no instruction tells a worker to run lefthook install", /Never `lefthook install`/.test(sec3) && !/fill the `EDIT` lines, `lefthook install`/.test(sec3), sec3);
ok("bootstrap: the lead tells the human once to run lefthook install after the scaffold or stabilise merge", /After the merge \(scaffold or stabilise\), tell the human once, in one line: run `lefthook install` in the main checkout[^\n]*never the lead's or a worker's/.test(boot), boot);

// the prose points to --help for the scripts' flags, so --help must explain them and exit 0
const { spawnSync } = require("child_process");
ok("SKILL.md points to the scripts' --help for their flags", /--help/.test(skill));
const help = (name) => spawnSync(process.execPath, [path.join(ROOT, "templates", "hooks", `proteus-${name}.js`), "--help"], { encoding: "utf8", cwd: ROOT });
for (const [name, flags] of [["worktree", ["--tier", "--human"]], ["tier", ["--staged", "--ci"]], ["scratch", ["--path", "--sweep", "--all-done", "--stale", "--size"]], ["close-report", ["--no-cost", "--cost-json"]], ["status", ["[run]"]], ["ready", ["[run]", "speculative"]], ["gates-cache", ["<gate command>", "PROTEUS_GATES_CACHE"]], ["skillpath", ["<skill>", "PROTEUS_SKILL_DIRS"]], ["inbox", ["--refresh", "--count"]]]) {
  const r = help(name);
  ok(`proteus-${name}.js --help: exits 0 and explains ${flags.join(", ")}`, r.status === 0 && r.stdout.startsWith("usage: ") && r.stdout.split("\n").length > 2 && flags.every((f) => r.stdout.includes(f)), r.stdout + r.stderr);
}

// #278: a red contract commit cannot pass the pre-push hook, so it stays local
const contracts = block("Contracts worker[^\\n]*");
ok("contracts worker brief: commits the contract and says not to push", /Do not push/.test(contracts) && !/git push/.test(contracts), contracts);
ok("flow.md: the contracts worker does not push; the commit reaches origin with the worker's first green push", /It does not push[^\n]*first green push/.test(read("skills", "proteus", "references", "flow.md")));
// milestone QA has a fixed bar (#280)
{
  const flow = read("skills", "proteus", "references", "flow.md");
  const review = read("skills", "proteus", "references", "review.md");
  const qaAgent = read("agents", "proteus-qa-verifier.md");
  const qa = block("QA \\(wave \\| milestone \\| close\\)");
  ok("QA prompt: a recheck mode checks the listed items plus the suite and CI", /`recheck`/.test(qa) && /only those items plus the suite and CI/.test(qa), qa);
  ok("QA prompt: a recheck may not widen the sample", /Do not widen: no new hand-mutant sample, no extra files/.test(qa), qa);
  ok("QA prompt: a finding outside the list goes to debt, never WAVE-RED", /outside the list goes to the debt issue[^\n]*never `WAVE-RED`/.test(qa), qa);
  ok("qa verifier agent: knows recheck, no widening, new findings to debt", /`recheck`/.test(qaAgent) && /never widen the sample/.test(qaAgent) && /outside the list to the debt issue, never `WAVE-RED`/.test(qaAgent), qaAgent);
  ok("flow: the first pass sets the QA list and there is at most one fix cycle", /first milestone QA pass sets a fixed bar/.test(flow) && /one list, the milestone's QA list/.test(flow) && /At most one fix cycle per milestone/.test(flow), flow);
  ok("flow: a still-red recheck opens the gate with the open items first, the human decides", /opens the review gate with the open items first[^.]*the human decides/.test(flow), flow);
  ok("flow: non-blocker security findings follow the rule, a security blocker still blocks", /same rule for non-blockers; a security blocker still blocks/.test(flow), flow);
  ok("review: the gate opens over a red recheck with the open items first", /After one fix cycle with a listed QA item still red[^\n]*opens anyway[^\n]*first/.test(review), review);
}

// The loop (#79): every line kind `next`, `result` or `brief` can print has a row in SKILL.md's loop table,
// so the lead never meets a line the skill does not say how to handle.
{
  const cli = read("templates", "hooks", "proteus-cli.js");
  const kinds = new Set([...cli.matchAll(/kind: "([A-Z]+)"|case "([A-Z]+)"|out: \[`([A-Z]+) /g)].map((m) => m[1] || m[2] || m[3]));
  const loop = (/^## The loop\n[\s\S]*?(?=\n## )/m.exec(skill) || [""])[0];
  const rows = new Set([...loop.matchAll(/^\| `([A-Z]+)` \|/gm)].map((m) => m[1]));
  const known = ["ASK", "STOP", "NUDGE", "MERGE", "MERGED", "RUN", "DECIDE", "SPAWN", "PROMPT", "BLOCKED", "WAIT"];
  ok("loop: every known line kind is found in proteus-cli.js", known.every((k) => kinds.has(k)), [...kinds].join(" "));
  const missing = [...kinds].filter((k) => !rows.has(k));
  ok("loop: every line kind proteus-cli.js prints has a row in SKILL.md's loop table", missing.length === 0, missing.join(" "));
}

summary();
