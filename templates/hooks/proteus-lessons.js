#!/usr/bin/env node
// Hook: trigger-based recall of <main checkout or guest dir>/docs/lessons/*.md, so a solved
// problem never recurs and no session pays for lessons it does not hit.
// Lesson frontmatter: trigger (JS regex source, case-insensitive), on (command, output,
// prompt, path; default all), scope (all | lead | worker; default all).
// before a shell call → command; before an edit or read → path; after a shell call → output;
// prompt submit → prompt. A trigger with nested repetition (ReDoS) is skipped with a note on stderr, and input
// is cut at 20 KB. A hit injects the lesson as additionalContext, once per session
// (per subagent) per lesson, at most 2 per event; each hit is one line appended to <common>/proteus/lesson-hits.jsonl
// ({file, at}; append-only, so concurrent sessions never lose a count; sum per file when reading).
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const KINDS = ["command", "output", "prompt", "path"];
const MAX_PER_EVENT = 2;
const MAX_CHARS = 1500;
const OUTPUT_CAP = 20 * 1024;
const TEXT_CAP = 20 * 1024; // longest input a trigger is matched against; bounds a slow pattern's cost

if (process.env.PROTEUS === "0") process.exit(0);

lib.run((ev, ad) => {
  const root = lib.projectRoot(ev);
  let kind, text;
  if (ev.kind === "prompt") [kind, text] = ["prompt", ev.prompt];
  else if (ev.kind === "pre-tool" && ev.tool === "shell") [kind, text] = ["command", ev.command];
  else if (ev.kind === "pre-tool" && (ev.tool === "edit" || ev.tool === "read")) {
    [kind, text] = ["path", ev.paths.map((t) => lib.relPath(root, t) || String(t).split(path.sep).join("/")).join("\n")];
  } else if (ev.kind === "post-tool" && ev.tool === "shell") [kind, text] = ["output", capped(ev.output)];
  else return;
  if (typeof text !== "string" || !text) return;

  const common = lib.gitCommonDir(root);
  if (!common) return;
  const dir = path.join(lib.guestDir(root) || lib.mainRoot(common) || root, "docs", "lessons");
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return; }
  if (!names.length) return;

  const store = lib.stateDir(common);
  const scope = lib.isLead(ev, root) ? "lead" : "worker";
  const hits = [];
  for (const l of load(dir, names, store)) {
    if (!l.on.includes(kind) || (l.scope !== "all" && l.scope !== scope)) continue;
    let re;
    try { re = new RegExp(l.trigger, kind === "path" ? "im" : "i"); } catch { continue; } // a bad regex skips its lesson only; one path per line
    if (re.test(text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text)) hits.push(l);
  }

  const seenFile = path.join(store, "lessons-seen", String(ev.session || "none").replace(/[^\w.-]/g, "_") + (ev.agent ? "-" + String(ev.agent).replace(/[^\w.-]/g, "_") : ""));
  const seen = new Set(read(seenFile).split("\n").filter(Boolean));
  const fresh = hits.filter((l) => !seen.has(l.file)).slice(0, MAX_PER_EVENT);
  if (!fresh.length) return;

  if (!seen.size) prune(path.dirname(seenFile));
  fs.mkdirSync(path.dirname(seenFile), { recursive: true });
  fs.appendFileSync(seenFile, fresh.map((l) => l.file + "\n").join(""));
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(store, "lesson-hits.jsonl"), fresh.map((l) => JSON.stringify({ file: l.file, at: now }) + "\n").join(""));

  ad.context(ev, fresh.map((l) => {
    const body = l.body.length > MAX_CHARS ? l.body.slice(0, MAX_CHARS) + " …" : l.body;
    return `proteus lesson docs/lessons/${l.file} (matched this ${kind}):\n${body}`;
  }).join("\n\n"));
});

function read(f) { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }

// a shell call's output, head and tail kept when over the cap
function capped(s) {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP / 2) + "\n" + s.slice(-OUTPUT_CAP / 2) : s;
}

// parsed lessons, cached in <common>/proteus/lessons-cache.json keyed by the files' mtimes and sizes
function load(dir, names, store) {
  const key = names.map((f) => { try { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return f; } }).join("|");
  const cacheFile = path.join(store, "lessons-cache.json");
  const cache = lib.readJSON(cacheFile, null);
  if (cache && cache.key === key && Array.isArray(cache.lessons)) return cache.lessons;
  const lessons = [];
  for (const f of names) {
    try {
      const l = parse(f, read(path.join(dir, f)));
      if (!l) continue;
      if (unsafeRegex(l.trigger)) { process.stderr.write(`proteus lesson ${f}: trigger skipped, nested or overlapping repetition can backtrack without end\n`); continue; }
      lessons.push(l);
    } catch {}
  }
  lib.writeJSON(cacheFile, { key, lessons });
  return lessons;
}

// ReDoS screen for a trigger (JS regex source): a quantified group that holds a quantifier ((a+)+, (a*)*,
// (a{2,})+) or alternatives where one is another's prefix ((a|a)*, (a|ab)*) backtracks exponentially
function unsafeRegex(src) {
  const open = [];
  let cls = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (cls) { if (c === "]") cls = false; continue; }
    if (c === "[") cls = true;
    else if (c === "(") open.push(i);
    else if (c === ")" && open.length) {
      const from = open.pop();
      const rest = src.slice(i + 1);
      if (!/^(?:[*+]|\{\d+,\d*\})/.test(rest)) continue;
      const body = src.slice(from + 1, i).replace(/^\?(?::|<[^>]+>)/, "");
      if (/(?:^|[^\\])(?:[*+]|\{\d+,\d*\})/.test(body.replace(/\[(?:\\.|[^\]])*\]/g, "x"))) return true;
      const alts = splitAlts(body);
      if (alts.some((a, j) => alts.some((b, k) => j !== k && b.startsWith(a)))) return true;
    }
  }
  return false;
}

// a group's top-level alternatives
function splitAlts(body) {
  const out = [];
  let depth = 0, cls = false, cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { cur += c + (body[++i] || ""); continue; }
    if (cls) { if (c === "]") cls = false; } else if (c === "[") cls = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && !depth) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parse(file, src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!fm.trigger) return null;
  const on = (fm.on || "").split(/[\s,]+/).map((s) => s.toLowerCase()).filter((s) => KINDS.includes(s));
  const scope = ["lead", "worker"].includes((fm.scope || "").toLowerCase()) ? fm.scope.toLowerCase() : "all";
  return { file, trigger: fm.trigger, on: on.length ? on : KINDS, scope, body: m[2].trim() };
}

// seen-sets older than a week belong to dead sessions
function prune(d) {
  try {
    const cutoff = Date.now() - 7 * 864e5;
    for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); }
  } catch {}
}
