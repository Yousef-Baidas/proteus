// Principles block (#204): node tests/principles.test.js. The five lines under `### Principles` in roles.md sit
// word for word in every shipped agent file (and so in Codex's TOML roles), every non-code rubric in domains.md
// asks for nothing the brief did not, and stack.md runs ponytail full on Quick, lite on standard and hard.
// Temp HOME only; no network. Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("principles");

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const roles = read("skills", "proteus", "references", "roles.md");
const domains = read("skills", "proteus", "references", "domains.md");
const stack = read("skills", "proteus", "references", "stack.md");
const agents = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md")).sort();
const agent = (f) => read("agents", f);

const LINES = [
  "- the simplest thing that meets the contract;",
  "- no option, abstraction, file or dependency without a caller in this run;",
  "- one source of truth per fact or rule;",
  "- delete before you add;",
  "- leave the touched area no worse.",
];
const block = (/^### Principles\n((?:- .*\n?)+)/m.exec(roles) || [])[1] || "";
ok("roles.md: the Principles block is exactly the five lines of #204", block.trimEnd() === LINES.join("\n"), block);
const rule = block.trimEnd();
ok("roles.md: the block sits beside the script-first rule", roles.indexOf("### Principles") > roles.indexOf("- **Script first**") && roles.indexOf("- **Script first**") > 0);
for (const f of agents) ok(`agents: ${f} carries the Principles block word for word`, rule !== "" && agent(f).includes(rule));
// the mirror check catches a lost line: an agent body without the last one fails it
ok("mirror: an agent file that lost a line of the block fails the check", !agent(agents[0]).replace(LINES[4] + "\n", "").includes(rule));

// Codex: its roles are the agent bodies, so the block reaches Codex agents too
process.env.CODEX_HOME = path.join(W, "codex");
const cx = require(path.join(ROOT, "templates", "hooks", "proteus-harness-codex.js"));
for (const f of agents) {
  const toml = cx.agentFile(f, agent(f));
  if (!toml) continue;
  const body = JSON.parse(/^developer_instructions = (.*)$/m.exec(toml.text)[1]);
  ok(`codex: the ${f} role carries the Principles block`, body.includes(rule));
}

// no brief or agent tells a worker to favour craft over the fewest lines any more
for (const [name, text] of [["roles.md", roles], ...agents.map((f) => [f, agent(f)])]) ok(`${name}: no "fewest lines" wording against the block`, !/fewest lines/.test(text));

// domains.md: the block binds non-code teams, and every non-code rubric has the YAGNI line
ok("domains.md: says the Principles block applies to non-code teams", /Principles block in `roles\.md`[^.]*binds non-code teams too/.test(domains));
const rows = domains.split("\n").filter((l) => /^\| \S/.test(l) && !l.startsWith("| Domain") && !l.startsWith("| software"));
ok("domains.md: five non-code domain rows", rows.length === 5, rows.join("\n"));
for (const r of rows) {
  const cell = r.split("|")[5] || "";
  ok(`domains.md: the ${r.split("|")[1].trim()} rubric has "nothing the brief did not ask for"`, /nothing the brief did not ask for/i.test(cell), cell);
}

// stack.md: ponytail tiers
const pony = stack.split("\n").find((l) => l.startsWith("| ponytail |")) || "";
ok("stack.md: ponytail is full on Quick and mechanical tickets, lite on standard and hard", pony.split("|")[3].trim() === "full on Quick and mechanical tickets, lite on standard and hard", pony);

lib.summary();
