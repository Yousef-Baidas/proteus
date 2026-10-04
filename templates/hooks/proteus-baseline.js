#!/usr/bin/env node
// Baseline ratchet for a gate that was already red when Proteus arrived: run the gate's command, read its
// findings from the output, and fail only on findings the recorded baseline does not hold.
//   node teams/templates/hooks/proteus-baseline.js <gate> [options] -- <command…>
//     (no option)  compare: exit 0 when nothing is new, 1 on a new finding or an unexplained failure
//     --record     write the gate's baseline; on an existing one only tightens (refuses to add a finding)
//     --reset      write the gate's baseline from scratch, new findings included (the human's call)
//     --mode lines|count   --match <regex>   --ignore <regex>   (stored with the gate on record)
//     --file <path>        the baseline file (default teams/baseline.json in the checkout, or in the guest dir)
// Exit 0 from the command always passes; the ratchet judges red runs only. A gate with no baseline entry
// passes the command's exit code through, so an unrecorded gate stays strict.
// Modes, per gate:
//   lines: every output line matching `match` is a finding, compared as a multiset after stripping ANSI codes,
//          the checkout path, `ignore`, and digits (line numbers and timings move; the finding does not)
//   count: the sum of the numbers `match` captures (first group, every match) must not grow
// A gate that exited 0 at record time fails on any non-zero exit; a non-zero exit with no finding the
// parser recognises fails too, so a crash or a changed output format never passes as "nothing new".
// Exit 2 = usage error.
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const DEFAULT_MATCH = "\\b(?:FAIL(?:ED|URE)?|ERROR|Error|error|warning|not ok)\\b";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const SHOW = 20;

const usage = (msg) => {
  if (msg) console.error(`proteus-baseline: ${msg}`);
  console.error("usage: node proteus-baseline.js <gate> [--record|--reset] [--mode lines|count] [--match <re>] [--ignore <re>] [--file <path>] -- <command…>");
  process.exit(2);
};

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const opts = dash < 0 ? argv : argv.slice(0, dash);
const cmd = dash < 0 ? [] : argv.slice(dash + 1);
const gate = opts[0];
if (!gate || gate.startsWith("-") || !cmd.length) usage(!gate || gate.startsWith("-") ? "name the gate first" : "no command after --");
const flag = (name) => opts.includes(name);
const value = (name) => { const i = opts.indexOf(name); if (i < 0) return undefined; if (i + 1 >= opts.length) usage(`${name} needs a value`); return opts[i + 1]; };

const root = lib.gitRoot(process.cwd()) || process.cwd();
const file = path.resolve(value("--file") || process.env.PROTEUS_BASELINE || path.join(lib.docRoot(root), "teams", "baseline.json"));
const data = lib.readJSON(file, null) || {};
if (!data.gates || typeof data.gates !== "object") data.gates = {};
const old = data.gates[gate] && typeof data.gates[gate] === "object" ? data.gates[gate] : null;
const record = flag("--record") || flag("--reset");

const mode = value("--mode") || (old && old.mode) || "lines";
if (mode !== "lines" && mode !== "count") usage(`unknown mode ${mode}`);
const regex = (src, what) => { try { return new RegExp(src, "g"); } catch (e) { return usage(`bad ${what} regex: ${e.message}`); } };
const matchSrc = value("--match") || (old && old.match) || (mode === "count" ? "" : DEFAULT_MATCH);
if (!matchSrc) usage("count mode needs --match with a capture group, e.g. \"(\\d+) failed\"");
const ignoreSrc = value("--ignore") || (old && old.ignore) || "";
const match = regex(matchSrc, "--match");
const ignore = ignoreSrc ? regex(ignoreSrc, "--ignore") : null;

// the gate's command: one argument is a shell line ("npm ci && npm test"); several run as argv, through cmd on
// Windows only for a .cmd shim such as npx (proteus-lib spawnArgv).
const r = cmd.length === 1
  ? spawnSync(cmd[0], { cwd: process.cwd(), shell: true, encoding: "utf8", maxBuffer: 512 << 20, windowsHide: true, timeout: lib.envInt("PROTEUS_BASELINE_TIMEOUT", 3600000) })
  : lib.spawnArgv(cmd[0], cmd.slice(1), { cwd: process.cwd(), encoding: "utf8", maxBuffer: 512 << 20, windowsHide: true, timeout: lib.envInt("PROTEUS_BASELINE_TIMEOUT", 3600000) });
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if (r.error) { console.error(`proteus-baseline ${gate}: could not run the command: ${r.error.message}`); process.exitCode = 1; return; }
const exit = r.status === null ? 1 : r.status;
const lines = `${r.stdout || ""}\n${r.stderr || ""}`.replace(ANSI, "").split(/\r?\n/);

// findings in this run: normalised lines (lines mode) or one number (count mode)
const roots = [...new Set([root, root.split(path.sep).join("/")])];
const norm = (line) => {
  let s = line;
  for (const p of roots) s = s.split(p).join(".");
  if (ignore) s = s.replace(ignore, "");
  return s.replace(/\\/g, "/").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
};
const hit = (line) => { match.lastIndex = 0; return match.test(line); };
const found = mode === "lines" ? lines.filter(hit).map(norm).filter(Boolean).sort() : null;
// a match without a group counts its first number
const num = (m) => parseInt(m[1] === undefined ? (/\d+/.exec(m[0]) || ["0"])[0] : m[1], 10) || 0;
const count = mode === "count" ? lines.reduce((n, line) => [...line.matchAll(match)].reduce((s, m) => s + num(m), n), 0) : 0;
const empty = mode === "lines" ? !found.length : !count;

// multiset difference: entries of a not covered by b
const minus = (a, b) => {
  const left = new Map();
  for (const x of b) left.set(x, (left.get(x) || 0) + 1);
  return a.filter((x) => { const n = left.get(x) || 0; if (n) left.set(x, n - 1); return !n; });
};
const list = (xs) => xs.slice(0, SHOW).map((x) => `  ${x}`).join("\n") + (xs.length > SHOW ? `\n  … ${xs.length - SHOW} more` : "");
const say = (msg) => console.error(`proteus-baseline ${gate}: ${msg}`);
// a baseline outside the checkout (guest mode) is not committed
const commit = lib.relPath(root, file) ? ` and commit ${path.basename(file)}` : "";

// the verdict; exitCode rather than exit(), so the command's output drains first on a pipe
process.exitCode = verdict();
function verdict() {
  if (!record && !old) {
    if (exit !== 0) say(`exited ${exit}; no baseline recorded for this gate, so every failure counts.`);
    return exit === 0 ? 0 : 1;
  }
  if (exit !== 0 && empty) {
    say(`the command exited ${exit} and \`${matchSrc}\` finds nothing in its output, so this failure is not in the baseline. Fix it, or set --match to the runner's failure lines.`);
    return 1;
  }

  if (record) {
    if (old && !flag("--reset")) {
      const grew = mode === "lines" ? minus(found, Array.isArray(old.findings) ? old.findings : []) : count > (old.count || 0) ? [`count ${count} > ${old.count || 0}`] : [];
      if (grew.length || (old.exit === 0 && exit !== 0)) {
        say(`--record only tightens; these are not in the baseline:\n${list(grew.length ? grew : [`exit ${exit} (recorded green)`])}\nFix them, or --reset if the human accepts them.`);
        return 1;
      }
    }
    const entry = { mode, match: matchSrc };
    if (ignoreSrc) entry.ignore = ignoreSrc;
    if (mode === "lines") entry.findings = found; else entry.count = count;
    entry.exit = exit === 0 ? 0 : 1;
    entry.recorded = new Date().toISOString().slice(0, 10);
    data.gates[gate] = entry;
    lib.writeJSON(file, data);
    say(`recorded ${mode === "lines" ? `${found.length} finding${found.length === 1 ? "" : "s"}` : `count ${count}`} (exit ${exit}) in ${lib.relPath(root, file) ? `${lib.relPath(root, file)}; commit it` : file}.`);
    return 0;
  }

  if (exit === 0) {
    if (old && old.exit !== 0) say(`green; drop its baseline with --record${commit}.`);
    return 0;
  }
  if (old.exit === 0) {
    say(`exited ${exit}, but the gate was green when its baseline was recorded.${mode === "lines" && found.length ? `\n${list(found)}` : ""}`);
    return 1;
  }
  if (mode === "lines") {
    const base = Array.isArray(old.findings) ? old.findings : [];
    const added = minus(found, base), fixed = minus(base, found);
    if (added.length) {
      say(`${added.length} new finding${added.length === 1 ? "" : "s"} (${base.length} in the baseline):\n${list(added)}`);
      return 1;
    }
    say(`no new findings (${found.length} known${fixed.length ? `, ${fixed.length} fixed: tighten with --record${commit}` : ""}).`);
  } else {
    const was = old.count || 0;
    if (count > was) {
      say(`count ${count} > ${was} in the baseline.`);
      return 1;
    }
    say(`count ${count} (baseline ${was}${count < was ? `; tighten with --record${commit}` : ""}).`);
  }
  return 0;
}
