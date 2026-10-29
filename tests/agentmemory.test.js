// Agent memory tests: node tests/agentmemory.test.js (needs git). A `memory: local` agent keeps its notes in
// <lead's checkout>/.claude/agent-memory-local/<its type>/ (#181). While a run is open the lead guard lets a
// subagent write its own dir there (lib.ownMemory) and nothing else under .claude/; the lead, another agent's
// dir and a path a link moves elsewhere stay refused. Temp repo; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("agentmemory");
const hl = require(path.join(SRC, "proteus-lib.js"));

// ---- MEMORY_LOCAL is the agents that declare memory: local
const declared = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md"))
  .filter((f) => /^memory:\s*local\s*$/m.test(fs.readFileSync(path.join(ROOT, "agents", f), "utf8").split(/^---\s*$/m)[1] || ""))
  .map((f) => f.slice(0, -3)).sort();
ok("MEMORY_LOCAL: the agents whose frontmatter says memory: local", JSON.stringify([...hl.MEMORY_LOCAL].sort()) === JSON.stringify(declared), JSON.stringify(declared));

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "branch", "proteus/r1"); // a run is open: the main checkout is no subagent's
const LG = path.join(SRC, "proteus-lead-guard.js");
const run = (input, extra = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, ...input, ...extra }, { cwd: REPO });
const as = (type, id = "a1") => ({ agent_id: id, agent_type: type });
const MEM = path.join(REPO, ".claude", "agent-memory-local");
const write = (file, who) => run({ tool_name: "Write", tool_input: { file_path: file, content: "x" } }, who);
const edit = (file, who) => run({ tool_name: "Edit", tool_input: { file_path: file, old_string: "a", new_string: "b" } }, who);
const FE = path.join(MEM, "proteus-frontend-verifier", "recurring-findings.md");

let r = write(FE, as("proteus-frontend-verifier"));
ok("memory: a verifier writes its own .claude/agent-memory-local/<type>/ file during a run", r.code === 0, r.err);
r = edit(path.join(MEM, "proteus-frontend-verifier", "notes", "deep.md"), as("proteus-frontend-verifier"));
ok("memory: and edits deeper in it", r.code === 0, r.err);
r = write(path.join(MEM, "proteus-proteus-frontend-verifier", "MEMORY.md"), as("proteus:proteus-frontend-verifier"));
ok("memory: a plugin agent writes the dir Claude Code names after proteus:<agent>", r.code === 0, r.err);
r = write(FE, as("proteus:proteus-frontend-verifier"));
ok("memory: and the bare-name dir", r.code === 0, r.err);
r = write(path.join(MEM, "proteus-guide", "MEMORY.md"), as("proteus-guide"));
ok("memory: the guide (memory: local) writes its own", r.code === 0, r.err);

for (const f of [path.join(REPO, ".claude", "settings.json"), path.join(REPO, ".claude", "hooks", "x.js"), path.join(REPO, ".claude", "skills", "s", "SKILL.md")]) {
  r = write(f, as("proteus-frontend-verifier"));
  ok(`memory: the verifier's Write to ${path.relative(REPO, f).replace(/\\/g, "/")} is still refused`, r.code === 2, r.err);
}
r = write(path.join(MEM, "proteus-backend-verifier", "MEMORY.md"), as("proteus-frontend-verifier"));
ok("memory: one agent writing another agent's memory dir is refused", r.code === 2 && /main checkout while a run is open/.test(r.err), r.err);
r = write(path.join(MEM, "MEMORY.md"), as("proteus-frontend-verifier"));
ok("memory: the memory root itself is refused", r.code === 2, r.err);
r = write(path.join(REPO, ".claude", "agent-memory", "proteus-frontend-verifier", "MEMORY.md"), as("proteus-frontend-verifier"));
ok("memory: the project scope (.claude/agent-memory) is not covered", r.code === 2, r.err);
r = write(path.join(MEM, "proteus-worker", "MEMORY.md"), as("proteus-worker"));
ok("memory: an agent that declares no memory: local is refused its dir", r.code === 2, r.err);
r = write(path.join(MEM, "evil-proteus-frontend-verifier", "MEMORY.md"), as("evil:proteus-frontend-verifier"));
ok("memory: another plugin's agent under a Proteus name is refused", r.code === 2, r.err);
r = write(FE, as("evil:proteus-frontend-verifier"));
ok("memory: and refused the Proteus agent's dir", r.code === 2, r.err);
r = write(FE, {});
ok("memory: the lead's own Write there is refused", r.code === 2 && /the lead does not edit/.test(r.err), r.err);

// a named spawn writes the dir of its subagent_type, never of the name it was given
{
  const TP = path.join(W, "opus-lead.jsonl");
  fs.writeFileSync(TP, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1000 } } }) + "\n");
  r = run({ tool_name: "Agent", transcript_path: TP, tool_input: { model: "sonnet", subagent_type: "proteus:proteus-qa-verifier", name: "qa-3", prompt: "x" } });
  ok("memory: the lead's named spawn passes", r.code === 0, r.err);
  r = write(path.join(MEM, "proteus-qa-verifier", "MEMORY.md"), as("qa-3"));
  ok("memory: a named verifier writes its type's dir", r.code === 0, r.err);
  r = write(path.join(MEM, "qa-3", "MEMORY.md"), as("qa-3"));
  ok("memory: but not a dir named after its spawn name", r.code === 2, r.err);
}

// links: neither the target nor a dir on the way may move the write elsewhere
const OUT = path.join(W, "outside");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(REPO, ".claude", "hooks"), { recursive: true });
let linked = true;
try {
  fs.mkdirSync(path.join(MEM, "proteus-verifier"), { recursive: true });
  fs.symlinkSync(path.join(REPO, ".claude", "hooks"), path.join(MEM, "proteus-verifier", "sub"), process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(OUT, path.join(MEM, "proteus-security-verifier"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(OUT, "f.md"), "a");
  fs.symlinkSync(path.join(OUT, "f.md"), path.join(MEM, "proteus-verifier", "link.md"));
} catch { linked = false; }
if (linked) {
  r = write(path.join(MEM, "proteus-verifier", "sub", "x.js"), as("proteus-verifier"));
  ok("memory: a linked dir inside it that leads to .claude/hooks is refused", r.code === 2, r.err);
  r = write(path.join(MEM, "proteus-security-verifier", "MEMORY.md"), as("proteus-security-verifier"));
  ok("memory: its own dir as a link out of the repo is refused", r.code === 2, r.err);
  r = write(path.join(MEM, "proteus-verifier", "link.md"), as("proteus-verifier"));
  ok("memory: a file that is a link is refused", r.code === 2, r.err);
} else ok("memory: link cases skipped (no symlink rights here)", true);

g(REPO, "branch", "-D", "proteus/r1");
lib.summary();
