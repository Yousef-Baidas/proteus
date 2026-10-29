// Worker tool surface tests: node tests/workertools.test.js (#206). Every shipped worker agent withholds the
// interactive and scheduling tools a ticket run never calls, through disallowedTools, and keeps no tools allowlist
// (workers get every other tool, MCP servers included). Reads agents/ only.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;

const REQUIRED = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "CronCreate", "CronDelete", "CronList",
  "ScheduleWakeup", "RemoteTrigger"];
const KEPT = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "ToolSearch", "WebFetch", "WebSearch", "Skill"];

// a frontmatter list field (block `- x` or inline `a, b` / `[a, b]`); null when the field is absent
function listField(text, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return null;
  const inline = lines[i].slice(key.length + 1).trim().replace(/^\[|\]$/g, "");
  const block = [];
  for (const l of lines.slice(i + 1)) { const b = /^\s+-\s*(.+?)\s*$/.exec(l); if (!b) break; block.push(b[1]); }
  return [...(inline ? inline.split(",") : []), ...block].flatMap((t) => { const v = t.trim().replace(/^(["'])(.*)\1$/, "$2"); return v ? [v] : []; });
}

const workers = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => /^proteus-(?:[\w-]+-)?worker\.md$/.test(f)).sort();
ok("worker tools: the generic and the three software workers ship", ["proteus-backend-worker.md", "proteus-devops-worker.md",
  "proteus-frontend-worker.md", "proteus-worker.md"].every((f) => workers.includes(f)), workers.join(" "));

for (const f of workers) {
  const text = fs.readFileSync(path.join(ROOT, "agents", f), "utf8");
  const denied = listField(text, "disallowedTools");
  const missing = REQUIRED.filter((t) => !(denied || []).includes(t));
  ok(`worker tools: ${f} withholds the plan, question and scheduling tools`, denied && !missing.length, missing.join(" "));
  const kept = KEPT.filter((t) => (denied || []).includes(t));
  ok(`worker tools: ${f} keeps the tools a ticket needs, context-mode included`,
    !kept.length && !(denied || []).some((t) => t.startsWith("mcp__")), kept.join(" "));
  ok(`worker tools: ${f} has no tools allowlist (agent patches refuse tools for workers)`, listField(text, "tools") === null);
}

lib.summary();
