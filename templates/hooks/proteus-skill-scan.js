#!/usr/bin/env node
// The static skill scanner (#10): what a third-party skill ships, read as data, before a human approves it.
//   node <hooks>/proteus-skill-scan.js <skill dir> [--owner <o>] [--json] [--osv]
// Pure static analysis: nothing in the dir is run, imported or evaluated, and no symlink is followed (each one is
// a finding). Prints `SCAN <dir> files=<n> bytes=<n> sha256=<hash>` (lib.hashSkill, the skills lock's hash; `none`
// when the dir holds a link or special file), one `FINDING <kind> <path>[:<line>] <detail>` per finding, then
// `CLEAN` or `FINDINGS <n>`. Kinds:
// - file: any file that is not markdown (.md), dotfiles, links and special files included; a root LICENSE,
//   LICENSE.txt, LICENSE.md, COPYING or COPYING.txt (any case) is not one;
// - code: a fenced block tagged as a shell or script language, or an untagged one whose first line is a `$ ` prompt
//   or a known shell command;
// - hook: settings.json, hooks.json, a .claude/ or .agents/ dir, a `hooks` or `allowed-tools` frontmatter key;
// - host: a URL whose host is off the allowlist: github.com and raw.githubusercontent.com under --owner only (no
//   owner, no github), docs hosts by exact host, plus teams/skill-hosts.txt in the cwd, one host per line;
// - inject: prompt-injection phrasing, and zero-width or bidi control characters anywhere in a file;
// - license: no LICENSE file naming an OSI license and no OSI `license:` in SKILL.md's frontmatter;
// - deps: a dependency manifest; with --osv each lockfile also goes through osv-scanner (lib.osvArgs, as CI's scan
//   job runs it), one finding per vuln, and an osv-scanner that is missing or fails is a finding too.
// --json prints the same as one object { dir, files, bytes, sha256, findings: [{ kind, path, line, detail }], clean }.
// Exit 0 clean, 1 findings, 2 bad usage or a dir that is not a directory.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const USAGE = "usage: node proteus-skill-scan.js <skill dir> [--owner <o>] [--json] [--osv]";

const CODE_TAGS = ["sh", "bash", "zsh", "fish", "shell", "console", "powershell", "ps1", "cmd", "bat", "python", "js", "node", "ts",
  "py", "python3", "javascript", "mjs", "typescript", "pwsh", "batch", "sh-session", "shellsession"];
const SHELL_CMDS = ["curl", "wget", "rm", "chmod", "sudo", "npx", "pip", "npm", "git", "eval"];
const HOOK_FILES = ["settings.json", "hooks.json"];
const HOOK_DIRS = [".claude", ".agents"];
const HOOK_KEYS = ["hooks", "allowed-tools"];
// owner: the host passes only under the skill's own owner, the first path segment
const HOSTS = [{ host: "github.com", owner: true }, { host: "raw.githubusercontent.com", owner: true }, { host: "code.claude.com" }, { host: "docs.anthropic.com" }];
const INJECT = [/ignore (all )?(previous|prior|above) instructions/i, /disregard/i, /you must now/i, /do not (tell|inform) the user/i,
  /without (asking|telling)/i, /system prompt/i, /new instructions/i, /override/i];
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const SPDX = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "AGPL-3.0", "Unlicense", "CC0-1.0"];
// a LICENSE file's key phrase per id, matched on its text with whitespace collapsed; the more specific first
const LICENSE_TEXT = [
  ["AGPL-3.0", /GNU AFFERO GENERAL PUBLIC LICENSE Version 3/i],
  ["LGPL-3.0", /GNU LESSER GENERAL PUBLIC LICENSE Version 3/i],
  ["LGPL-2.1", /GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1/i],
  ["GPL-3.0", /GNU GENERAL PUBLIC LICENSE Version 3/i],
  ["GPL-2.0", /GNU GENERAL PUBLIC LICENSE Version 2/i],
  ["Apache-2.0", /Apache License,? Version 2\.0/i],
  ["MPL-2.0", /Mozilla Public License,? (Version|v\.) 2\.0/i],
  ["MIT", /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  ["ISC", /Permission to use, copy, modify, and(\/or)? distribute this software for any purpose/i],
  ["BSD-3-Clause", /Redistribution and use in source and binary forms.*Neither the name of/i],
  ["BSD-2-Clause", /Redistribution and use in source and binary forms/i],
  ["Unlicense", /This is free and unencumbered software released into the public domain/i],
  ["CC0-1.0", /CC0 1\.0 Universal/i],
];
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
// license files at the root are text, not a `file` finding
const LICENSE_EXEMPT = ["license", "license.txt", "license.md", "copying", "copying.txt"];
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod"];
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}]+/gi;

// untrusted text as one inert line: control and invisible characters become ?
const inert = (s) => String(s).replace(/\p{Cc}/gu, "?").replace(INVISIBLE, "?");
const isMd = (name) => !name.startsWith(".") && /\.md$/i.test(name);
const lines = (text) => text.split(/\r?\n/);

// the frontmatter's top-level keys: [{ key, value, line }], [] without one
function frontmatter(text) {
  const ls = lines(text.replace(/^\uFEFF/, ""));
  if (ls[0].trim() !== "---") return [];
  const out = [];
  for (let i = 1; i < ls.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(ls[i])) return out;
    const m = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(ls[i]);
    if (m) out.push({ key: m[1], value: m[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2"), line: i + 1 });
  }
  return [];
}

// fenced blocks: [{ line, tag, first }], first being the block's first non-blank line
function fences(text) {
  const out = [];
  let open = null;
  lines(text).forEach((l, i) => {
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) open = { fence: m[1], line: i + 1, tag: (m[2].trim().split(/[\s{,]/)[0] || "").toLowerCase(), first: null };
      return;
    }
    const close = new RegExp(`^ {0,3}${open.fence[0] === "`" ? "`" : "~"}{${open.fence.length},}\\s*$`);
    if (close.test(l)) { out.push(open); open = null; return; }
    if (open.first === null && l.trim()) open.first = l.trim();
  });
  if (open) out.push(open);
  return out;
}

function main(argv) {
  const opt = { extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log(USAGE); return 0; }
    if (a === "--json" || a === "--osv") opt[a.slice(2)] = true;
    else if (a === "--owner" && i + 1 < argv.length) opt.owner = argv[++i];
    else if (a.startsWith("-")) { console.error(USAGE); return 2; }
    else opt.extra.push(a);
  }
  if (opt.extra.length !== 1 || (opt.owner !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(opt.owner))) { console.error(USAGE); return 2; }
  const arg = opt.extra[0];
  let dir;
  try { dir = fs.realpathSync(path.resolve(arg)); if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory"); } catch (e) {
    console.error(`proteus-skill-scan: ${inert(arg)} is not a directory (${e.code || e.message})`);
    return 2;
  }

  const findings = [];
  const find = (kind, rel, line, detail) => findings.push({ kind, path: inert(rel), line: line || null, detail: inert(detail) });
  const owner = (opt.owner || "").toLowerCase();
  const extra = [];
  try {
    for (const l of lines(fs.readFileSync(path.join(process.cwd(), "teams", "skill-hosts.txt"), "utf8"))) {
      const h = l.replace(/#.*$/, "").trim().toLowerCase();
      if (/^[a-z0-9.-]+$/.test(h)) extra.push({ host: h });
    }
  } catch {}
  const hosts = [...HOSTS, ...extra];
  const allowed = (u) => hosts.some((h) => h.host === u.hostname.replace(/\.$/, "").toLowerCase()
    && (!h.owner || (owner && u.pathname.split("/")[1] && u.pathname.split("/")[1].toLowerCase() === owner)));

  // the walk: lstat only, so a link is reported and never followed; the root's .git is the checkout, not the skill
  const files = [];
  let bytes = 0, pinnable = true;
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch (e) {
      find("file", rel || ".", null, `unreadable directory (${e.code || e.message})`); pinnable = false; return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === ".git" && e.isDirectory()) continue;
      if (e.isSymbolicLink()) { find("file", r, null, "symlink, not followed"); pinnable = false; continue; }
      if (e.isDirectory()) {
        if (HOOK_DIRS.includes(e.name)) find("hook", `${r}/`, null, "agent config directory");
        walk(path.join(abs, e.name), r);
        continue;
      }
      if (!e.isFile()) { find("file", r, null, "not a regular file"); pinnable = false; continue; }
      files.push(r);
    }
  };
  walk(dir, "");

  let skillMd = null;
  for (const rel of files) {
    const name = path.posix.basename(rel);
    let buf;
    try { buf = fs.readFileSync(path.join(dir, ...rel.split("/"))); } catch (e) { find("file", rel, null, `unreadable (${e.code || e.message})`); pinnable = false; continue; }
    bytes += buf.length;
    const text = buf.toString("utf8");
    if (!isMd(name) && !(rel === name && LICENSE_EXEMPT.includes(name.toLowerCase()))) find("file", rel, null, "not markdown");
    if (HOOK_FILES.includes(name.toLowerCase())) find("hook", rel, null, "hook or settings file");
    if (MANIFESTS.includes(name)) find("deps", rel, null, "dependency manifest");
    lines(text).forEach((l, i) => {
      const chars = [...new Set(((i === 0 ? l.replace(/^\uFEFF/, "") : l).match(INVISIBLE) || []))];
      if (chars.length) find("inject", rel, i + 1, `invisible ${chars.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ")}`);
    });
    if (!isMd(name)) continue;
    if (rel === "SKILL.md") skillMd = text;
    for (const f of frontmatter(text)) if (HOOK_KEYS.includes(f.key)) find("hook", rel, f.line, `frontmatter key ${f.key}`);
    for (const b of fences(text)) {
      if (CODE_TAGS.includes(b.tag)) find("code", rel, b.line, `fenced ${b.tag} block`);
      else if (!b.tag && b.first && b.first.startsWith("$ ")) find("code", rel, b.line, "untagged block with a $ prompt");
      else if (!b.tag && b.first && SHELL_CMDS.includes(b.first.split(/\s+/)[0])) find("code", rel, b.line, `untagged block running ${b.first.split(/\s+/)[0]}`);
    }
    lines(text).forEach((l, i) => {
      for (const m of l.match(URL_RE) || []) {
        let u = null;
        try { u = new URL(m.replace(/[.,;:!?*_~]+$/, "")); } catch {}
        if (!u) find("host", rel, i + 1, `unparsable URL ${m.slice(0, 120)}`);
        else if (!allowed(u)) find("host", rel, i + 1, `${u.hostname} not on the allowlist`);
      }
      for (const re of INJECT) { const m = re.exec(l); if (m) find("inject", rel, i + 1, `"${m[0].toLowerCase()}"`); }
    });
  }

  // license: a root LICENSE file with an OSI key phrase, else an OSI id in SKILL.md's frontmatter
  const licenseFiles = files.filter((r) => !r.includes("/") && LICENSE_FILE.test(r));
  const byText = licenseFiles.some((r) => {
    try { const t = fs.readFileSync(path.join(dir, r), "utf8").replace(/\s+/g, " "); return LICENSE_TEXT.some(([, re]) => re.test(t)); } catch { return false; }
  });
  const declared = skillMd ? (frontmatter(skillMd).find((f) => f.key === "license") || {}).value : undefined;
  const byId = declared !== undefined && SPDX.some((id) => id.toLowerCase() === String(declared).toLowerCase());
  if (!byText && !byId) {
    find("license", licenseFiles[0] || (skillMd !== null ? "SKILL.md" : "."), null,
      licenseFiles.length ? "LICENSE text matches no OSI license on the list" : declared ? `license: ${String(declared).slice(0, 60)} is not an OSI id on the list` : "no LICENSE file and no license: in SKILL.md");
  }

  if (opt.osv) osv(dir, files.filter(lib.osvLockfile), find);

  const sha = pinnable ? lib.hashSkill(dir) : "none";
  const head = { dir: inert(arg), files: files.length, bytes, sha256: sha };
  if (opt.json) console.log(JSON.stringify({ ...head, findings, clean: !findings.length }));
  else {
    console.log(`SCAN ${head.dir} files=${head.files} bytes=${head.bytes} sha256=${head.sha256}`);
    for (const f of findings) console.log(`FINDING ${f.kind} ${f.path}${f.line ? `:${f.line}` : ""} ${f.detail}`);
    console.log(findings.length ? `FINDINGS ${findings.length}` : "CLEAN");
  }
  return findings.length ? 1 : 0;
}

// --osv: each lockfile through osv-scanner on its own, so every result belongs to it; config and report in a fresh
// temp dir outside the skill, removed after
function osv(dir, locks, find) {
  if (!locks.length) return;
  if (!lib.which("osv-scanner")) { for (const r of locks) find("deps", r, null, "osv-scanner not installed; its vulns are unknown"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proteus-skill-osv-"));
  try {
    const config = path.join(tmp, "osv-scanner.toml");
    fs.writeFileSync(config, "");
    for (const rel of locks) {
      const report = path.join(tmp, "osv.sarif");
      fs.rmSync(report, { force: true });
      const r = lib.spawnArgv("osv-scanner", lib.osvArgs([`./${rel}`], config, report), { cwd: dir, encoding: "utf8", windowsHide: true, timeout: lib.envInt("PROTEUS_SCAN_TIMEOUT", 600000) });
      if (lib.OSV_CLEAN.includes(r.status)) continue;
      let ids = null;
      if (!r.error && lib.OSV_OK.includes(r.status)) {
        try { ids = JSON.parse(fs.readFileSync(report, "utf8")).runs.flatMap((run) => (run.results || []).map((x) => String(x.ruleId || "unknown"))); } catch {}
      }
      if (!ids) { find("deps", rel, null, `osv-scanner exited ${r.status === null ? (r.error && r.error.code) || r.signal : r.status} without a readable report; its vulns are unknown`); continue; }
      for (const id of new Set(ids)) find("deps", rel, null, `osv ${id}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

process.exitCode = main(process.argv.slice(2));
