#!/usr/bin/env node
// The project policy engine (#307): who merges, how often the human is asked, and the rules that block, ask or
// allow a shell call or an edit. A module and a CLI; the lead guard and the worker guard call guard(ev, ad) after their
// own checks, so a refusal of theirs always stands.
//   node <hooks>/proteus-policy.js show [--json]           the effective policy and where each value came from
//   node <hooks>/proteus-policy.js check '<json event>'    { tool: "shell"|"edit", command?, path? } -> its effect
//   node <hooks>/proteus-policy.js write <draft.json> [--user]
//                                                          a valid draft becomes teams/policy.json and teams/POLICY.md,
//                                                          or with --user the user file; an invalid one writes nothing
//   node <hooks>/proteus-policy.js render                  teams/POLICY.md as write makes it (the preset and
//                                                          teams/policy.json, no user file), on stdout
// Layers, each overriding the last: the preset (templates/policy/presets.json; the files' "preset", else balanced),
// the user file (proteus-policy.json beside proteus.json), the project's teams/policy.json (in guest mode the guest
// dir's, lib.docRoot, as for POLICY.md). Rules merge by id, so a
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

// the user file: beside proteus.json (lib.policyUserFile), or under home/.claude when a home is given
const userFile = (home) => home ? path.join(home, ".claude", FILE) : lib.policyUserFile();

// a project file's path under the teams dir, the guest dir's in guest mode
const projectPath = (root, file) => path.join(lib.docRoot(root), ...file.split("/"));

// the presets: the copy beside these hooks in a non-plugin install, else ../policy (the plugin, a teams/templates
// copy), else the copy setup keeps in the repo's teams/templates
function presets(root) {
  const dirs = [__dirname, path.join(__dirname, "..", "policy"), ...(root ? [path.join(lib.docRoot(root), "teams", "templates", "policy")] : [])];
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
  const files = { user: userFile(home), project: root ? projectPath(root, PROJECT_FILE) : "" };
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

// ---- the guards (#307): guard(ev, ad, lead) runs after the lead guard's or the worker guard's own checks. It refuses
// through ad.deny, or returns the text of a permission "ask" for the lead's own call (the caller asks once its own
// bookkeeping is done), else "". lead: the lead's own session; a subagent, a teammate or a worker is not.
// 1. `node <hooks>/proteus-policy.js write <draft> [--user]`: the lead's opens a dialog showing the draft rendered, or,
//    where none can appear (Codex, a mode without one), is refused with the command for the human's own terminal;
//    anyone else's is refused.
// 2. The fixed core: no edit of the policy's files (teams/policy.json, teams/POLICY.md, the user file), nor a write
//    to one the lead's command line names. The agents' shell writes to them are lib.agentShellDenial's (AGENT_NEVER)
//    and proteus-shell-check.js's.
// 3. A policy file that fails validation refuses every edit and shell write until it is fixed; a missing one is fine.
// 4. The rules: block refuses; ask asks the lead's human, or refuses with NEEDS; allow and none change nothing.
const SCRIPT_WORD = /(^|[\\/])proteus-policy\.js$/;
const RUNS_TEXT = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "eval"]);
const WRITE_USAGE = "run it alone, exactly as `node <hooks>/proteus-policy.js write <draft.json> [--user]`, nothing before or after it";
const WRITE_HOW = "the lead drafts the change and runs `node <hooks>/proteus-policy.js write <draft.json>`, which the human approves";
const NEEDS = "File NEEDS; the lead asks the human.";
const fwd = (p) => String(p).split(path.sep).join("/");
const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const commands = (command) => { try { return lib.shellCommands(String(command || "")); } catch { return null; } };
const noAsk = (ev, ad) => (typeof ad.noAsk === "function" ? ad.noAsk(ev) : "this CLI's adapter cannot ask");
const sentence = (s) => (/[.!?]$/.test(s) ? s : s + ".");

// the call runs proteus-policy.js write: the script, as the program or under node, bun or deno, then write; or both
// in the text a shell or eval runs; a line it cannot split, or a $( ) as a program, counts when it names both. A
// commit message or an echo naming them is no write
const RUNNERS = /^(node|nodejs|bun|deno)$/;
function runsWrite(command) {
  const cmd = String(command || "");
  if (!/proteus-policy/.test(cmd) || !/\bwrite\b/.test(cmd)) return false;
  const cmds = commands(cmd);
  if (!cmds || cmds.dynamic) return true;
  return cmds.some((all) => {
    const w = lib.unwrap(all), k = w.findIndex((x) => SCRIPT_WORD.test(x));
    if (k >= 0 && (k === 0 || w.slice(0, k).some((x) => RUNNERS.test(lib.progName(x)))) && w.slice(k + 1).includes("write")) return true;
    return RUNS_TEXT.has(lib.progName(w[0])) && w.slice(1).some((x) => /proteus-policy/.test(x) && /\bwrite\b/.test(x));
  });
}

// { file, user, root } from the one form the dialog shows, `node <this script> write <draft> [--user]` alone on the
// line, so what the human approves is what runs; else { error }
function writeArgs(ev) {
  const dir = lib.shellCwd(ev), cmd = String(ev.command || ""), cmds = commands(cmd);
  const bad = { error: `proteus-policy.js write: ${WRITE_USAGE}.` };
  if (!cmds || cmds.length !== 1 || /`|\$\(|<\(|>\(/.test(cmd) || (cmds[0].redirects || []).length) return bad;
  const w = cmds[0];
  if (lib.unwrap(w).length !== w.length || lib.progName(w[0]) !== "node" || w[2] !== "write") return bad;
  if (!lib.samePath(lib.realOr(path.resolve(dir, lib.expandPath(w[1] || "", dir))), lib.realOr(__filename))) return { error: `proteus-policy.js write runs only as this install's script, ${fwd(__filename)}: ${WRITE_USAGE}.` };
  const rest = w.slice(3), files = rest.filter((a) => a !== "--user");
  if (files.length !== 1 || files[0].startsWith("-")) return bad;
  return { file: path.resolve(dir, lib.expandPath(files[0], dir)), user: rest.includes("--user"), root: lib.repoRoot(dir) || dir };
}

// a policy write: { ask } with the rendered draft for the lead's dialog, else { deny }
function writeDecision(ev, ad, lead) {
  if (!lead) return { deny: `proteus-policy.js write is the lead's, and the human approves each write; a subagent or a worker never runs it. ${NEEDS}` };
  const a = writeArgs(ev);
  if (a.error) return { deny: a.error };
  let draft;
  try { draft = JSON.parse(fs.readFileSync(a.file, "utf8")); } catch (e) { return { deny: `proteus-policy.js write: ${fwd(a.file)} is not a readable JSON file (${e.code || e.message}).` }; }
  const all = presets(a.root), errors = validate(draft, Object.keys(all));
  if (errors.length) return { deny: `proteus-policy.js write: the draft ${fwd(a.file)} has errors, so nothing would be written: ${errors.slice(0, 3).join("; ")}.` };
  const why = noAsk(ev, ad);
  if (why) return { deny: `the human approves each policy write in a permission dialog, and none can appear here (${why}). The human runs it in their own terminal, in ${fwd(a.root)}: node ${quote(fwd(__filename))} write ${quote(fwd(a.file))}${a.user ? " --user" : ""}` };
  const target = a.user ? userFile() : projectPath(a.root, PROJECT_FILE);
  const text = render(resolve([{ name: a.user ? "user" : "project", data: draft }], all).policy).trimEnd().split("\n");
  const SHOW = 60, shown = text.slice(0, SHOW).map((l) => `  ${l.slice(0, 200)}`);
  if (text.length > SHOW) shown.push(`  … ${text.length - SHOW} more lines in ${fwd(a.file)}`);
  return { ask: `Proteus: write this policy to ${fwd(target)}${a.user ? ", the default for every project" : ""}? Approve only if it is what you agreed.\n${shown.join("\n")}` };
}

// the policy file abs is, as shown in a refusal, else "": teams/policy.json or teams/POLICY.md in any checkout or the
// guest dir (lib.POLICY_NEVER, on lib.fileKey so case and trailing dots do not get around it), or the user file
function policyFile(abs, ev) {
  const user = userFile(), guest = lib.guestDir(policyRoot(ev));
  for (const p of new Set([abs, lib.realOr(abs)])) {
    const wt = lib.gitRoot(path.dirname(p));
    for (const base of [wt, guest, guest && lib.realOr(guest)]) {
      const rel = base ? lib.relPath(base, p) : null;
      if (rel && lib.POLICY_NEVER.some((re) => re.test(lib.fileKey(rel)))) return rel;
    }
    if (lib.samePath(p, user) || lib.samePath(p, lib.realOr(user))) return fwd(p);
  }
  return "";
}

// what a shell call's line names as written (redirects and writing programs), resolved; null when it cannot be split
function shellWrites(ev) {
  const dir = lib.shellCwd(ev), cmds = commands(ev.command);
  if (!cmds) return null;
  const out = [];
  for (const all of cmds) {
    for (const t of [...(all.redirects || []), ...lib.writeTargets(lib.unwrap(all))]) {
      if (!/^(\/dev\/\w+|nul)$/i.test(t)) out.push(path.resolve(dir, lib.expandPath(t, dir)));
    }
  }
  return out;
}

// the approved policy is the main checkout's, a worker's in its linked worktree too
function policyRoot(ev) {
  const root = path.resolve(lib.projectRoot(ev)), common = lib.gitCommonDir(root);
  return (common && lib.mainRoot(common)) || root;
}

function guard(ev, ad, lead) {
  if (ev.tool !== "shell" && ev.tool !== "edit") return "";
  if (ev.tool === "shell" && runsWrite(ev.command)) {
    const d = writeDecision(ev, ad, lead);
    if (d.deny) ad.deny(d.deny);
    return d.ask || "";
  }
  const cwd = path.resolve(ev.cwd || lib.projectRoot(ev));
  const edits = ev.tool === "edit" ? (ev.paths || []).map((p) => path.resolve(cwd, String(p))) : [];
  // the lead's line naming a policy file; an agent's shell is AGENT_NEVER's
  const writes = ev.tool === "shell" && lead && /policy/i.test(ev.command) ? shellWrites(ev) : null;
  for (const abs of [...edits, ...(writes || [])]) {
    const f = policyFile(abs, ev);
    if (f) ad.deny(`${f} is the policy, which nobody writes by hand: ${WRITE_HOW}.`);
  }
  const r = load({ root: policyRoot(ev) });
  const bad = r.errors.find((e) => e.file && (e.file === r.files.user || e.file === r.files.project));
  if (bad) {
    const w = ev.tool === "edit" ? edits : shellWrites(ev);
    if (!w || w.length) ad.deny(`the policy file ${fwd(bad.file)} is invalid (${bad.error}); edits and shell writes are refused until it is fixed: ${WRITE_HOW}${bad.file === r.files.user ? " with --user" : ""}.`);
  }
  let hit = { effect: "none" };
  const evs = ev.tool === "shell" ? [{ tool: "shell", command: ev.command }]
    : edits.map((abs) => { const wt = lib.gitRoot(path.dirname(abs)); return wt && lib.relPath(wt, abs); }).filter(Boolean).map((p) => ({ tool: "edit", path: p }));
  for (const e of evs) { const v = evaluate(r.policy, e); if (v.rule && (!hit.rule || RANK[v.effect] > RANK[hit.effect])) hit = v; }
  if (hit.effect === "block") ad.deny(`policy ${hit.rule.id}: ${String(hit.rule.why).trim()}`);
  if (hit.effect !== "ask") return "";
  const text = `policy ${hit.rule.id}: ${String(hit.rule.why).trim()}`;
  if (lead && !noAsk(ev, ad)) return text;
  ad.deny(`${sentence(text)} ${NEEDS}`);
  return "";
}


// writes a valid draft as the project's policy.json and POLICY.md, or as the user file
function writePolicy(draft, { root, user, home }) {
  if (user) { lib.writeJSON(userFile(home), draft); return [userFile(home)]; }
  const { policy } = resolve([{ name: "project", data: draft }], presets(root));
  const json = projectPath(root, PROJECT_FILE), doc = projectPath(root, PROJECT_DOC);
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
    const all = presets(root), l = readLayer(projectPath(root, PROJECT_FILE), Object.keys(all));
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

const HELD = {
  merge: "the policy has the human merge every PR",
  moved: "its head moved after the check; it waits for the next round",
  unknown: "gh gave no head commit to pin the merge to",
  accept: "the policy has the human take every PR; their `ACCEPT <sha12>` verdict for its head lets it merge",
  security: "it changes a path in the security block of teams/ROUTING.md; their `ACCEPT <sha12>` verdict for its head lets it merge",
  "unread-security": "gh could not read the base's security block or what this PR changes, so it counts as a security change; their `ACCEPT <sha12>` verdict for its head lets it merge",
  every: "the policy asks the human before every merge; their `ACCEPT <sha12>` comment for its head lets it merge",
  unread: "the policy asks before a change an ask rule covers, and gh could not list what this PR changes",
};

// what a hold says, proteus-merge.js's line and the stand-in's `pr merge` refusal
const heldLine = (h) => `PR #${h.n} held${/^(moved|unknown)$/.test(h.why) ? "" : " for the human"}: ${HELD[h.why === "merge" && h.sha ? "accept" : h.why] || `the policy's ask rule ${h.why.slice(7)} covers what it changes`}`;

// the human's login, as proteus-verdict.js trusts it: "human" in proteus.json, else gh's own login while the agents
// share it (no agentGh); "" when there is none, so no comment counts
function humanOf(root) {
  const human = String(lib.proteusConfig().human || "").trim();
  return human || (lib.agentGhDir() ? "" : lib.gh(["api", "user", "--jq", ".login"], root, 6000));
}

// what stands in for the proteus/security status in local mode (#310): "security" when PR #n changes a path in the
// security block of its base's teams/ROUTING.md, both ends of a rename, as proteus-security.js and the signoff's
// securityMirror read it; "unread-security" when that cannot be told; "" when it does not, or the base has no block
function securityHold(n, root) {
  const base = lib.ghTry(["pr", "view", String(n), "--json", "baseRefName", "-q", ".baseRefName"], root, 30000);
  if (!base.ok || !base.out.trim()) return "unread-security";
  const file = lib.ghTry(["api", `repos/{owner}/{repo}/contents/teams/ROUTING.md?ref=${encodeURIComponent(base.out.trim())}`, "-q", ".content"], root, 30000);
  if (!file.ok && !/\(HTTP 404\)/.test(file.err)) return "unread-security";
  const globs = file.ok ? lib.parseSecurity(Buffer.from(file.out, "base64").toString("utf8")) : null;
  if (!globs || !globs.length) return "";
  const listed = lib.ghTry(["api", "--paginate", `repos/{owner}/{repo}/pulls/${n}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"], root, 30000);
  if (!listed.ok) return "unread-security";
  return listed.out.split(/\r?\n/).map((l) => l.trim()).some((p) => p && globs.some((g) => lib.tierMatch(g, p))) ? "security" : "";
}

// the policy's hold on the picked PRs (#307), [{ n, why, sha }] (sha: the head's sha12, "" when gh cannot say): merge human holds every one ("merge"); ask every holds each
// ("every"), and ask risky each whose changed paths an ask rule covers ("policy:<id>", or "unread" when gh cannot list
// them), until the human's newest verdict on the PR (lib.humanVerdicts) is ACCEPT <head sha12>; ask never holds none. In
// local mode, where no host takes the human's merge or posts proteus/security, the recorded ACCEPT is that act: merge
// human ("merge", with its sha) and a security change (securityHold) wait for it too, whatever the modes say. Here
// rather than in proteus-merge.js so the stand-in's `pr merge` can load it: that script refuses to run from a copy
function held(picked, root, policy) {
  if (!picked.length) return [];
  const local = lib.localCommon(root);
  if (policy.merge === "human" && !local) return picked.map((p) => ({ n: p.n, why: "merge" }));
  const asks = { rules: (policy.rules || []).filter((r) => r.effect === "ask" && Array.isArray(r.paths)) };
  const asking = policy.ask === "every" || (policy.ask === "risky" && asks.rules.length > 0);
  if (!asking && !local) return [];
  const why = (n) => {
    if (policy.merge === "human") return "merge";
    const risk = local ? securityHold(n, root) : "";
    if (risk || !asking) return risk;
    if (policy.ask === "every") return "every";
    const r = lib.ghTry(["pr", "diff", String(n), "--name-only"], root, 30000);
    if (!r.ok) return "unread";
    for (const f of r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const v = evaluate(asks, { tool: "edit", path: f });
      if (v.rule) return `policy:${v.rule.id}`;
    }
    return "";
  };
  // the PR's head and whether the human accepted that head: their newest verdict on the PR is `ACCEPT <sha12>` for
  // it. A bare ACCEPT, another head's sha, or CHANGES holds; their order alone decides, never a commit date.
  let human = null;
  const view = (n) => {
    if (human === null) human = local ? "" : humanOf(root);
    let v = null;
    try { v = JSON.parse(lib.gh(["pr", "view", String(n), "--json", "comments,headRefOid"], root, 30000)); } catch {}
    const full = v && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(v.headRefOid)) ? String(v.headRefOid) : "", sha = full.slice(0, 12);
    if ((!local && !human) || !sha) return { sha, ok: false };
    const said = lib.humanVerdicts(root, n, (v && v.comments) || [], human).pop();
    return { sha, full, ok: !!said && said.first === `ACCEPT ${sha}` };
  };
  return picked.flatMap((p) => {
    const w = why(p.n);
    if (!w) return [];
    const v = view(p.n);
    if (v.ok) p.oid = v.full; // the merge is pinned to the head the human accepted
    return v.ok ? [] : [{ n: p.n, why: w, sha: v.sha }];
  });
}

module.exports = { held, heldLine, load, validate, evaluate, render, resolve, presets, userFile, guard, FILE, PROJECT_FILE, PROJECT_DOC };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
