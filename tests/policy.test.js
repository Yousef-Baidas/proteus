// Policy engine tests (#307): node tests/policy.test.js. proteus-policy.js merges the preset, the user file and
// the project's teams/policy.json (rules by id), validates each file and treats an invalid one as absent, picks the
// most restrictive matching rule, renders POLICY.md, and its CLI's write refuses an invalid draft, writing nothing.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("policy");
const P = require(path.join(HOOKS, "proteus-policy.js"));
const SCRIPT = path.join(HOOKS, "proteus-policy.js");

const HOME = lib.HOME;
const USER = path.join(HOME, ".claude", "proteus-policy.json");
let n = 0;
// a fresh repo dir with an optional teams/policy.json
const repo = (project) => {
  const d = path.join(W, `repo${++n}`);
  fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  if (project !== undefined) {
    fs.mkdirSync(path.join(d, "teams"), { recursive: true });
    fs.writeFileSync(path.join(d, "teams", "policy.json"), typeof project === "string" ? project : JSON.stringify(project));
  }
  return d;
};
const setUser = (obj) => { if (obj === undefined) fs.rmSync(USER, { force: true }); else fs.writeFileSync(USER, typeof obj === "string" ? obj : JSON.stringify(obj)); };
const rule = (id, effect, extra) => ({ id, effect, tool: "shell", command: "^placeholder", why: "a reason", ...extra });
const cli = (cwd, ...args) => lib.run(SCRIPT, "", { cwd, args });

// presets
const presets = JSON.parse(fs.readFileSync(path.join(ROOT, "templates", "policy", "presets.json"), "utf8"));
ok("presets: hands-off, balanced and careful ship with the design's merge and ask and no rules",
  presets["hands-off"].merge === "lead" && presets["hands-off"].ask === "never" && presets.balanced.merge === "lead" && presets.balanced.ask === "risky"
  && presets.careful.merge === "human" && presets.careful.ask === "every" && Object.values(presets).every((p) => Array.isArray(p.rules) && !p.rules.length && !P.validate(p).length), JSON.stringify(presets));

// merge precedence
setUser(undefined);
let r = P.load({ root: repo(), home: HOME });
ok("load: with no files the default is balanced", r.policy.preset === "balanced" && r.policy.merge === "lead" && r.policy.ask === "risky" && r.sources.merge === "preset balanced" && !r.errors.length, JSON.stringify(r));
setUser({ version: 1, preset: "careful" });
r = P.load({ root: repo(), home: HOME });
ok("load: the user file's preset applies", r.policy.preset === "careful" && r.policy.merge === "human" && r.policy.ask === "every" && r.sources.preset === "user", JSON.stringify(r));
setUser({ version: 1, preset: "careful", ask: "risky" });
r = P.load({ root: repo({ version: 1, merge: "lead" }), home: HOME });
ok("load: the user file overrides the preset and the project overrides both", r.policy.merge === "lead" && r.sources.merge === "project" && r.policy.ask === "risky" && r.sources.ask === "user", JSON.stringify(r));
r = P.load({ root: repo({ version: 1, preset: "hands-off" }), home: HOME });
ok("load: a project preset wins over the user's, and the user's explicit values still override it", r.policy.preset === "hands-off" && r.sources.preset === "project" && r.policy.merge === "lead" && r.policy.ask === "risky" && r.sources.ask === "user", JSON.stringify(r));

// rules by id
setUser({ version: 1, rules: [rule("shared", "block"), rule("user-only", "ask")] });
r = P.load({ root: repo({ version: 1, rules: [rule("shared", "allow", { why: "relaxed here" }), rule("project-only", "block")] }), home: HOME });
const byId = Object.fromEntries(r.policy.rules.map((x) => [x.id, x]));
ok("load: a project rule replaces the user rule with the same id; the rest of both stay", r.policy.rules.length === 3 && byId.shared.effect === "allow" && byId.shared.why === "relaxed here"
  && r.sources.rules.shared === "project" && r.sources.rules["user-only"] === "user" && r.sources.rules["project-only"] === "project", JSON.stringify(r));

// invalid files are ignored with an error, never half-applied
setUser({ version: 1, merge: "human", rules: [rule("Bad_Id", "block")] });
r = P.load({ root: repo({ version: 1, ask: "every" }), home: HOME });
ok("load: an invalid user file is ignored whole and its error is returned", r.policy.merge === "lead" && !r.policy.rules.length && r.policy.ask === "every"
  && r.errors.length === 1 && r.errors[0].file === USER && /kebab-case/.test(r.errors[0].error), JSON.stringify(r));
setUser(undefined);
r = P.load({ root: repo("{ not json"), home: HOME });
ok("load: a project file that is not JSON is ignored with an error", r.policy.preset === "balanced" && r.errors.length === 1 && /not valid JSON/.test(r.errors[0].error), JSON.stringify(r));
{
  const d = repo({ version: 2 }), before = fs.readFileSync(path.join(d, "teams", "policy.json"), "utf8");
  P.load({ root: d, home: HOME });
  ok("load: never rewrites a file it reads", fs.readFileSync(path.join(d, "teams", "policy.json"), "utf8") === before && !fs.existsSync(path.join(d, "teams", "POLICY.md")));
}

// each validation error
const errs = (obj) => P.validate(obj);
const has = (obj, re) => { const e = errs(obj); return e.some((x) => re.test(x)) ? "" : JSON.stringify(e); };
ok("validate: a valid policy has no errors", !errs({ version: 1, preset: "careful", merge: "human", ask: "never", rules: [rule("a-b", "block"), { id: "c", effect: "ask", tool: "edit", paths: ["src/**", "docs/"], why: "w" }, { id: "d", effect: "allow", tool: "any", command: "x", paths: ["a/*"], why: "w" }] }).length);
const CASES = [
  ["not an object", [], /must be a JSON object/],
  ["a wrong version", { version: 2 }, /"version" must be 1/],
  ["an unknown setting", { version: 1, extra: 1 }, /unknown setting "extra"/],
  ["an unknown preset", { version: 1, preset: "other" }, /"preset" must be one of/],
  ["a bad merge", { version: 1, merge: "anyone" }, /"merge" must be lead or human/],
  ["a bad ask", { version: 1, ask: "sometimes" }, /"ask" must be one of/],
  ["rules not a list", { version: 1, rules: {} }, /"rules" must be a list/],
  ["a rule that is not an object", { version: 1, rules: ["x"] }, /rule 1 must be an object/],
  ["an unknown rule field", { version: 1, rules: [rule("a", "block", { extra: 1 })] }, /unknown field "extra"/],
  ["an id that is not kebab-case", { version: 1, rules: [rule("NotKebab", "block")] }, /"id" must be kebab-case/],
  ["a duplicate id", { version: 1, rules: [rule("a", "block"), rule("a", "ask")] }, /already uses the id "a"/],
  ["a bad effect", { version: 1, rules: [rule("a", "deny")] }, /"effect" must be one of/],
  ["a bad tool", { version: 1, rules: [rule("a", "block", { tool: "web" })] }, /"tool" must be one of/],
  ["an invalid regex", { version: 1, rules: [rule("a", "block", { command: "(" })] }, /not a valid regular expression/],
  ["command on an edit rule", { version: 1, rules: [rule("a", "block", { tool: "edit", paths: ["a"] })] }, /"command" applies to shell calls only/],
  ["paths on a shell rule", { version: 1, rules: [rule("a", "block", { paths: ["a"] })] }, /"paths" applies to edits only/],
  ["paths not a list", { version: 1, rules: [{ id: "a", effect: "block", tool: "edit", paths: "a", why: "w" }] }, /"paths" must be a list/],
  ["an absolute path", { version: 1, rules: [{ id: "a", effect: "block", tool: "edit", paths: ["/a"], why: "w" }] }, /relative to the repo root/],
  ["a .. path", { version: 1, rules: [{ id: "a", effect: "block", tool: "edit", paths: ["a/../b"], why: "w" }] }, /must not climb out/],
  ["a wildcard owned paths lack", { version: 1, rules: [{ id: "a", effect: "block", tool: "edit", paths: ["a/?.js"], why: "w" }] }, /only \* and \*\* as wildcards/],
  ["a rule with nothing to match", { version: 1, rules: [{ id: "a", effect: "block", tool: "any", why: "w" }] }, /needs a "command" or "paths"/],
  ["a shell rule without a command", { version: 1, rules: [{ id: "a", effect: "block", tool: "shell", paths: ["a"], why: "w" }] }, /a shell rule needs a "command"/],
  ["an edit rule without paths", { version: 1, rules: [{ id: "a", effect: "block", tool: "edit", command: "a", why: "w" }] }, /an edit rule needs "paths"/],
  ["an empty why", { version: 1, rules: [rule("a", "block", { why: "  " })] }, /"why" must say in plain words/],
];
for (const [name, obj, re] of CASES) { const miss = has(obj, re); ok(`validate: ${name} is an error`, !miss, miss); }
ok("validate: an id only has to be unique within one file", !errs({ version: 1, rules: [rule("a", "block")] }).length && !errs({ version: 1, rules: [rule("a", "ask")] }).length);

// evaluation: most restrictive wins
const pol = { rules: [
  rule("allow-x", "allow", { command: "x" }),
  rule("ask-xy", "ask", { command: "x.*y" }),
  rule("block-xyz", "block", { command: "x.*y.*z" }),
  { id: "edit-ask", effect: "ask", tool: "edit", paths: ["src/*/keep", "docs/"], why: "w" },
  { id: "edit-block", effect: "block", tool: "any", paths: ["src/a/keep/**"], why: "w" },
] };
const ev = (e) => { const v = P.evaluate(pol, e); return v.rule ? `${v.effect}:${v.rule.id}` : v.effect; };
ok("evaluate: block beats ask beats allow among matching rules", ev({ tool: "shell", command: "run x y z" }) === "block:block-xyz" && ev({ tool: "shell", command: "x then y" }) === "ask:ask-xy" && ev({ tool: "shell", command: "only x" }) === "allow:allow-x");
ok("evaluate: no match is none", ev({ tool: "shell", command: "nothing" }) === "none" && ev({ tool: "edit", path: "other/file" }) === "none");
ok("evaluate: the regex is tested against the full command string", ev({ tool: "shell", command: "a && x || y" }) === "ask:ask-xy");
ok("evaluate: a shell rule never matches an edit, nor an edit rule a shell call", ev({ tool: "edit", path: "x/y/z" }) === "none" && ev({ tool: "shell", command: "src/b/keep" }) === "none");
ok("evaluate: edit paths match as owned paths do (a folder owns what is under it, * stays in one segment)",
  ev({ tool: "edit", path: "src/b/keep/file" }) === "ask:edit-ask" && ev({ tool: "edit", path: "docs/deep/file.md" }) === "ask:edit-ask"
  && ev({ tool: "edit", path: "src/b/c/keep" }) === "none" && ev({ tool: "edit", path: "./src/a/keep/f" }) === "block:edit-block", [ev({ tool: "edit", path: "src/b/keep/file" }), ev({ tool: "edit", path: "src/b/c/keep" })].join(" "));
ok("evaluate: a path given with backslashes is read as repo-relative with forward slashes", ev({ tool: "edit", path: "docs\\x.md" }) === "ask:edit-ask");

// render
{
  const p = { version: 1, preset: "careful", merge: "human", ask: "every", rules: [rule("zeta", "block", { why: "second" }), { id: "alpha", effect: "ask", tool: "edit", paths: ["a/"], why: "first" }] };
  const a = P.render(p), b = P.render({ ...p, rules: [...p.rules].reverse() });
  ok("render: deterministic, whatever the rules' order", a === b && a === P.render(JSON.parse(JSON.stringify(p))), a);
  ok("render: plain-language headings, each rule's effect and why, and the not-a-security-boundary line",
    /^## Who merges$/m.test(a) && /^## How often the human is asked$/m.test(a) && /^## Rules$/m.test(a) && /not a security boundary/.test(a)
    && /### alpha[\s\S]*Effect: Allowed only after the human approves\.[\s\S]*Why: first[\s\S]*### zeta[\s\S]*Effect: Refused\.[\s\S]*Why: second/.test(a) && /The human merges every pull request/.test(a), a);
}

// CLI
setUser(undefined);
{
  const d = repo({ version: 1, preset: "hands-off", rules: [rule("blk", "block", { command: "^danger" })] });
  r = cli(d, "show", "--json");
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  ok("cli: show --json prints the effective policy and its sources", r.code === 0 && j && j.policy.preset === "hands-off" && j.sources.rules.blk === "project", r.out + r.err);
  r = cli(d, "show");
  ok("cli: show prints each value with its source", r.code === 0 && /^preset  hands-off  \(project\)$/m.test(r.out) && /^ask     never  \(preset hands-off\)$/m.test(r.out) && /^rule    blk  block shell  \(project\)$/m.test(r.out), r.out + r.err);
  r = cli(d, "check", JSON.stringify({ tool: "shell", command: "danger now" }));
  ok("cli: check prints the effect, the rule and its why", r.code === 0 && JSON.parse(r.out).effect === "block" && JSON.parse(r.out).rule === "blk" && JSON.parse(r.out).why === "a reason", r.out + r.err);
  r = cli(d, "check", "{ nope");
  ok("cli: check with an unreadable event exits 2", r.code === 2, r.out + r.err);
  r = cli(d, "check", JSON.stringify({ tool: "web" }));
  ok("cli: check with an unknown tool exits 2", r.code === 2, r.out + r.err);
  r = cli(d, "--help");
  ok("cli: --help exits 0 with the usage", r.code === 0 && /usage: node proteus-policy\.js/.test(r.out), r.out + r.err);
  ok("cli: no command and an unknown command exit 2", cli(d).code === 2 && cli(d, "nope").code === 2);
  r = cli(d, "render");
  ok("cli: render prints POLICY.md to stdout", r.code === 0 && r.out.startsWith("# Policy\n") && /### blk/.test(r.out), r.out + r.err);
}
{
  const d = repo();
  const draft = path.join(W, "bad.json");
  fs.writeFileSync(draft, JSON.stringify({ version: 1, rules: [rule("a", "block", { command: "(" })] }));
  r = cli(d, "write", draft);
  ok("cli: write refuses an invalid draft with exit 2 and writes nothing", r.code === 2 && /not a valid regular expression/.test(r.err) && !fs.existsSync(path.join(d, "teams")), r.out + r.err);
  r = cli(d, "write", draft, "--user");
  ok("cli: write --user refuses an invalid draft and writes no user file", r.code === 2 && !fs.existsSync(USER), r.out + r.err);
  r = cli(d, "write", path.join(W, "missing.json"));
  ok("cli: write of a missing draft exits 2", r.code === 2 && !fs.existsSync(path.join(d, "teams")), r.out + r.err);
  const good = path.join(W, "good.json"), obj = { version: 1, preset: "careful", rules: [rule("a", "ask")] };
  fs.writeFileSync(good, JSON.stringify(obj));
  r = cli(d, "write", good);
  const json = path.join(d, "teams", "policy.json"), doc = path.join(d, "teams", "POLICY.md");
  ok("cli: write of a valid draft writes teams/policy.json and teams/POLICY.md and exits 0", r.code === 0 && fs.existsSync(json) && fs.existsSync(doc)
    && JSON.stringify(JSON.parse(fs.readFileSync(json, "utf8"))) === JSON.stringify(obj) && /### a/.test(fs.readFileSync(doc, "utf8")), r.out + r.err);
  ok("cli: render reproduces the POLICY.md write made", cli(d, "render").out === fs.readFileSync(doc, "utf8"));
  r = cli(d, "write", good, "--user");
  ok("cli: write --user writes the user file beside proteus.json", r.code === 0 && fs.existsSync(USER) && JSON.parse(fs.readFileSync(USER, "utf8")).preset === "careful", r.out + r.err);
  setUser(undefined);
}

lib.summary();
