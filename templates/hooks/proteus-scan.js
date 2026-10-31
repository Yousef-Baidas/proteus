#!/usr/bin/env node
// The scanners of proteus-trust.yml's scan job, whose artifact the post job's proteus-security.js reads:
//   node teams/templates/hooks/proteus-scan.js --dir <checkout> --out <dir> --base <sha> --head <sha> [--require]
//   node teams/templates/hooks/proteus-scan.js --dir <checkout> --out <dir> --all
// <checkout> is the PR head, checked out as data: the scanners read it and nothing in it runs. The changed files are
// git diff base...head there (what the PR's files list shows), a symlink turned file included, regular files only,
// never a symlink:
// - semgrep, rulesets p/owasp-top-ten and p/secrets, on the changed files;
// - gitleaks on the commits base..head, so a secret a later commit deleted is still found, read from a mirror clone of
//   the checkout's repository (no working tree, so no .gitleaksignore the PR adds);
// - osv-scanner on the changed lockfiles (requirements-*.txt and requirements/*.txt too), call analysis off, so it
//   runs no go or cargo on the head;
// - zizmor on the changed workflows under .github/workflows/ and composite actions' action.yml, else actionlint on
//   the workflows.
// Each writes <out>/<tool>.sarif with paths relative to <checkout>; proteus-security.js --findings <out> reads them.
// A tool with nothing to scan logs one skip line and passes, and so does one that is not installed unless --require
// (CI installs them all, so a missing one there is a broken install, not an absent ecosystem).
// The PR cannot quiet a scanner: nothing it can write is read as config, ignore list or inline suppression (semgrep
// --disable-nosem and no .semgrepignore; gitleaks's config and ignore file from <out>, --ignore-gitleaks-allow and no
// working tree; osv-scanner's and actionlint's config from <out>; zizmor --no-config --no-ignores).
// --all scans every tracked file, lockfile and workflow instead, for the baseline's record (enforcement.md §4);
// gitleaks, which reads a PR's commits, is skipped there.
// A failure that quotes git's or a scanner's output prints it between ::stop-commands:: markers (lib.fenced), each
// of its lines after a fixed proteus-scan: prefix with control characters as ?, so none can start a workflow command.
// Exit 0 every tool ran or was skipped, 1 a tool failed, git could not list the changes or the mirror lacks the
// base or head commit, 2 bad usage.
"use strict";
const fs = require("fs");
const path = require("path");
const url = require("url");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: proteus-scan.js --dir <checkout> --out <dir> (--base <sha> --head <sha> | --all) [--require]";
const SHA = /^[0-9a-f]{40}$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION = /(^|\/)action\.ya?ml$/;
const say = (msg) => console.log(`proteus-scan: ${msg}`);
// head text as one line: a control character becomes ?, so a \r or newline in it cannot start another
const inert = (s) => String(s).replace(/\p{Cc}/gu, "?");
// a failure, fenced (lib.fenced): it may quote git's or a scanner's output, and so a head path; quoted lines go first,
// every line after the prefix
const fail = (msg, quoted = []) => {
  lib.fenced([...quoted, msg].flatMap((l) => String(l).split(/\r?\n/)).map((l) => `proteus-scan: ${inert(l)}`), console.error);
  return 1;
};

// name runs from PATH: a file there, with a PATHEXT extension on win32
const onPath = (name) => (process.env.PATH || "").split(path.delimiter).filter(Boolean).some((d) =>
  (process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""]).some((e) => {
    try { return fs.statSync(path.join(d, name + e)).isFile(); } catch { return false; }
  }));

// a SARIF location as a path relative to the checkout: osv-scanner writes file:// URIs, others ./ or a bare path
function relUri(dir, uri) {
  let p = String(uri || "");
  try { p = p.startsWith("file:") ? url.fileURLToPath(p) : decodeURI(p); } catch {}
  if (path.isAbsolute(p)) { let real = p; try { real = fs.realpathSync(p); } catch {} const r = lib.relPath(dir, real); if (r) p = r; }
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all" || a === "--require") opt[a.slice(2)] = true;
    else if (["--dir", "--out", "--base", "--head"].includes(a) && i + 1 < argv.length) opt[a.slice(2)] = argv[++i];
    else { console.error(USAGE); return 2; }
  }
  if (!opt.dir || !opt.out || (opt.all ? opt.base || opt.head : !SHA.test(opt.base || "") || !SHA.test(opt.head || ""))) { console.error(USAGE); return 2; }
  let dir = path.resolve(opt.dir);
  try { dir = fs.realpathSync(dir); } catch {}
  const out = path.resolve(opt.out);
  fs.mkdirSync(out, { recursive: true });

  const listed = lib.spawnArgv("git", ["-C", dir, "-c", "core.quotepath=off", ...(opt.all ? ["ls-files", "-z"] : ["diff", "--name-only", "-z", "--diff-filter=ACMRT", `${opt.base}...${opt.head}`])],
    { encoding: "utf8", maxBuffer: 256 << 20, windowsHide: true });
  if (listed.error || listed.status !== 0) return fail(`git cannot list the ${opt.all ? "tracked" : "changed"} files in ${dir}: ${(listed.stderr || (listed.error && listed.error.message) || "").trim()}`);
  const regular = (p) => { try { return fs.lstatSync(path.join(dir, p)).isFile(); } catch { return false; } };
  const files = listed.stdout.split("\0").filter(Boolean).filter(regular);
  const what = opt.all ? "tracked" : "changed";

  // the empty config and ignore files the scanners get instead of any in the checkout
  const empty = (name, text = "") => { const f = path.join(out, name); fs.writeFileSync(f, text); return f; };

  // gitleaks's source: a mirror of the checkout's repository, no working tree, so it has no .gitleaksignore of the PR's to read
  const HEAD_GIT = path.join(out, "gitleaks-head.git");

  // pick: the files a tool scans (gitleaks scans the commit range instead); clean: the exits that mean nothing to check
  const tools = [
    { name: "semgrep", pick: files, none: `no ${what} file`,
      args: (t, report) => ["scan", "--config", "p/owasp-top-ten", "--config", "p/secrets", "--metrics", "off", "--disable-version-check", "--disable-nosem",
        "--x-ignore-semgrepignore-files", "--quiet", "--sarif-output", report, ...t], ok: [0, 1] },
    { name: "gitleaks", range: !opt.all, none: "it reads a PR's commits, and --all has none", bare: true,
      args: (_, report) => ["git", HEAD_GIT, `--log-opts=${opt.base}..${opt.head}`, "--config", empty("gitleaks.toml", "[extend]\nuseDefault = true\n"),
        "--gitleaks-ignore-path", empty("gitleaks.ignore"), "--ignore-gitleaks-allow", "--redact", "--no-banner", "--exit-code", "0",
        "--report-format", "sarif", "--report-path", report], ok: [0] },
    { name: "osv-scanner", pick: files.filter(lib.osvLockfile), none: `no lockfile ${what}`,
      args: (t, report) => lib.osvArgs(t, empty("osv-scanner.toml"), report), ok: lib.OSV_OK, clean: lib.OSV_CLEAN },
    // zizmor also audits a composite action's action.yml; actionlint reads workflows only
    { name: "zizmor", alt: "actionlint", pick: files.filter((p) => WORKFLOW.test(p) || ACTION.test(p)), none: `no workflow or action ${what}`,
      args: (t) => ["--offline", "--no-config", "--no-ignores", "--format", "sarif", ...t], stdout: true, ok: [0], clean: [3] },
  ];

  for (const t of tools) {
    if (!t.range && !(t.pick || []).length) { say(`${t.name} skipped: ${t.none}`); continue; }
    const name = onPath(t.name) ? t.name : t.alt && onPath(t.alt) ? t.alt : null;
    if (!name) {
      if (opt.require) return fail(`${t.name}${t.alt ? ` (or ${t.alt})` : ""} is not installed, and --require needs it`);
      say(`${t.name} skipped: not installed`);
      continue;
    }
    const report = path.join(out, `${name}.sarif`);
    fs.rmSync(report, { force: true });
    // every target as ./path, so a file named like a flag stays a path
    const list = (t.pick || []).filter((p) => name !== "actionlint" || WORKFLOW.test(p)).map((p) => `./${p}`);
    if (t.pick && !list.length) { say(`${name} skipped: ${t.none}`); continue; }
    const args = name === "actionlint" ? ["-no-color", "-config-file", empty("actionlint.yaml", "{}\n"), "-format", "{{json .}}", ...list] : t.args(list, report);
    if (t.bare) {
      fs.rmSync(HEAD_GIT, { recursive: true, force: true });
      const c = lib.spawnArgv("git", ["clone", "-q", "--mirror", "--no-local", dir, HEAD_GIT], { encoding: "utf8", windowsHide: true });
      if (c.error || c.status !== 0) return fail(`git cannot copy ${dir} for ${name}: ${(c.stderr || (c.error && c.error.message) || "").trim()}`);
      // gitleaks logs an unknown commit and reports no leaks, so a commit missing from the mirror fails here instead
      const missing = [opt.base, opt.head].filter((s) => lib.spawnArgv("git", ["-C", HEAD_GIT, "cat-file", "-e", `${s}^{commit}`], { encoding: "utf8", windowsHide: true }).status !== 0);
      if (missing.length) {
        fs.rmSync(HEAD_GIT, { recursive: true, force: true });
        return fail(`the copy of ${dir} for ${name} lacks the commit ${missing.join(" and ")}; its findings are unknown`);
      }
    }
    const r = lib.spawnArgv(name, args, { cwd: t.bare ? out : dir, encoding: "utf8", maxBuffer: 256 << 20, windowsHide: true, timeout: lib.envInt("PROTEUS_SCAN_TIMEOUT", 1800000) });
    if (t.bare) fs.rmSync(HEAD_GIT, { recursive: true, force: true });
    const why = `${name} exited ${r.status === null ? (r.error && r.error.message) || r.signal : r.status}`;
    if ((t.clean || []).includes(r.status)) { say(`${name}: nothing to check in ${list.length} ${what} file(s)`); continue; }
    if (r.error || !(name === "actionlint" ? [0, 1] : t.ok).includes(r.status)) {
      // its stderr may quote a head path: fenced with the failure
      return fail(`${why}; its findings are unknown`, String(r.stderr || "").split(/\r?\n/).filter(Boolean).map((l) => `${name}: ${l}`));
    }
    let sarif;
    try {
      if (name === "actionlint") {
        const errs = JSON.parse(r.stdout || "[]");
        sarif = { version: "2.1.0", runs: [{ tool: { driver: { name: "actionlint" } }, results: errs.map((e) => ({ ruleId: e.kind, message: { text: e.message },
          locations: [{ physicalLocation: { artifactLocation: { uri: e.filepath }, region: { startLine: e.line } } }] })) }] };
      } else sarif = JSON.parse(t.stdout ? r.stdout : fs.readFileSync(report, "utf8"));
      if (!Array.isArray(sarif.runs)) throw new Error("no runs");
    } catch (e) { return fail(`${why} without a readable SARIF report: ${e.message}`); }
    let n = 0;
    for (const run of sarif.runs) for (const res of run.results || []) {
      n++;
      for (const loc of res.locations || []) {
        const a = loc && loc.physicalLocation && loc.physicalLocation.artifactLocation;
        if (a && a.uri) a.uri = relUri(dir, a.uri);
      }
    }
    fs.writeFileSync(report, JSON.stringify(sarif));
    say(`${name}: ${n} finding${n === 1 ? "" : "s"} in ${t.range ? `${opt.base.slice(0, 12)}..${opt.head.slice(0, 12)}` : `${list.length} ${what} file(s)`}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
