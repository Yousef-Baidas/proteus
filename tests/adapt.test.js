// Adaptability eval (#170, #82): "works for any project" as a test. Each tests/fixtures/adapt/<name>.js builds a
// small git repo in a temp dir; <name>.json beside it declares what Proteus's deterministic code must decide for it:
// the teams it gets and does not get (proteus-teamfit.js and what install.js --plugin-setup copies), the --doctor
// rows, the gate commands setup proposes (null: Proteus derives none), the tier and security signoff of planned
// changes (classifyTier, tierMatch on the copied teams/ROUTING.md) and the fixture's ceremony (the baseline ratchet
// for a red suite, guest mode for a repo the human cannot push to). An expectation no code decides is null and
// names its reason under "gaps". Prints a score table (a row per fixture, a column per expectation) and fails on
// any miss. node tests/adapt.test.js (needs git). Fake HOME, gh and claude; never the network or the real ~/.claude.
// Opt-in model-backed run: PROTEUS_ADAPT_MODEL=1 lists each fixture's "model" expectations (scout roster, skill
// picks, gate commands) that such a run would score. It is not built: it needs a model, so it never runs in CI.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("adapt");
const INSTALL = path.join(ROOT, "install.js");
const TF = require(path.join(ROOT, "templates", "hooks", "proteus-teamfit.js"));
const HL = require(path.join(ROOT, "templates", "hooks", "proteus-lib.js"));
const FIX = path.join(__dirname, "fixtures", "adapt");
const SHIPPED = ["frontend", "backend", "devops", "security", "qa"];
const COLS = ["setup", "teams", "doctor", "gates", "tier", "security", "ceremony"];
const exists = (...p) => fs.existsSync(path.join(...p));
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return ""; } };
const both = (r) => `${r.out}${r.err}`;

// files {rel: text or Buffer} written under dir
function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

// a stub claude: logs every call; setup must not need one
lib.fakeCli(lib.BIN, "claude", `require("fs").appendFileSync(process.env.FAKE_CLAUDE_LOG, process.argv.slice(2).join(" ") + "\\n");\n`);

let built = 0;
function fresh(name, fx) {
  const d = path.join(W, `${name}-${++built}`);
  g(W, "init", "-q", "-b", "main", d);
  fx.build(d, { g, write });
  return d;
}

// one fixture's cells: { <col>: "ok" | "MISS" | "gap" | "-" } and the reason for each miss
function score(name) {
  const fx = require(path.join(FIX, `${name}.js`));
  const want = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));
  const env = want.env || {};
  const cells = {}, misses = [];
  const cell = (col, pass, why) => { cells[col] = pass ? "ok" : "MISS"; if (!pass) misses.push(`${col}: ${why}`); };
  const gaps = want.gaps || {};

  const dir = fresh(name, fx);
  const logs = { gh: path.join(W, `${name}.gh.log`), claude: path.join(W, `${name}.claude.log`) };
  const run = (args, cwd = dir, extra = {}) => lib.run(INSTALL, "", { cwd, args, env: { FAKE_GH_LOG: logs.gh, FAKE_CLAUDE_LOG: logs.claude, ...env, ...extra } });

  // setup: --plugin-setup exits 0, writes teams/ROUTING.md, runs no gh and no claude plugin command (a --version probe is fine)
  const s = run(["--plugin-setup"]);
  cell("setup", s.code === 0 && exists(dir, "teams", "ROUTING.md") && !exists(logs.gh) && !/^plugin\b/m.test(read(logs.claude)),
    `exit ${s.code}, ROUTING.md ${exists(dir, "teams", "ROUTING.md")}, gh ${read(logs.gh).trim() || "-"}, claude ${read(logs.claude).trim() || "-"} :: ${both(s).slice(-600)}`);

  // teams: the team-fit plan and the teams/ setup copied agree with must and mustNot, and each left out is named
  const a = TF.assess(dir);
  const t = want.teams || { must: [], mustNot: [] };
  const bad = [
    ...t.must.filter((p) => !(a.teams[p] && a.teams[p].fits && exists(dir, "teams", p))).map((p) => `${p} missing`),
    ...t.mustNot.filter((p) => (a.teams[p] && a.teams[p].fits) || exists(dir, "teams", p) || !new RegExp(`^left out ${p}: `, "m").test(s.out)).map((p) => `${p} present or not named as left out`),
    ...SHIPPED.filter((p) => !t.must.includes(p) && !t.mustNot.includes(p)).map((p) => `${p} undeclared`),
  ];
  cell("teams", !bad.length && !a.capped, `${bad.join(", ")}${a.capped ? `, capped: ${a.why}` : ""} :: ${JSON.stringify(a.teams)}`);

  // doctor: the rows a fixture decides (the machine's own rows, agent teams or plugins, are not the fixture's)
  const d = run(["--doctor"]);
  const rows = d.out.split(/\r?\n/);
  const doc = want.doctor || { ok: [], absent: [] };
  const dbad = [...doc.ok.filter((x) => !rows.some((l) => /^ok\s/.test(l) && l.includes(x))).map((x) => `no ok row "${x}"`),
    ...doc.absent.filter((x) => rows.some((l) => l.includes(x))).map((x) => `a row says "${x}"`)];
  cell("doctor", !dbad.length, `${dbad.join(", ")} :: ${d.out.slice(-1500)}`);

  // gates: null means Proteus proposes none, so setup must not have written a gates workflow either
  if (want.gates !== null) cell("gates", false, "an expected gate command, but no deterministic code derives one to check it against; set gates to null");
  else if (!gaps.gates) cell("gates", false, "null with no reason under gaps");
  else if (exists(dir, ".github", "workflows", "proteus-gates.yml")) cell("gates", false, "setup wrote .github/workflows/proteus-gates.yml");
  else cells.gates = "gap";

  // tier and security: each planned change against the tiers and security blocks of the ROUTING.md setup copied
  const routing = read(dir, "teams", "ROUTING.md");
  const tiers = HL.parseTiers(routing), sec = HL.parseSecurity(routing) || [];
  const tbad = [], sbad = [];
  for (const c of want.tier || []) {
    const changes = c.changes.map(([p, lines]) => ({ path: p, lines }));
    const got = HL.classifyTier(tiers, changes);
    if (got.tier !== c.tier) tbad.push(`${changes.map((x) => x.path).join("+")}: ${got.tier}, want ${c.tier} (${got.why.join("; ")})`);
    const needs = changes.some((x) => sec.some((glob) => HL.tierMatch(glob, x.path)));
    if (needs !== c.security) sbad.push(`${changes.map((x) => x.path).join("+")}: security ${needs}, want ${c.security}`);
  }
  if (want.tier) {
    cell("tier", !!tiers && !tiers.errors.length && !tbad.length, tiers ? tbad.join(", ") : "no tiers block in the copied ROUTING.md");
    cell("security", sec.length > 0 && !sbad.length, sec.length ? sbad.join(", ") : "no security block in the copied ROUTING.md");
  } else cells.tier = cells.security = "-";

  // ceremony
  const c = want.ceremony;
  if (!c) cells.ceremony = gaps.ceremony ? "gap" : "-";
  else if (c.kind === "baseline") {
    // the suite is red on main; the ratchet copied with teams/ records it, passes it, and fails a new failure
    const BL = path.join(dir, "teams", "templates", "hooks", "proteus-baseline.js");
    const cmd = ["--", process.execPath, ...c.command];
    const bl = (...args) => lib.run(BL, "", { cwd: dir, args: [c.gate, ...args, ...cmd] });
    const red = lib.run(path.join(dir, ...c.command[0].split("/")), "", { cwd: dir });
    const rec = bl("--record"), same = bl();
    fx.regress(dir, { g, write });
    const worse = bl();
    cell("ceremony", red.code !== 0 && rec.code === 0 && exists(dir, "teams", "baseline.json") && same.code === 0 && worse.code === 1,
      `suite exit ${red.code}; record ${rec.code} ${both(rec).slice(-300)}; same ${same.code} ${both(same).slice(-300)}; regression ${worse.code} ${both(worse).slice(-300)}`);
  } else if (c.kind === "guest") {
    // on a fresh copy: --project sees gh's READ and keeps every Proteus file outside the repo
    const gd = fresh(name, fx);
    const files = g(gd, "ls-files");
    const p = run(["--project"], gd);
    const guest = HL.guestDir(gd);
    const status = g(gd, "status", "--porcelain");
    cell("ceremony", p.code === 0 && !!guest && exists(guest, "teams", "ROUTING.md") && !exists(gd, "teams") && status === "" && g(gd, "ls-files") === files,
      `exit ${p.code}, guest dir ${guest || "-"}, teams/ in repo ${exists(gd, "teams")}, status ${JSON.stringify(status)} :: ${both(p).slice(-600)}`);
  } else cell("ceremony", false, `unknown ceremony kind ${c.kind}`);

  for (const col of COLS) if (!cells[col]) cells[col] = "-";
  return { name, cells, misses, want };
}

const names = fs.readdirSync(FIX).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3)).sort();
ok("the six fixtures the issue names are there, each with its expectations",
  ["binary", "do-not-modify", "docs-site", "legacy", "notebook", "one-line"].every((n) => names.includes(n) && exists(FIX, `${n}.json`)), names.join(", "));
const results = names.map(score);

// the score table
const width = Math.max(...names.map((n) => n.length), "fixture".length);
const line = (first, cells) => `${first.padEnd(width)}  ${cells.map((x, i) => x.padEnd(Math.max(COLS[i].length, 4))).join("  ")}`.trimEnd();
console.log(`adaptability eval (#170): ok = decided and right, MISS = decided and wrong, gap = no deterministic code decides it, - = not declared`);
console.log(line("fixture", COLS));
for (const r of results) console.log(line(r.name, COLS.map((col) => r.cells[col])));
// each gap once, with the fixtures that name it
const gapBy = new Map();
for (const r of results) for (const [k, why] of Object.entries(r.want.gaps || {})) gapBy.set(`${k}: ${why}`, [...(gapBy.get(`${k}: ${why}`) || []), r.name]);
if (gapBy.size) console.log(`gaps (decided by no code yet):\n${[...gapBy].map(([k, fx]) => `  [${fx.join(", ")}] ${k}`).join("\n")}`);

for (const r of results) {
  for (const col of COLS) ok(`${r.name}: ${col} is not a miss`, r.cells[col] !== "MISS", r.misses.filter((m) => m.startsWith(`${col}:`)).join(" | "));
}

// the documented hook for an opt-in model-backed run: not built, so it only names what such a run would score
if (process.env.PROTEUS_ADAPT_MODEL) {
  console.log("model-backed run: not built (it needs a model, so CI never runs it). It would score, per fixture:");
  for (const r of results) console.log(`  ${r.name}: ${JSON.stringify(r.want.model || {})}`);
}

lib.summary();
