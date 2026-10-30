// Auto mode friendliness: node tests/automode.test.js. The standing rules in roles.md sit word for word in
// every shipped agent file (and so in Codex's TOML roles), the spawn briefs stay lean and free of guard talk,
// and install.js --doctor and the install message suggest an autoMode.environment entry only when none names
// Proteus and proteus-cli.js, without writing it. Temp HOME only; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run } = lib;
const W = lib.workdir("automode");

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const roles = read("skills", "proteus", "references", "roles.md");
const lines = roles.split("\n");
const agents = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md")).sort();
const agent = (f) => read("agents", f);
const words = (s) => s.split(/\s+/).filter(Boolean).length;
// the bullets right under a heading
const block = (head) => {
  const i = lines.findIndex((l) => l.startsWith(head));
  const out = [];
  for (let j = i + 1; j < lines.length; j++) { if (lines[j].startsWith("- ")) out.push(lines[j]); else if (out.length) break; }
  return out;
};
// a role's spawn template: the fenced block under its heading
const brief = (head) => { const m = new RegExp(`^## ${head}[^\\n]*\\n\`\`\`\\n([\\s\\S]*?)\`\`\``, "m").exec(roles); return m ? m[1] : ""; };

const shared = lines.filter((l) => /^- \*\*(Long jobs|Report once|Scratch|Classifier denial)\*\*/.test(l));
const denial = shared.find((l) => l.startsWith("- **Classifier denial**")) || "";
const workerRules = block("### Worker");
const verifierRules = block("### Verifier");
const workers = agents.filter((f) => f.endsWith("-worker.md"));
const verifiers = agents.filter((f) => f.endsWith("-verifier.md") && f !== "proteus-qa-verifier.md");

ok("roles.md: four shared rules, a worker block and a verifier block", shared.length === 4 && workerRules.length >= 8 && verifierRules.length >= 5, JSON.stringify([shared.length, workerRules.length, verifierRules.length]));
ok("roles.md: the denial rule names the BLOCKED classifier line and forbids the retry forms", /BLOCKED #<n> classifier <tag>: <action>/.test(denial) && /retry/.test(denial) && /reword/.test(denial) && /split/.test(denial));
for (const f of agents) ok(`agents: ${f} carries the classifier denial rule word for word`, agent(f).includes(denial));
for (const f of [...workers, ...verifiers]) {
  const missing = shared.filter((l) => !agent(f).includes(l));
  ok(`agents: ${f} carries the four shared rules word for word`, !missing.length, missing.join("\n"));
}
for (const f of workers) {
  const missing = workerRules.filter((l) => !agent(f).includes(l));
  ok(`agents: ${f} carries every worker rule moved out of the brief`, !missing.length, missing.join("\n"));
}
for (const f of verifiers) {
  const missing = verifierRules.filter((l) => !agent(f).includes(l));
  ok(`agents: ${f} carries every verifier rule moved out of the brief`, !missing.length, missing.join("\n"));
}

// Codex: its roles are the agent bodies, so the rules reach Codex workers too
process.env.CODEX_HOME = path.join(W, "codex");
const cx = require(path.join(ROOT, "templates", "hooks", "proteus-harness-codex.js"));
for (const f of [...workers, ...verifiers]) {
  const toml = cx.agentFile(f, agent(f));
  const body = toml ? JSON.parse(/^developer_instructions = (.*)$/m.exec(toml.text)[1]) : "";
  ok(`codex: the ${f} role carries the shared and role rules`, [...shared, ...(workers.includes(f) ? workerRules : verifierRules)].every((l) => body.includes(l)));
}

// the briefs: lean, ticket last, no guard or bypass talk
const worker = brief("Worker"), verifier = brief("Verifier"), contracts = brief("Contracts worker");
ok("brief: the worker brief is under 200 words", worker && words(worker) < 200, String(words(worker)));
ok("brief: the verifier brief is under 100 words", verifier && words(verifier) < 100, String(words(verifier)));
for (const [name, b] of [["worker", worker], ["verifier", verifier], ["contracts", contracts], ["direct", brief("Direct helper")]]) {
  ok(`brief: the ${name} brief has no guard or bypass talk`, Boolean(b) && !/--no-verify|bypass|refuse|permission/i.test(b), b);
  if (name !== "direct") ok(`brief: the ${name} brief does not paste the shared rules`, !/rules as above/.test(b), b);
}
for (const l of [...workerRules, ...verifierRules]) {
  const key = l.slice(2, 60);
  ok(`brief: a standing rule is not repeated in a brief (${key.slice(0, 30)}…)`, !worker.includes(key) && !verifier.includes(key));
}
const at = (s) => worker.indexOf(s);
ok("brief: the worker brief runs shared to specific, report last (prompt cache)",
  at("Hooks:") === 0 && at("Hooks:") < at("Gates:") && at("Gates:") < at("Team <team>") && at("Team <team>") < at("Ticket #<n>") && at("Ticket #<n>") < at("You own:") && /\nDone → [^\n]*\n$/.test(worker), worker);
ok("roles.md: the prompt-cache ordering rule is kept", /Order a brief from shared to specific/.test(roles) && /A prompt cache reuses only an identical prefix/.test(roles));
const lead = read("skills", "proteus", "SKILL.md"), ops = read("skills", "proteus", "references", "operations.md");
ok("SKILL.md: the lead's denial rule (one line to the human, no re-spawn)", /\*\*Auto mode denial\*\*/.test(lead) && /reason tag/.test(lead) && /don't re-spawn/.test(lead));
ok("operations.md: a classifier-blocked agent is not re-dispatched as a stall", /STALL-AGAIN[^\n]*classifier[^\n]*dispatch nothing/.test(ops));

// install.js: the auto mode hint, Claude Code only, and never written
const INST = path.join(ROOT, "install.js");
const home = (name, settings) => {
  const h = path.join(W, name);
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  if (settings) fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  return h;
};
const cwd = path.join(W, "plain"); fs.mkdirSync(cwd);
const settings = (h) => fs.readFileSync(path.join(h, ".claude", "settings.json"), "utf8");
const HINT = /WARN\s+auto mode: no autoMode\.environment entry/;

let h = home("none", { theme: "dark" });
let before = settings(h);
let r = run(INST, "", { cwd, env: lib.homeEnv(h), args: ["--doctor"] });
ok("doctor: no autoMode block → the hint, with $defaults, the Proteus entry and where to add it", HINT.test(r.out) && r.out.includes("\"$defaults\"") && /Proteus is my own multi-agent tooling/.test(r.out) &&
  /\/auto-mode-setup/.test(r.out) && /\/permissions → Auto mode/.test(r.out), r.out);
const entry = (/"(Proteus is my own[^"]*)"/.exec(r.out) || [])[1];
ok("docs/install.md: documents the same entry the doctor prints", Boolean(entry) && read("docs/install.md").includes(`"${entry}"`), entry);
ok("doctor: the hint is a WARN, not a FIX", !/FIX\s+auto mode/.test(r.out), r.out);
ok("doctor: settings.json is left as it was", settings(h) === before);

h = home("other", { autoMode: { environment: ["$defaults", "Source control: github.example.com/acme"] } });
r = run(INST, "", { cwd, env: lib.homeEnv(h), args: ["--doctor"] });
ok("doctor: entries that do not name Proteus → the hint", HINT.test(r.out), r.out);

ok("doctor: the hint's entry names proteus-cli.js and keeps next's merges to proteus/<run>", /proteus-cli\.js next/.test(entry) && /proteus\/<run> run branches only/.test(entry) && /never into the default branch/.test(entry), entry);

const OLD = /WARN\s+auto mode entry predates proteus-cli\.js; `next`'s merges may be blocked/;
h = home("old", { autoMode: { environment: ["$defaults", "Proteus multi-agent runs are mine"] } });
before = settings(h);
r = run(INST, "", { cwd, env: lib.homeEnv(h), args: ["--doctor"] });
ok("doctor: an entry naming Proteus without proteus-cli.js → WARN predates, with the hint", OLD.test(r.out) && !HINT.test(r.out) && r.out.includes("\"$defaults\"") && /proteus-cli\.js next/.test(r.out), r.out);
ok("doctor: settings.json with the old entry is left as it was", settings(h) === before);

const CURRENT = "Proteus runs are mine, and node .claude/hooks/proteus-cli.js is my own script";
h = home("has", { autoMode: { environment: ["$defaults", CURRENT] } });
before = settings(h);
r = run(INST, "", { cwd, env: lib.homeEnv(h), args: ["--doctor"] });
ok("doctor: an entry naming Proteus and proteus-cli.js → ok, no hint", /ok\s+auto mode: autoMode\.environment describes Proteus/.test(r.out) && !HINT.test(r.out) && !OLD.test(r.out) && !r.out.includes("\"$defaults\""), r.out);
ok("doctor: settings.json with the entry is left as it was", settings(h) === before);

h = home("codex", { theme: "dark" });
r = run(INST, "", { cwd, env: { ...lib.homeEnv(h), PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(h, ".codex") }, args: ["--doctor"] });
ok("doctor: Codex gets no auto mode row", !/auto mode/.test(r.out), r.out);

h = home("install-none", { theme: "dark" });
r = run(INST, "", { cwd, env: lib.homeEnv(h) });
ok("install: the closing message suggests the entry when none names Proteus", /Auto mode: its classifier may block Proteus worker spawns/.test(r.out) && r.out.includes("\"$defaults\""), r.out + r.err);
ok("install: no autoMode block is written", !("autoMode" in JSON.parse(settings(h))), settings(h));
h = home("install-old", { autoMode: { environment: ["$defaults", "Proteus multi-agent runs are mine"] } });
r = run(INST, "", { cwd, env: lib.homeEnv(h) });
ok("install: the closing message suggests the entry when the Proteus one predates proteus-cli.js", /Auto mode: its classifier/.test(r.out) && /proteus-cli\.js next/.test(r.out), r.out + r.err);
ok("install: the old autoMode block is kept as it was", JSON.stringify(JSON.parse(settings(h)).autoMode) === JSON.stringify({ environment: ["$defaults", "Proteus multi-agent runs are mine"] }));
h = home("install-has", { autoMode: { environment: ["$defaults", CURRENT] } });
r = run(INST, "", { cwd, env: lib.homeEnv(h) });
ok("install: no auto mode note when an entry names Proteus and proteus-cli.js", !/Auto mode:/.test(r.out), r.out);
ok("install: the user's autoMode block is kept as it was", JSON.stringify(JSON.parse(settings(h)).autoMode) === JSON.stringify({ environment: ["$defaults", CURRENT] }));

lib.summary();
