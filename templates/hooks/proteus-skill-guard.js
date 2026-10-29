#!/usr/bin/env node
// PreToolUse hook on Skill, registered only by the sandbox profile (install.js --sandbox) and run from its copy in
// <claudeDir>/proteus-sandbox/bin/<key>, which no agent can write (#212 B9). Claude Code loads a skill from any
// <dir>/.claude/skills/<name>/SKILL.md in the project and runs the hooks: in its frontmatter outside the sandbox. The
// profile denies writes to the root's and the guest dir's .claude/ by a rule Linux honours, but a nested .claude/ only
// by a mid-path rule bwrap ignores. So a skill is refused while a <dir>/.claude/skills/<name>/SKILL.md for its name
// (any plugin: prefix stripped) exists anywhere in the profile's allowWrite other than those two.
// The scan skips node_modules and .git, goes MAX_DEPTH dirs down and reads MAX_ENTRIES entries at most; an error or a
// cap refuses. No profile (no sandbox-root.json beside this copy, or no file where it names one): nothing to guard.
// Exit 2 = block; the message on stderr reaches the model as the tool's error. Anything that goes wrong blocks too.
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_DEPTH = 8, MAX_ENTRIES = 50000;
const SKIP = new Set(["node_modules", ".git"]);

const refuse = (why) => { process.stderr.write(`proteus-skill-guard: skill refused: ${why}\n`); process.exit(2); };

// the profile's allowWrite, or null when there is no profile; { pin, writes }
function profile(dir) {
  const pinFile = path.join(dir, "sandbox-root.json");
  if (!fs.existsSync(pinFile)) return null;
  const lib = require(path.join(dir, "proteus-lib.js"));
  const pin = JSON.parse(lib.readUntrusted(pinFile));
  if (!pin || typeof pin.profile !== "string" || !pin.profile) throw new Error(`${pinFile} names no profile`);
  let text;
  try { text = lib.readUntrusted(pin.profile); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const w = ((JSON.parse(text) || {}).sandbox || {}).filesystem || {};
  if (!Array.isArray(w.allowWrite)) throw new Error(`${pin.profile} has no allowWrite list`);
  return { pin, writes: w.allowWrite.filter((x) => typeof x === "string" && path.isAbsolute(x)) };
}

// the SKILL.md for name in a .claude/skills under one of writes, other than the denied ones under skip; "" when none.
// Throws on an error or a cap
function findSkill(writes, name, skip) {
  const real = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
  const denied = skip.filter(Boolean).flatMap((d) => [path.resolve(d), real(d)]);
  let entries = 0;
  for (const top of new Set(writes.map((w) => path.resolve(w)))) {
    if (!fs.existsSync(top)) continue;
    const stack = [[top, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      if (!denied.includes(d)) {
        const f = path.join(d, ".claude", "skills", name, "SKILL.md");
        if (fs.existsSync(f)) return f;
      }
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (++entries > MAX_ENTRIES) throw new Error(`over ${MAX_ENTRIES} entries in the writable paths`);
        if (!e.isDirectory() || SKIP.has(e.name)) continue;
        if (depth >= MAX_DEPTH) throw new Error(`a dir deeper than ${MAX_DEPTH} levels in ${top}`);
        stack.push([path.join(d, e.name), depth + 1]);
      }
    }
  }
  return "";
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(input || "{}") || {};
    if (ev.tool_name !== "Skill") return process.exit(0);
    const p = profile(__dirname);
    if (!p) return process.exit(0);
    const ti = ev.tool_input || {}, raw = String(ti.skill || ti.command || "").trim().replace(/^\//, "");
    const name = raw.slice(raw.lastIndexOf(":") + 1);
    if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") refuse(`cannot tell which skill ${JSON.stringify(raw)} names`);
    const hit = findSkill(p.writes, name, [p.pin.root, p.pin.guest]);
    if (hit) refuse(`${hit} is in a place sandboxed commands can write, and Claude Code would run its hooks outside the sandbox. Invoke it from a session without the sandbox profile, after checking that file`);
    process.exit(0);
  } catch (e) {
    refuse(`the writable paths could not be checked for a planted SKILL.md (${e.message})`);
  }
});
