// Script-first rule (#190): node tests/scriptfirst.test.js. The rule in roles.md sits word for word in every
// shipped agent file (and so in Codex's TOML roles), flow.md names its trigger and run-log line, and a fixture
// run log turns the second occurrence of a procedure into that line. Temp HOME only; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("scriptfirst");

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const roles = read("skills", "proteus", "references", "roles.md");
const flow = read("skills", "proteus", "references", "flow.md");
const agents = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md")).sort();
const agent = (f) => read("agents", f);

const rule = roles.split("\n").find((l) => l.startsWith("- **Script first**")) || "";
ok("roles.md: the script-first rule names the program, its home, --help and an exit code", /run twice/.test(rule) && /becomes a ticket for a program/.test(rule) &&
  /`scripts\/`/.test(rule) && /`teams\/<team>\/bin\/`/.test(rule) && /`--help` and an exit code/.test(rule), rule);
ok("roles.md: briefs call the program; only the ambiguous step stays with a model, writing a file the program reads",
  /briefs call the program/.test(rule) && /Only the ambiguous step stays with a model/.test(rule) && /a file the program reads/.test(rule), rule);
ok("roles.md: the verifier rejects a brief or skill that is a program in English", /verifier rejects a brief or skill that is a program in English: steps with no judgment/.test(rule), rule);
for (const f of agents) ok(`agents: ${f} carries the script-first rule word for word`, agent(f).includes(rule));

// Codex: its roles are the agent bodies, so the rule reaches Codex agents too
process.env.CODEX_HOME = path.join(W, "codex");
const cx = require(path.join(ROOT, "templates", "hooks", "proteus-harness-codex.js"));
for (const f of agents) {
  const toml = cx.agentFile(f, agent(f));
  if (!toml) continue;
  const body = JSON.parse(/^developer_instructions = (.*)$/m.exec(toml.text)[1]);
  ok(`codex: the ${f} role carries the script-first rule`, body.includes(rule));
}

// flow.md: the trigger and the run-log line
const para = flow.split("\n").find((l) => l.startsWith("Script first")) || "";
ok("flow.md: names the trigger, the second occurrence", /second occurrence/.test(para), para);
const tpl = (/on the run log as `(script-ticket: [^`]+)`/.exec(para) || [])[1] || "";
ok("flow.md: logs it on the run log as script-ticket: <procedure> #<n>", tpl === "script-ticket: <procedure> #<n>", tpl);
// the line's format, taken from flow.md's text
const LINE = new RegExp("^- " + tpl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("<procedure>", "(.+?)").replace("<n>", "(\\d+)") + "$");

// fixture run: two hand runs of the release checklist, then the ticket, then briefs call the program
const log = read("tests", "fixtures", "run-log-script-first.md").split("\n").filter((l) => l.startsWith("- "));
const at = log.findIndex((l) => LINE.test(l));
const [, proc, n] = at < 0 ? [] : LINE.exec(log[at]);
const runs = log.slice(0, at).filter((l) => / brief: /.test(l) && l.includes(proc));
ok("fixture: one script-ticket line, in flow.md's format", at > 0 && log.filter((l) => LINE.test(l)).length === 1, log.join("\n"));
ok("fixture: the ticket follows the second occurrence, not the first or a third", runs.length === 2 && log.indexOf(runs[1]) === at - 1, JSON.stringify(runs));
ok("fixture: the ticket's number is a new ticket, owning a program in scripts/", !log.slice(0, at).some((l) => l.includes(`#${n}`)) && log.some((l) => l.startsWith(`- #${n} owned: scripts/`) && /--help/.test(l)));
const after = log.slice(at + 1).filter((l) => / brief: /.test(l));
ok("fixture: later briefs call the program instead of the procedure in English", after.length > 0 && after.every((l) => !l.includes(proc) && /node scripts\/release\.js/.test(l) && /a file|`notes\.md`/.test(l)), after.join("\n"));

lib.summary();
