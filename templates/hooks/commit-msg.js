#!/usr/bin/env node
// commit-msg hook: enforce references/commits.md mechanically.
// Usage: node commit-msg.js <path-to-COMMIT_EDITMSG>
"use strict";
const fs = require("fs");
// `git commit -v` appends the diff below a scissors line; it is not part of the message
const msg = fs.readFileSync(process.argv[2], "utf8").split(/^# -+ >8 -+$/m)[0];
const lines = msg.split(/\r?\n/).filter((l) => !l.startsWith("#"));
const subject = lines[0] || "";
const fail = (m) => { fs.writeSync(2, "commit rejected: " + m + "\n"); process.exit(1); };

const types = "feat|fix|refactor|test|docs|chore|perf|build|ci|style|revert";
const re = new RegExp(`^(${types})(\\([a-z0-9._/-]+\\))?!?: [A-Za-z][^\\n]*$`);
if (/^(Merge|Revert|fixup!|squash!|amend!) /.test(subject)) process.exit(0);
if (!re.test(subject)) fail(`subject must be "<type>(<scope>): lowercase imperative" (types: ${types})`);
if (subject.length > 72) fail("subject over 72 chars");
if (subject.endsWith(".")) fail("no trailing period");
if (lines[1] && lines[1].trim() !== "") fail("blank line required after subject");
for (const l of lines.slice(2)) if (l.length > 72 && !/https?:\/\//.test(l)) fail("body line over 72 chars");

// AI attribution is a trailer: only the message's last paragraph is checked, so body prose that
// mentions "Generated with" or a human's Signed-off-by (any email domain) passes.
const ai = /\b(claude|anthropic|openai|chatgpt|gpt-?\d*|codex|copilot|gemini|cursor|aider|ai)\b/i;
const banned = (l) => l.startsWith("🤖") || /^Generated with \[/i.test(l)
  || (/^(Co-Authored-By|Generated-by|Assisted-by|Signed-off-by):/i.test(l) && ai.test(l.replace(/<[^>]*>/g, "")));
const paras = lines.join("\n").trim().split(/\n\s*\n/);
if (paras.length > 1 && paras[paras.length - 1].split("\n").some(banned)) fail("AI attribution trailer is not allowed");
