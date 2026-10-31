#!/usr/bin/env node
// The project policy engine (#307): who merges, how often the human is asked, and the rules that block, ask or
// allow a shell call or an edit. A module and a CLI; no guard calls it yet.
//   node <hooks>/proteus-policy.js show [--json]           the effective policy and where each value came from
//   node <hooks>/proteus-policy.js check '<json event>'    { tool: "shell"|"edit", command?, path? } -> its effect
//   node <hooks>/proteus-policy.js write <draft.json> [--user]
//                                                          a valid draft becomes teams/policy.json and teams/POLICY.md,
//                                                          or with --user the user file; an invalid one writes nothing
//   node <hooks>/proteus-policy.js render                  teams/POLICY.md as write makes it (the preset and
//                                                          teams/policy.json, no user file), on stdout
// Layers, each overriding the last: the preset (templates/policy/presets.json; the files' "preset", else balanced),
// the user file (proteus-policy.json beside proteus.json), the project's teams/policy.json. Rules merge by id, so a
// project rule replaces the user rule it shares an id with. A file that fails validation counts as absent, and its
// errors are reported. load reads; only write writes.
// The policy guards against mistakes, not an adversary: a pattern can be worked around.
// Exit 0 done, 2 bad usage, an unreadable event or draft, or a draft with errors.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: node proteus-policy.js show [--json] | check '<json event>' | write <draft.json> [--user] | render";
const FILE = "proteus-policy.json";
const PROJECT_FILE = "teams/policy.json";
const PROJECT_DOC = "teams/POLICY.md";
const DEFAULT_PRESET = "balanced";
const MERGES = ["lead", "human"];
const ASKS = ["never", "risky", "every"];
const EFFECTS = ["block", "ask", "allow"];
const TOOLS = ["shell", "edit", "any"];
const TOP_KEYS = ["version", "preset", "merge", "ask", "rules"];
const RULE_KEYS = ["id", "effect", "tool", "command", "paths", "why"];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// the user file: beside proteus.json (lib.configFile), or under home/.claude when a home is given
const userFile = (home) => home ? path.join(home, ".claude", FILE) : path.join(path.dirname(lib.configFile()), FILE);

// the presets: beside these hooks in the plugin, else the copy setup keeps in a repo's teams/templates
function presets(root) {
  const dirs = [path.join(__dirname, "..", "policy"), ...(root ? [path.join(root, "teams", "templates", "policy")] : [])];
  for (const d of dirs) {
    const p = lib.readJSON(path.join(d, "presets.json"), null);
    if (p && typeof p === "object" && !Array.isArray(p)) return p;
  }
  return {};
}

// an owned-path glob: repo-relative, forward slashes, no .. segment, and only * and ** as wildcards
function globError(g) {
  if (typeof g !== "string" || !g.trim()) return "is empty";
  if (/^\/|^[A-Za-z]:|\\/.test(g)) return "must be relative to the repo root, with forward slashes";
  if (g.split("/").includes("..")) return "must not climb out with ..";
  if (/[?[\]{}!]/.test(g)) return "may use only * and ** as wildcards";
  return "";
}

// plain-language errors for one policy file; none means valid. names: the preset names it may pick
function validate(obj, names = Object.keys(presets(""))) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return ["the policy must be a JSON object"];
  const errs = [];
  for (const k of Object.keys(obj)) if (!TOP_KEYS.includes(k)) errs.push(`unknown setting "${k}"; the settings are ${TOP_KEYS.join(", ")}`);
  if (obj.version !== 1) errs.push(`"version" must be 1`);
  if ("preset" in obj && !names.includes(obj.preset)) errs.push(`"preset" must be one of ${names.join(", ") || "the shipped presets"}`);
  if ("merge" in obj && !MERGES.includes(obj.merge)) errs.push(`"merge" must be ${MERGES.join(" or ")}`);
  if ("ask" in obj && !ASKS.includes(obj.ask)) errs.push(`"ask" must be one of ${ASKS.join(", ")}`);
  if (!("rules" in obj)) return errs;
  if (!Array.isArray(obj.rules)) return [...errs, `"rules" must be a list`];
  const seen = new Set();
  obj.rules.forEach((r, i) => {
    const at = `rule ${i + 1}${r && typeof r.id === "string" ? ` ("${r.id}")` : ""}`;
    if (!r || typeof r !== "object" || Array.isArray(r)) { errs.push(`${at} must be an object`); return; }
    for (const k of Object.keys(r)) if (!RULE_KEYS.includes(k)) errs.push(`${at}: unknown field "${k}"; the fields are ${RULE_KEYS.join(", ")}`);
    if (typeof r.id !== "string" || !KEBAB.test(r.id)) errs.push(`${at}: "id" must be kebab-case, lowercase words joined by hyphens`);
    else if (seen.has(r.id)) errs.push(`${at}: another rule in this file already uses the id "${r.id}"`);
    else seen.add(r.id);
    if (!EFFECTS.includes(r.effect)) errs.push(`${at}: "effect" must be one of ${EFFECTS.join(", ")}`);
    if (!TOOLS.includes(r.tool)) errs.push(`${at}: "tool" must be one of ${TOOLS.join(", ")}`);
    if ("command" in r) {
      if (r.tool === "edit") errs.push(`${at}: "command" applies to shell calls only; use "tool": "shell" or "any"`);
      if (typeof r.command !== "string" || !r.command) errs.push(`${at}: "command" must be a regular expression`);
      else { try { new RegExp(r.command); } catch (e) { errs.push(`${at}: "command" is not a valid regular expression (${e.message})`); } }
    }
    if ("paths" in r) {
      if (r.tool === "shell") errs.push(`${at}: "paths" applies to edits only; use "tool": "edit" or "any"`);
      if (!Array.isArray(r.paths) || !r.paths.length) errs.push(`${at}: "paths" must be a list of path globs`);
      else r.paths.forEach((g) => { const e = globError(g); if (e) errs.push(`${at}: the path "${String(g)}" ${e}`); });
    }
    if (!("command" in r) && !("paths" in r)) errs.push(`${at}: a rule needs a "command" or "paths" to match`);
    else if (r.tool === "shell" && !("command" in r)) errs.push(`${at}: a shell rule needs a "command"`);
    else if (r.tool === "edit" && !("paths" in r)) errs.push(`${at}: an edit rule needs "paths"`);
    if (typeof r.why !== "string" || !r.why.trim()) errs.push(`${at}: "why" must say in plain words why the rule exists`);
  });
  return errs;
}

// one layer: { file, data } when it is absent (data null) or valid, else { file, data: null, errors }
function readLayer(file, names) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { file, data: null, errors: e.code === "ENOENT" ? [] : [`cannot be read (${e.code || e.message})`] }; }
  let data;
  try { data = JSON.parse(text); } catch (e) { return { file, data: null, errors: [`is not valid JSON (${e.message})`] }; }
  const errors = validate(data, names);
  return { file, data: errors.length ? null : data, errors };
}

// layers in order, each { name, data } -> { policy, sources }: the preset first, picked by the last layer naming one
function resolve(layers, all) {
  const named = [...layers].reverse().find((l) => l.data && l.data.preset);
  const preset = named ? named.data.preset : DEFAULT_PRESET;
  const base = all[preset] || {};
  const policy = { version: 1, preset, merge: base.merge, ask: base.ask, rules: [] };
  const sources = { preset: named ? named.name : "default", merge: `preset ${preset}`, ask: `preset ${preset}`, rules: {} };
  const rules = new Map();
  for (const r of Array.isArray(base.rules) ? base.rules : []) { rules.set(r.id, r); sources.rules[r.id] = `preset ${preset}`; }
  for (const l of layers) {
    if (!l.data) continue;
    for (const k of ["merge", "ask"]) if (k in l.data) { policy[k] = l.data[k]; sources[k] = l.name; }
    for (const r of l.data.rules || []) { rules.set(r.id, r); sources.rules[r.id] = l.name; }
  }
  policy.rules = [...rules.values()];
  return { policy, sources };
}

// the effective policy for root: { policy, sources, files: { user, project }, errors: [{ file, error }] }
function load({ root, home } = {}) {
  const all = presets(root), names = Object.keys(all);
  const files = { user: userFile(home), project: root ? path.join(root, ...PROJECT_FILE.split("/")) : "" };
  const user = readLayer(files.user, names);
  const project = files.project ? readLayer(files.project, names) : { file: "", data: null, errors: [] };
  const errors = [user, project].flatMap((l) => l.errors.map((error) => ({ file: l.file, error })));
  if (!names.length) errors.push({ file: path.join(__dirname, "..", "policy", "presets.json"), error: "no presets found" });
  const { policy, sources } = resolve([{ name: "user", data: user.data }, { name: "project", data: project.data }], all);
  return { policy, sources, files, errors };
}

const RANK = { block: 3, ask: 2, allow: 1 };
const slash = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
// a rule matches ev: a shell call by its command regex, an edit by its owned-path globs
function matches(r, ev) {
  if (ev.tool === "shell") {
    if ((r.tool !== "shell" && r.tool !== "any") || typeof r.command !== "string") return false;
    try { return new RegExp(r.command).test(String(ev.command || "")); } catch { return false; }
  }
  if (ev.tool === "edit") {
    if ((r.tool !== "edit" && r.tool !== "any") || !Array.isArray(r.paths) || typeof ev.path !== "string") return false;
    return r.paths.some((g) => lib.ownedMatch(g, slash(ev.path)));
  }
  return false;
}

// { effect, rule } for the most restrictive rule matching ev (block, then ask, then allow), else { effect: "none" }
function evaluate(policy, ev) {
  let best = null;
  for (const r of (policy && policy.rules) || []) {
    if (EFFECTS.includes(r.effect) && matches(r, ev || {}) && (!best || RANK[r.effect] > RANK[best.effect])) best = r;
  }
  return best ? { effect: best.effect, rule: best } : { effect: "none" };
}

const MERGE_TEXT = {
  lead: "The lead merges a pull request once its checks and review pass.",
  human: "The human merges every pull request; the lead asks instead of merging.",
};
const ASK_TEXT = {
  never: "Only at milestone reviews.",
  risky: "Before merging a change that touches what an ask rule covers, and at milestone reviews.",
  every: "Before every merge, and at milestone reviews.",
};
const EFFECT_TEXT = { block: "Refused.", ask: "Allowed only after the human approves.", allow: "Adds no restriction." };
const code = (s) => "`" + String(s).replace(/`/g, "'") + "`";

// POLICY.md for a resolved policy; the same policy always gives the same text
function render(policy) {
  const p = policy || {};
  const out = [
    "# Policy",
    "",
    `Generated by proteus-policy.js from ${PROJECT_FILE}; nobody edits this file by hand.`,
    "",
    "This policy guards against mistakes; it is not a security boundary.",
    "",
    `Preset: ${p.preset || DEFAULT_PRESET}.`,
    "",
    "## Who merges",
    "",
    MERGE_TEXT[p.merge] || "Not set.",
    "",
    "## How often the human is asked",
    "",
    ASK_TEXT[p.ask] || "Not set.",
    "",
    "## Rules",
    "",
  ];
  const rules = [...(p.rules || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!rules.length) out.push("None.", "");
  for (const r of rules) {
    const on = [];
    if (typeof r.command === "string") on.push(`shell commands matching ${code(r.command)}`);
    if (Array.isArray(r.paths)) on.push(`edits to ${r.paths.map(code).join(", ")}`);
    out.push(`### ${r.id}`, "", `- Effect: ${EFFECT_TEXT[r.effect] || r.effect}`, `- Applies to: ${on.join("; ")}`, `- Why: ${String(r.why).trim()}`, "");
  }
  return out.join("\n");
}

const rootOf = () => lib.repoRoot(process.cwd()) || process.cwd();

// writes a valid draft as the project's policy.json and POLICY.md, or as the user file
function writePolicy(draft, { root, user, home }) {
  if (user) { lib.writeJSON(userFile(home), draft); return [userFile(home)]; }
  const { policy } = resolve([{ name: "project", data: draft }], presets(root));
  const json = path.join(root, ...PROJECT_FILE.split("/")), doc = path.join(root, ...PROJECT_DOC.split("/"));
  lib.writeJSON(json, draft);
  fs.writeFileSync(doc, render(policy));
  return [json, doc];
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") { (cmd ? console.log : console.error)(USAGE); return cmd ? 0 : 2; }
  const root = rootOf();
  const warn = (errors) => { for (const e of errors) console.error(`proteus-policy: ${e.file} ignored: ${e.error}`); };
  if (cmd === "show") {
    const r = load({ root });
    warn(r.errors);
    if (rest.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`preset  ${r.policy.preset}  (${r.sources.preset})`);
    console.log(`merge   ${r.policy.merge || "unset"}  (${r.sources.merge})`);
    console.log(`ask     ${r.policy.ask || "unset"}  (${r.sources.ask})`);
    for (const x of r.policy.rules) console.log(`rule    ${x.id}  ${x.effect} ${x.tool}  (${r.sources.rules[x.id]})`);
    console.log(`files   user ${r.files.user}; project ${r.files.project}`);
    return 0;
  }
  if (cmd === "render") {
    const all = presets(root), l = readLayer(path.join(root, ...PROJECT_FILE.split("/")), Object.keys(all));
    warn(l.errors.map((error) => ({ file: l.file, error })));
    process.stdout.write(render(resolve([{ name: "project", data: l.data }], all).policy));
    return 0;
  }
  if (cmd === "check") {
    let ev;
    try { ev = JSON.parse(rest[0]); } catch { console.error(`proteus-policy: check needs one JSON event\n${USAGE}`); return 2; }
    if (!ev || (ev.tool !== "shell" && ev.tool !== "edit")) { console.error(`proteus-policy: the event's "tool" must be shell or edit`); return 2; }
    const r = load({ root });
    warn(r.errors);
    const v = evaluate(r.policy, ev);
    console.log(JSON.stringify(v.rule ? { effect: v.effect, rule: v.rule.id, why: v.rule.why } : v));
    return 0;
  }
  if (cmd === "write") {
    const file = rest.find((a) => !a.startsWith("--"));
    if (!file) { console.error(USAGE); return 2; }
    let draft;
    try { draft = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`proteus-policy: ${file} is not a readable JSON file (${e.code || e.message})`); return 2; }
    const errors = validate(draft, Object.keys(presets(root)));
    if (errors.length) { for (const e of errors) console.error(`proteus-policy: ${e}`); console.error("proteus-policy: nothing written"); return 2; }
    for (const f of writePolicy(draft, { root, user: rest.includes("--user") })) console.log(`wrote ${f}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

module.exports = { load, validate, evaluate, render, presets, userFile, FILE, PROJECT_FILE, PROJECT_DOC };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
