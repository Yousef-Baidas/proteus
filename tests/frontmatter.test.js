// frontmatter.test.js: every git-tracked *.md that opens with a --- block must have valid YAML frontmatter.
// No YAML library is a dependency, so this models the subset the shipped files use: top-level `key: value`,
// indented block scalars (>-, |), indented `- item` lists, "double" or 'single' quoted values, and [a, b] flow
// lists. A plain value containing ": " or " #", or starting with a YAML indicator, is flagged (that is what
// made the proteus skill's frontmatter invalid and silently dropped). node tests/frontmatter.test.js
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;

// Returns a list of problems (empty when the frontmatter is valid in the modelled subset).
function plainProblem(v) {
  if (/^[[\]{},&*!|>'"%@`#]/.test(v) || /^[?:-](\s|$)/.test(v)) return `plain value starts with an indicator: ${v}`;
  if (v.includes(": ") || v.endsWith(":")) return `plain value contains ": ": ${v}`;
  if (/\s#/.test(v)) return `plain value contains " #": ${v}`;
  return null;
}
function scalarProblems(v) {
  if (v === "") return [];
  if (/^[>|][+-]?\d*$/.test(v)) return [];
  if (v[0] === '"') return /^"(?:[^"\\]|\\.)*"$/.test(v) ? [] : [`bad double-quoted value: ${v}`];
  if (v[0] === "'") return /^'(?:[^']|'')*'$/.test(v) ? [] : [`bad single-quoted value: ${v}`];
  if (v[0] === "[") {
    if (!v.endsWith("]")) return [`unterminated flow list: ${v}`];
    return v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean).map(s => /^["']/.test(s) ? scalarProblems(s)[0] : plainProblem(s)).filter(Boolean);
  }
  const p = plainProblem(v);
  return p ? [p] : [];
}
function check(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return ["frontmatter is never closed"];
  const bad = [];
  let block = false; // inside a block scalar or list: indented lines are continuation
  for (const [i, line] of lines.slice(1, end).entries()) {
    const n = i + 2;
    if (line.trim() === "" || line.trimStart().startsWith("#") && !line.startsWith(" ")) continue;
    if (/^\s/.test(line)) {
      if (!block) { bad.push(`line ${n}: unexpected indentation`); continue; }
      const m = line.match(/^\s+-\s+(.*)$/);
      if (m && block === "list") bad.push(...scalarProblems(m[1].trim()).map(p => `line ${n}: ${p}`));
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/);
    if (!m) { bad.push(`line ${n}: not a "key: value" line: ${line}`); continue; }
    const v = (m[2] || "").trim();
    block = /^[>|]/.test(v) ? "scalar" : v === "" ? "list" : false;
    bad.push(...scalarProblems(v).map(p => `line ${n}: ${p}`));
  }
  return bad;
}

const fm = (body) => `---\n${body}\n---\nbody\n`;
ok("frontmatter: checker rejects a plain description with ': '", check(fm("name: x\ndescription: a team of agents: software")).length === 1);
ok("frontmatter: checker rejects ' #' and a leading indicator", check(fm("a: b #c")).length === 1 && check(fm("a: *x")).length === 1);
ok("frontmatter: checker accepts a block scalar and a quoted colon",
  check(fm("name: x\ndescription: >-\n  a team of agents: software, more\nnote: \"a: b\"\ntools: [Read, Grep]\nl:\n  - Read\n  - mcp__x__*")).length === 0);

const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const checked = [];
for (const f of files) {
  const bad = check(require("fs").readFileSync(path.join(ROOT, f), "utf8"));
  if (bad === null) continue;
  checked.push(f);
  ok(`frontmatter: ${f} is valid`, bad.length === 0, bad.join("; "));
}
ok("frontmatter: skills/proteus/SKILL.md was checked", checked.includes("skills/proteus/SKILL.md"));
lib.summary();
