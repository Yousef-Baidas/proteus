// The run panel mod (#311): node tests/panel.test.js. Runs everywhere, CI included, with no claude CLI: the
// marketplace's second entry and the mod's manifest, and a static read of the mod's source that it is display only
// (no hook on tool calls, tool checks or permissions, no config or settings, no file writes, no network) and that its
// one process is node running the status script with --json. With claude on PATH it also runs claude plugin validate
// and claude plugin test on the mod (mods/proteus-panel/test/); without, it prints a note and skips them.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MOD = path.join(ROOT, "mods", "proteus-panel");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const read = (...p) => { try { return JSON.parse(fs.readFileSync(path.join(...p), "utf8")); } catch (e) { return { error: e.message }; } };

// ---- the marketplace entry and the mod's manifest
const M = read(ROOT, ".claude-plugin", "marketplace.json");
const entry = (M.plugins || []).find((p) => p && p.name === "proteus-panel") || {};
ok("marketplace.json: a proteus-panel entry sourced from ./mods/proteus-panel", entry.source === "./mods/proteus-panel" && typeof entry.description === "string", JSON.stringify(M.plugins));
const P = read(MOD, ".claude-plugin", "plugin.json");
ok("mod manifest: named proteus-panel, hooks and types inside the mod", P.name === "proteus-panel" && P.hooks === "./hooks/hooks.json" && P.types === "./types/index.d.ts"
  && fs.existsSync(path.join(MOD, P.hooks)) && fs.existsSync(path.join(MOD, P.types)), JSON.stringify(P));
const H = read(MOD, "hooks", "hooks.json");
ok("mod hooks.json: one module, register.tsx", JSON.stringify(H) === JSON.stringify({ modules: ["./register.tsx"] }), JSON.stringify(H));
const main = read(ROOT, ".claude-plugin", "plugin.json");
ok("the main plugin's manifest names no mod", !JSON.stringify(main).includes("mods/"), JSON.stringify(main));

// ---- display only, read from the source with comments stripped
const raw = fs.readFileSync(path.join(MOD, "hooks", "register.tsx"), "utf8");
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const BANNED = [
  ["a hook on tool calls", /['"]tool\.call['"]/],
  ["a hook on tool checks", /['"]tool\.check['"]/],
  ["a permission event or API", /permission/i],
  ["config or settings", /\$\.(config|settings)\b|['"](config|settings)\./],
  ["a file write", /\$\.fs\.(write|append|mkdir|remove|rm|rename|copy|move)\b/],
  ["the network", /\$\.(network|http|fetch|net)\b|\bfetch\s*\(/],
  ["the tool API", /\$\.tool\./],
  ["a model call", /\$\.model\./],
];
for (const [what, re] of BANNED) ok(`register.tsx: no ${what}`, !re.test(src), (src.match(re) || [""])[0]);
const runs = src.match(/\$\.process\.\w+\s*\(/g) || [];
ok("register.tsx: exactly one process call, $.process.run", runs.length === 1 && /^\$\.process\.run/.test(runs[0]), JSON.stringify(runs));
ok("register.tsx: its argv is node, the status script and --json, with a timeout",
  /\$\.process\.run\(\s*\[\s*'node'\s*,\s*script\s*,\s*'--json'\s*\]\s*,\s*\{[^}]*timeoutMs:/.test(src), (src.match(/\$\.process\.run\([^\n]*/) || [""])[0]);
ok("register.tsx: script is only ever the status script's path", (src.match(/proteus-status\.js/g) || []).length === 3 && !/\$\.process\.run\([^\n]*\+/.test(src));
ok("register.tsx: the only prompt it submits is explainPrompt's", (src.match(/\$\.prompt\.\w+/g) || []).every((m) => m === "$.prompt.submit")
  && /\$\.prompt\.submit\(\{ text: explainPrompt\(w\.kind, w\.number\) \}\)/.test(src) && (src.match(/\$\.prompt\.submit/g) || []).length === 1);
ok("register.tsx: no Markdown or Link element", !/<(Markdown|Link)\b|\bMarkdown\b|\bLink\b/.test(src));

// ---- claude plugin validate and test, where the CLI is installed
const has = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true }).status === 0;
if (!has) console.log("NOTE claude not on PATH: skipped claude plugin validate and claude plugin test");
else {
  const claude = (args) => spawnSync("claude", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 300000, shell: process.platform === "win32" });
  let r = claude(["plugin", "validate", MOD]);
  ok("claude plugin validate passes", r.status === 0, (r.stdout || "") + (r.stderr || ""));
  r = claude(["plugin", "test", MOD]);
  const out = (r.stdout || "") + (r.stderr || "");
  ok("claude plugin test passes", r.status === 0 && /\b0 fail\b/.test(out) && !/\(fail\)/.test(out), out.slice(-3000));
}

lib.summary();
