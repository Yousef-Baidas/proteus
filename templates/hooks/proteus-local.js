#!/usr/bin/env node
// The `gh` stand-in for a repo in local mode (#310). A library and a CLI: the launchers proteus-local/bin/gh and
// gh.cmd run this file with gh's arguments, and lib.gh reaches it the same way, so a script keeps its flow:
//   node <hooks>/proteus-local.js <gh args...>    issue, label, pr, auth status, repo view, api (the paths below)
//   node <hooks>/proteus-local.js --init          make the mode marker (proteus-lead/local-mode), the store, the origin and the launchers; idempotent
// proteus-local-pr.js holds PRs, statuses, the bare origin and local checks, and their internal entries.
// Everything lives in <git-common-dir>/proteus-local/, one per project and machine, never committed: `mode` marks the
// repo (lib.localMode), bin/ holds the launchers, tracker/ the store: meta.json (the next numbers), labels.json,
// milestones.json, issues/<n>.json. Agents can reach all of it, so it is a working log and not proof: every read goes
// through the untrusted reader with a size cap and re-validates every field. A write is a fresh temp file renamed over
// the name, under a lock taken with wx, so parallel runs lose nothing and reuse no number. Numbers are shared by
// issues and PRs and never reused. It never touches the network and never runs a real gh.
// Exit 0 done; 1 anything else: not in local mode, a link on the path, a malformed store, a filter it cannot run, or
// a command or flag outside the supported set, named as `proteus local mode: gh <what> is not supported`. A gap is
// never an empty success. The hooks' fail-open rule does not apply: callers read a failure as an unreachable tracker.
// `pr checks` also exits 8, as gh does, while a check is pending.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const LOGIN = "local";
const MAX_TITLE = 256, MAX_BODY = 65536, MAX_FILE = 8 << 20, MAX_INDEX = 1 << 20, MAX_ENTRIES = 100000;
const LOCK_STALE_MS = 15000, LOCK_WAIT_MS = 30000;
const DEFAULT_COLOR = "ededed";
const SCRIPT = path.join(__dirname, "proteus-local.js");

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const unsupported = (what) => fail(`proteus local mode: gh ${what} is not supported`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// ---- filters: the part of jq that gh's --jq and -q need. A filter compiles to v => outputs. Anything else is a
// parse error, so an unsupported expression is an error and never an empty result.
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const truthy = (v) => v !== null && v !== false;
const RANK = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };
function order(a, b) {
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) return RANK[ta] - RANK[tb];
  if (ta === "array") {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = order(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (ta === "object") return order(Object.keys(a).sort().map((k) => [k, a[k]]), Object.keys(b).sort().map((k) => [k, b[k]]));
  return a < b ? -1 : a > b ? 1 : 0;
}
const COMPARE = { "==": (c) => c === 0, "!=": (c) => c !== 0, "<": (c) => c < 0, "<=": (c) => c <= 0, ">": (c) => c > 0, ">=": (c) => c >= 0 };
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };

function tokenize(src) {
  const toks = [];
  let i = 0;
  const str = () => {
    const parts = [];
    let text = "";
    for (i++; ; i++) {
      if (i >= src.length) throw new Error("unterminated string");
      const c = src[i];
      if (c === '"') { i++; break; }
      if (c !== "\\") { text += c; continue; }
      const e = src[++i];
      if (e === "(") {
        const start = ++i;
        let depth = 1, quoted = false;
        for (; i < src.length && depth; i++) {
          if (quoted) { if (src[i] === "\\") i++; else if (src[i] === '"') quoted = false; } else if (src[i] === '"') quoted = true;
          else if (src[i] === "(") depth++; else if (src[i] === ")") depth--;
        }
        if (depth) throw new Error("unterminated interpolation");
        if (text) parts.push(text);
        text = "";
        parts.push(parse(src.slice(start, --i)));
      } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) { text += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)); i += 4; } else if (e in ESCAPES) text += ESCAPES[e];
      else throw new Error("bad escape");
    }
    if (text || !parts.length) parts.push(text);
    return { t: "str", parts };
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^\s+/.exec(rest))) i += m[0].length;
    else if (rest[0] === '"') toks.push(str());
    else if ((m = /^\.([A-Za-z_]\w*)/.exec(rest))) { toks.push({ t: "field", v: m[1] }); i += m[0].length; } else if ((m = /^-?\d+(?:\.\d+)?/.exec(rest))) { toks.push({ t: "num", v: Number(m[0]) }); i += m[0].length; } else if ((m = /^[A-Za-z_]\w*/.exec(rest))) { toks.push({ t: "id", v: m[0] }); i += m[0].length; } else if ((m = /^(?:\/\/|==|!=|<=|>=|[.[\]{}()|,:?<>])/.exec(rest))) { toks.push({ t: m[0] }); i += m[0].length; } else throw new Error(`unexpected ${rest[0]}`);
  }
  return toks;
}

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = (t) => toks[p] && toks[p].t === t;
  const eat = (t) => (peek(t) ? toks[p++] : null);
  const need = (t) => eat(t) || (() => { throw new Error(`expected ${t}`); })();
  const word = (w) => peek("id") && toks[p].v === w && !!++p;
  const pipe = () => {
    const f = comma();
    if (!eat("|")) return f;
    const g = pipe();
    return (v) => f(v).flatMap(g);
  };
  const comma = () => {
    const list = [alt()];
    while (eat(",")) list.push(alt());
    return list.length === 1 ? list[0] : (v) => list.flatMap((f) => f(v));
  };
  const alt = () => {
    const f = or();
    if (!eat("//")) return f;
    const g = alt();
    return (v) => {
      let got = [];
      try { got = f(v).filter(truthy); } catch {}
      return got.length ? got : g(v);
    };
  };
  const logic = (name, next, join) => () => {
    let f = next();
    while (word(name)) {
      const a = f, b = next();
      f = (v) => a(v).flatMap((x) => join(truthy(x), () => b(v).map(truthy)));
    }
    return f;
  };
  const cmp = () => {
    const f = term();
    const op = toks[p] && COMPARE[toks[p].t];
    if (!op) return f;
    p++;
    const g = term();
    return (v) => g(v).flatMap((y) => f(v).map((x) => op(order(x, y))));
  };
  const and = logic("and", cmp, (x, rhs) => (x ? rhs() : [false]));
  const or = logic("or", and, (x, rhs) => (x ? [true] : rhs()));
  const field = (k) => (v) => {
    if (v === null) return [null];
    if (typeOf(v) !== "object") throw new Error(`cannot index ${typeOf(v)} with "${k}"`);
    return [Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null];
  };
  const index = (v, k) => {
    if (typeof k === "string") return field(k)(v)[0];
    if (v === null) return null;
    if (!Array.isArray(v) || typeof k !== "number") throw new Error(`cannot index ${typeOf(v)} with ${typeOf(k)}`);
    const n = Math.floor(k), e = v[n < 0 ? v.length + n : n];
    return e === undefined ? null : e;
  };
  const iterate = (v) => {
    if (Array.isArray(v)) return v;
    if (typeOf(v) === "object") return Object.values(v);
    throw new Error(`cannot iterate over ${typeOf(v)}`);
  };
  const strFilter = (tok) => (v) => tok.parts.reduce((acc, part) => {
    const vals = typeof part === "string" ? [part] : part(v).map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    return acc.flatMap((a) => vals.map((x) => a + x));
  }, [""]);
  const suffixes = (first) => {
    let f = first;
    for (;;) {
      const a = f;
      let tok;
      if ((tok = eat("field"))) { const g = field(tok.v); f = (v) => a(v).flatMap(g); } else if (eat(".")) {
        const s = need("str"), key = strFilter(s);
        f = (v) => a(v).flatMap((x) => key(v).map((k) => index(x, k)));
      } else if (eat("[")) {
        if (eat("]")) { f = (v) => a(v).flatMap(iterate); continue; }
        const key = pipe();
        need("]");
        f = (v) => a(v).flatMap((x) => key(v).map((k) => index(x, k)));
      } else if (eat("?")) {
        f = (v) => { try { return a(v); } catch { return []; } };
      } else return f;
    }
  };
  const FUNCS = {
    empty: () => [],
    not: (v) => [!truthy(v)],
    length: (v) => {
      if (v === null) return [0];
      if (typeof v === "string") return [[...v].length];
      if (Array.isArray(v)) return [v.length];
      if (typeof v === "object") return [Object.keys(v).length];
      if (typeof v === "number") return [Math.abs(v)];
      throw new Error(`${typeOf(v)} has no length`);
    },
  };
  const object = () => {
    const entries = [];
    do {
      let key, tok;
      if ((tok = eat("id"))) key = () => [tok.v];
      else if ((tok = eat("str"))) key = strFilter(tok);
      else { need("("); key = pipe(); need(")"); }
      const name = tok;
      let val;
      if (eat(":")) val = alt();
      else if (name && name.t === "id") val = field(name.v);
      else throw new Error("expected :");
      entries.push([key, val]);
    } while (eat(","));
    need("}");
    return (v) => entries.reduce((acc, [key, val]) => acc.flatMap((o) => key(v).flatMap((k) => {
      if (typeof k !== "string") throw new Error(`object key is ${typeOf(k)}`);
      return val(v).map((x) => Object.defineProperty({ ...o }, k, { value: x, enumerable: true, writable: true, configurable: true }));
    })), [{}]);
  };
  const term = () => {
    let tok;
    if ((tok = eat("field"))) return suffixes(field(tok.v));
    if (eat(".")) {
      if (peek("str")) { p--; return suffixes((v) => [v]); }
      return suffixes((v) => [v]);
    }
    if ((tok = eat("num"))) { const n = tok.v; return suffixes(() => [n]); }
    if ((tok = eat("str"))) return suffixes(strFilter(tok));
    if (eat("(")) { const f = pipe(); need(")"); return suffixes(f); }
    if (eat("[")) {
      if (eat("]")) return suffixes(() => [[]]);
      const f = pipe();
      need("]");
      return suffixes((v) => [f(v)]);
    }
    if (eat("{")) {
      if (eat("}")) return suffixes(() => [{}]);
      return suffixes(object());
    }
    if ((tok = eat("id"))) {
      const name = tok.v;
      if (name === "null" || name === "true" || name === "false") { const c = JSON.parse(name); return suffixes(() => [c]); }
      if (name === "select" || name === "map") {
        need("(");
        const f = pipe();
        need(")");
        return suffixes(name === "map" ? (v) => [iterate(v).flatMap(f)] : (v) => f(v).filter(truthy).map(() => v));
      }
      if (Object.prototype.hasOwnProperty.call(FUNCS, name)) return suffixes(FUNCS[name]);
      throw new Error(`unknown function ${name}`);
    }
    throw new Error("unexpected end of expression");
  };
  const f = pipe();
  if (p < toks.length) throw new Error("trailing input");
  return f;
}

// a filter's run(value) -> outputs, or a refusal naming the expression
function compile(expr) {
  let f;
  try { f = parse(String(expr)); } catch { fail(`proteus local mode: filter ${JSON.stringify(expr)} is not supported`); }
  return (v) => { try { return f(v); } catch (e) { return fail(`proteus local mode: filter ${JSON.stringify(expr)}: ${e.message}`); } };
}
// as gh prints a filter's output: a string raw, null as an empty line, a fraction with two places, the rest as JSON
function render(v) {
  if (typeof v === "string") return v;
  if (v === null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return JSON.stringify(v);
}

// ---- the store
const realDir = (dir) => {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return fail(`proteus local mode: ${dir}: ${e.code === "ENOENT" ? "missing; run --init" : e.message}`); }
  if (st.isSymbolicLink() || !st.isDirectory()) fail(`proteus local mode: ${dir} is a link or not a directory, refused`);
  return dir;
};
const noLink = (f) => {
  let st;
  try { st = fs.lstatSync(f); } catch { return; }
  if (!st.isFile()) fail(`proteus local mode: ${f} is a link or not a regular file, refused`);
};
function layout(common) {
  const root = lib.localPath(common), tracker = path.join(root, "tracker");
  return { common, root, bin: path.join(root, "bin"), origin: path.join(root, "origin.git"), tracker, issues: path.join(tracker, "issues"), pulls: path.join(tracker, "pulls"), statuses: path.join(tracker, "statuses"), checks: path.join(root, "checks"), lock: path.join(tracker, "lock"), meta: path.join(tracker, "meta.json"), labels: path.join(tracker, "labels.json"), milestones: path.join(tracker, "milestones.json") };
}
// a fresh temp file renamed over the name: a link there is replaced, never followed. A reader holding the name open
// makes the rename fail for a moment on Windows
function writeFile(file, text, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, text, { flag: "wx", mode });
  for (let n = 0; ; n++) {
    try { return fs.renameSync(tmp, file); } catch (e) {
      if (n < 20 && ["EPERM", "EACCES", "EBUSY"].includes(e.code)) { sleep(25); continue; }
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}
const writeJSON = (file, v, cap = MAX_INDEX) => {
  const text = JSON.stringify(v, null, 2) + "\n";
  if (Buffer.byteLength(text) > cap) fail(`proteus local mode: ${path.basename(file)} would pass ${cap} bytes`);
  writeFile(file, text);
};
function readStoreJSON(file, cap = MAX_INDEX) {
  try { return JSON.parse(lib.readUntrusted(file, cap)); } catch (e) { return fail(`proteus local mode: malformed store: ${file}: ${e.message}`); }
}
const malformed = (file, what) => fail(`proteus local mode: malformed store: ${file}: ${what}`);

const isTime = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, cap) => typeof v === "string" && v.length <= cap;
const isObj = (v) => typeOf(v) === "object";

function readMeta(s) {
  const m = readStoreJSON(s.meta);
  if (!isObj(m) || !isCount(m.nextNumber) || !isCount(m.nextComment) || !isCount(m.nextMilestone)) malformed(s.meta, "a counter is not a positive integer");
  return { nextNumber: m.nextNumber, nextComment: m.nextComment, nextMilestone: m.nextMilestone };
}
function readLabels(s) {
  const list = readStoreJSON(s.labels);
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) malformed(s.labels, "not a list");
  return list.map((l) => {
    if (!isObj(l) || !isText(l.name, MAX_TITLE) || !l.name || !isText(l.description, MAX_BODY) || !/^[0-9a-fA-F]{6}$/.test(String(l.color)) || !isTime(l.createdAt) || !isTime(l.updatedAt)) malformed(s.labels, "a bad label");
    return { name: l.name, description: l.description, color: l.color, createdAt: l.createdAt, updatedAt: l.updatedAt };
  });
}
function readMilestones(s) {
  const list = readStoreJSON(s.milestones);
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) malformed(s.milestones, "not a list");
  return list.map((m) => {
    if (!isObj(m) || !isCount(m.number) || !isText(m.title, MAX_TITLE) || !m.title || !isText(m.description, MAX_BODY) || !["open", "closed"].includes(m.state) || !isTime(m.createdAt) || !isTime(m.updatedAt) || !(m.closedAt === null || isTime(m.closedAt))) malformed(s.milestones, "a bad milestone");
    return { number: m.number, title: m.title, description: m.description, state: m.state, createdAt: m.createdAt, updatedAt: m.updatedAt, closedAt: m.closedAt };
  });
}
function readIssue(s, n) {
  const file = path.join(s.issues, `${n}.json`);
  const i = readStoreJSON(file, MAX_FILE);
  if (!isObj(i) || i.number !== n) malformed(file, "its number is not its name");
  if (!isText(i.title, MAX_TITLE) || !isText(i.body, MAX_BODY) || !["OPEN", "CLOSED"].includes(i.state)) malformed(file, "a bad title, body or state");
  if (!isTime(i.createdAt) || !isTime(i.updatedAt) || !(i.closedAt === null || isTime(i.closedAt))) malformed(file, "a bad timestamp");
  if (!(i.milestone === null || isCount(i.milestone))) malformed(file, "a bad milestone");
  if (!Array.isArray(i.labels) || !i.labels.every((l) => isText(l, MAX_TITLE))) malformed(file, "a bad label");
  if (!Array.isArray(i.comments)) malformed(file, "a bad comment list");
  const comments = i.comments.map((c) => {
    if (!isObj(c) || !isCount(c.id) || !isText(c.body, MAX_BODY) || !isTime(c.createdAt)) malformed(file, "a bad comment");
    return { id: c.id, body: c.body, createdAt: c.createdAt };
  });
  return { number: n, title: i.title, body: i.body, state: i.state, labels: [...new Set(i.labels)], milestone: i.milestone, createdAt: i.createdAt, updatedAt: i.updatedAt, closedAt: i.closedAt, comments };
}
const writeIssue = (s, i) => writeJSON(path.join(s.issues, `${i.number}.json`), i, MAX_FILE);
const issueNumbers = (s) => numbersIn(s.issues);
function numbersIn(dir) {
  const names = fs.readdirSync(dir);
  if (names.length > MAX_ENTRIES) fail(`proteus local mode: malformed store: ${dir} holds over ${MAX_ENTRIES} entries`);
  return names.map((f) => /^([1-9]\d{0,14})\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}
const readIssues = (s) => issueNumbers(s).map((n) => readIssue(s, n));
const issueExists = (s, n) => fs.existsSync(path.join(s.issues, `${n}.json`));

// the lock: wx on a fixed name. A lock older than the bound is a crashed run's; one breaker at a time, so a breaker
// that read a stale age cannot remove the lock the run before it just took
const BUSY = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
const lockAge = (f) => { try { return Date.now() - fs.lstatSync(f).mtimeMs; } catch { return -1; } };
const unlink = (f) => { try { fs.unlinkSync(f); } catch {} };
function breakStale(file) {
  if (lockAge(file) < LOCK_STALE_MS) return;
  const guard = `${file}.break`;
  if (lockAge(guard) >= LOCK_STALE_MS) unlink(guard);
  try { fs.writeFileSync(guard, "", { flag: "wx", mode: 0o600 }); } catch { return; }
  try { if (lockAge(file) >= LOCK_STALE_MS) unlink(file); } finally { unlink(guard); }
}
function withLock(file, fn, wait = LOCK_WAIT_MS) {
  const token = crypto.randomBytes(8).toString("hex"), end = Date.now() + wait;
  for (;;) {
    try { fs.writeFileSync(file, token, { flag: "wx", mode: 0o600 }); break; } catch (e) { if (!BUSY.has(e.code)) throw e; }
    breakStale(file);
    if (Date.now() >= end) fail(`proteus local mode: the tracker is locked (${file})`);
    sleep(5 + Math.random() * 30);
  }
  try { return fn(); } finally {
    let held = "";
    try { held = lib.readUntrusted(file, 64); } catch {}
    if (held === token) unlink(file);
  }
}

// the next issue or PR number: past every number on disk, so a rolled-back meta.json never reuses one
function nextNumber(s, meta) {
  const nums = [...issueNumbers(s), ...(fs.existsSync(s.pulls) ? numbersIn(s.pulls) : [])];
  const n = Math.max(meta.nextNumber, ...nums.map((x) => x + 1));
  meta.nextNumber = n + 1;
  return n;
}

// the stable local name, the same from every worktree
function repoName(common) {
  const base = path.basename(path.dirname(common)).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "");
  return `${LOGIN}/${base || "repo"}`;
}
const repoUrl = (s) => `local://${s.repo}`;

// ---- flags, as gh's parser takes them. spec: { "--long|-s": 0 (a switch) | 1 (a value) | 2 (repeatable) }
function flags(argv, spec, name) {
  const known = new Map();
  for (const [k, kind] of Object.entries(spec)) { const [long, short] = k.split("|"); for (const w of [long, short]) if (w) known.set(w, { long, kind }); }
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; }
    if (a === "-" || !a.startsWith("-")) { o._.push(a); continue; }
    let key = a, val;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { key = a.slice(0, eq); val = a.slice(eq + 1); } else if (!a.startsWith("--") && a.length > 2) { key = a.slice(0, 2); val = a.slice(2).replace(/^=/, ""); }
    const flag = known.get(key);
    if (!flag) unsupported(`${name} ${key}`);
    if (!flag.kind) { if (val !== undefined) unsupported(`${name} ${key}=${val}`); o[flag.long] = true; continue; }
    if (val === undefined) { if (++i >= argv.length) fail(`proteus local mode: ${key} needs a value`); val = argv[i]; }
    if (flag.kind === 2) (o[flag.long] = o[flag.long] || []).push(val); else o[flag.long] = val;
  }
  return o;
}
const REPO = { "--repo|-R": 1 };
const OUT = { "--json": 1, "--jq|-q": 1 };
// -R and --repo may name only this repo: a tracker elsewhere is out of reach here
function onlyHere(s, o, name) { if (o["--repo"] !== undefined && o["--repo"] !== s.repo) unsupported(`${name} -R ${o["--repo"]}`); }
function limit(o, dflt) {
  if (o["--limit"] === undefined) return dflt;
  const n = Number(o["--limit"]);
  if (!Number.isSafeInteger(n) || n < 1) fail(`proteus local mode: invalid limit: ${o["--limit"]}`);
  return n;
}
const csv = (list) => (list || []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

function jsonFields(o, avail) {
  if (o["--json"] === undefined) { if (o["--jq"] !== undefined) fail("proteus local mode: cannot use --jq without --json"); return null; }
  const want = csv([o["--json"]]);
  if (!want.length) fail("proteus local mode: --json needs fields");
  for (const f of want) if (!avail.includes(f)) fail(`proteus local mode: unknown JSON field: "${f}"; available: ${avail.join(", ")}`);
  return want;
}
function pick(row, fields) { const out = {}; for (const f of fields) out[f] = row[f]; return out; }
const line = (t) => process.stdout.write(`${t}\n`);
function emit(v, filter) {
  if (filter) { for (const x of filter(v)) line(render(x)); } else line(JSON.stringify(v));
}
// print rows (or one row) as --json fields, through --jq when given
function emitFields(data, o, fields) {
  const filter = o["--jq"] !== undefined ? compile(o["--jq"]) : null;
  emit(Array.isArray(data) ? data.map((r) => pick(r, fields)) : pick(data, fields), filter);
}

function bodyOf(o) {
  if (o["--body"] !== undefined && o["--body-file"] !== undefined) fail("proteus local mode: give one of --body and --body-file");
  let body = o["--body"];
  if (o["--body-file"] !== undefined) {
    try { body = fs.readFileSync(o["--body-file"] === "-" ? 0 : o["--body-file"], "utf8"); } catch (e) { fail(`proteus local mode: cannot read the body: ${e.message}`); }
  }
  if (body !== undefined && body.length > MAX_BODY) fail(`proteus local mode: the body is over ${MAX_BODY} characters`);
  return body;
}
const checkTitle = (t) => { if (typeof t !== "string" || !t.trim()) fail("proteus local mode: a title is required"); if (t.length > MAX_TITLE) fail(`proteus local mode: the title is over ${MAX_TITLE} characters`); return t; };

// ---- output shapes, as gh prints them for each command
const issueUrl = (s, n) => `${repoUrl(s)}/issues/${n}`;
const labelJSON = (s, l) => ({ id: `LA_local_${l.name}`, name: l.name, description: l.description, color: l.color, isDefault: false, url: `${repoUrl(s)}/labels/${encodeURIComponent(l.name)}`, createdAt: l.createdAt, updatedAt: l.updatedAt });
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const commentUrl = (s, n, c) => `${issueUrl(s, n)}#issuecomment-${c.id}`;
function issueJSON(s, i, labels, milestones) {
  const ms = i.milestone === null ? null : milestones.find((m) => m.number === i.milestone) || fail(`proteus local mode: malformed store: ${i.number}.json names a milestone the store lacks`);
  return {
    number: i.number, title: i.title, body: i.body, state: i.state, url: issueUrl(s, i.number),
    author: { id: LOGIN, is_bot: false, login: LOGIN, name: "" },
    labels: i.labels.map((name) => {
      const l = labels.find((x) => sameName(x.name, name));
      const { id, name: n, description, color } = labelJSON(s, l || { name, description: "", color: DEFAULT_COLOR, createdAt: i.createdAt, updatedAt: i.updatedAt });
      return { id, name: n, description, color };
    }),
    milestone: ms && { number: ms.number, title: ms.title, description: ms.description, dueOn: null },
    comments: i.comments.map((c) => ({ id: `IC_local_${c.id}`, author: { login: LOGIN }, authorAssociation: "OWNER", body: c.body, createdAt: c.createdAt, includesCreatedEdit: false, isMinimized: false, minimizedReason: "", reactionGroups: [], url: commentUrl(s, i.number, c), viewerDidAuthor: true })),
    createdAt: i.createdAt, updatedAt: i.updatedAt, closedAt: i.closedAt,
  };
}
const ISSUE_FIELDS = ["number", "title", "body", "state", "url", "author", "labels", "milestone", "comments", "createdAt", "updatedAt", "closedAt"];
const LABEL_FIELDS = ["id", "name", "description", "color", "isDefault", "url", "createdAt", "updatedAt"];
const REPO_FIELDS = ["name", "nameWithOwner", "owner", "url", "visibility", "viewerPermission"];

function milestoneOf(milestones, ref) {
  const m = milestones.find((x) => x.title === ref) || milestones.find((x) => String(x.number) === ref);
  return m || fail(`proteus local mode: no milestone ${JSON.stringify(ref)}`);
}
function knownLabels(labels, names) {
  return names.map((n) => (labels.find((l) => sameName(l.name, n)) || fail(`proteus local mode: no label ${JSON.stringify(n)}`)).name);
}
function issueArg(o, name) {
  if (o._.length !== 1) unsupported(`${name} without one issue`);
  const m = /^#?([1-9]\d{0,14})$/.exec(o._[0]) || /\/issues\/([1-9]\d{0,14})(?:#.*)?$/.exec(o._[0]);
  return m ? Number(m[1]) : fail(`proteus local mode: not an issue: ${JSON.stringify(o._[0])}`);
}
function loadIssue(s, n) {
  if (!issueExists(s, n)) fail(`proteus local mode: no issue #${n}`);
  return readIssue(s, n);
}

// a search as the repo uses it: every word in the title (with in:title) or in the title or body; other qualifiers are refused
function searcher(query) {
  const inTitle = /(?:^|\s)in:title(?=\s|$)/.test(query);
  const words = query.replace(/(?:^|\s)in:title(?=\s|$)/g, " ").replace(/"/g, " ").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some((w) => /^[a-z-]+:\S/.test(w))) unsupported(`issue list --search ${query}`);
  return (i) => { const hay = (inTitle ? i.title : `${i.title}\n${i.body}`).toLowerCase(); return words.every((w) => hay.includes(w)); };
}

const issueCommands = {
  create(s, argv) {
    const o = flags(argv, { ...REPO, "--title|-t": 1, "--body|-b": 1, "--body-file|-F": 1, "--label|-l": 2, "--milestone|-m": 1 }, "issue create");
    onlyHere(s, o, "issue create");
    if (o._.length) unsupported(`issue create ${o._[0]}`);
    const title = checkTitle(o["--title"]), body = bodyOf(o);
    if (body === undefined) fail("proteus local mode: --title and --body or --body-file are required");
    const n = withLock(s.lock, () => {
      const labels = knownLabels(readLabels(s), csv(o["--label"]));
      const milestone = o["--milestone"] === undefined ? null : milestoneOf(readMilestones(s), o["--milestone"]).number;
      const meta = readMeta(s), number = nextNumber(s, meta), t = now();
      writeJSON(s.meta, meta);
      writeIssue(s, { number, title, body, state: "OPEN", labels: [...new Set(labels)], milestone, createdAt: t, updatedAt: t, closedAt: null, comments: [] });
      return number;
    });
    line(issueUrl(s, n));
  },
  list(s, argv) {
    const o = flags(argv, { ...REPO, ...OUT, "--label|-l": 2, "--milestone|-m": 1, "--state|-s": 1, "--limit|-L": 1, "--search|-S": 1 }, "issue list");
    onlyHere(s, o, "issue list");
    if (o._.length) unsupported(`issue list ${o._[0]}`);
    const fields = jsonFields(o, ISSUE_FIELDS);
    const state = o["--state"] === undefined ? "open" : o["--state"], want = limit(o, 30);
    if (!["open", "closed", "all"].includes(state)) fail(`proteus local mode: invalid --state: ${state}`);
    const labels = readLabels(s), milestones = readMilestones(s), names = csv(o["--label"]);
    const ms = o["--milestone"] === undefined ? null : milestoneOf(milestones, o["--milestone"]).number;
    const match = o["--search"] === undefined ? () => true : searcher(o["--search"]);
    const rows = readIssues(s).reverse()
      .filter((i) => (state === "all" || i.state === state.toUpperCase()) && (ms === null || i.milestone === ms) && names.every((n) => i.labels.some((l) => sameName(l, n))) && match(i))
      .slice(0, want).map((i) => issueJSON(s, i, labels, milestones));
    if (fields) return emitFields(rows, o, fields);
    for (const r of rows) line([r.number, r.state, r.title, r.labels.map((l) => l.name).join(", "), r.updatedAt].join("\t"));
  },
  view(s, argv) {
    const o = flags(argv, { ...REPO, ...OUT, "--comments|-c": 0 }, "issue view");
    onlyHere(s, o, "issue view");
    const n = issueArg(o, "issue view"), fields = jsonFields(o, ISSUE_FIELDS);
    const r = issueJSON(s, loadIssue(s, n), readLabels(s), readMilestones(s));
    if (fields) return emitFields(r, o, fields);
    if (o["--comments"]) {
      for (const c of r.comments) line(`author:\t${LOGIN}\nassociation:\towner\nedited:\tfalse\nstatus:\tnone\n--\n${c.body}\n--`);
      return;
    }
    line(`title:\t${r.title}\nstate:\t${r.state}\nauthor:\t${LOGIN}\nlabels:\t${r.labels.map((l) => l.name).join(", ")}\ncomments:\t${r.comments.length}\nassignees:\t\nprojects:\t\nmilestone:\t${r.milestone ? r.milestone.title : ""}\nnumber:\t${r.number}\n--\n${r.body}`);
  },
  comment(s, argv) {
    const o = flags(argv, { ...REPO, "--body|-b": 1, "--body-file|-F": 1 }, "issue comment");
    onlyHere(s, o, "issue comment");
    const n = issueArg(o, "issue comment"), body = bodyOf(o);
    if (!body || !body.trim()) fail("proteus local mode: the comment body is empty");
    const c = withLock(s.lock, () => {
      const i = loadIssue(s, n), meta = readMeta(s), t = now();
      const comment = { id: meta.nextComment++, body, createdAt: t };
      writeJSON(s.meta, meta);
      i.comments.push(comment);
      i.updatedAt = t;
      writeIssue(s, i);
      return comment;
    });
    line(commentUrl(s, n, c));
  },
  close(s, argv) { setState(s, argv, "close", "CLOSED"); },
  reopen(s, argv) { setState(s, argv, "reopen", "OPEN"); },
  edit(s, argv) {
    const o = flags(argv, { ...REPO, "--title|-t": 1, "--body|-b": 1, "--body-file|-F": 1, "--milestone|-m": 1, "--add-label": 2, "--remove-label": 2 }, "issue edit");
    onlyHere(s, o, "issue edit");
    const n = issueArg(o, "issue edit");
    const title = o["--title"] === undefined ? undefined : checkTitle(o["--title"]), body = bodyOf(o);
    const add = csv(o["--add-label"]), remove = csv(o["--remove-label"]);
    if (title === undefined && body === undefined && o["--milestone"] === undefined && !add.length && !remove.length) fail("proteus local mode: issue edit needs a change");
    withLock(s.lock, () => {
      const i = loadIssue(s, n);
      if (title !== undefined) i.title = title;
      if (body !== undefined) i.body = body;
      if (o["--milestone"] !== undefined) i.milestone = milestoneOf(readMilestones(s), o["--milestone"]).number;
      const added = knownLabels(readLabels(s), add);
      i.labels = [...new Set([...i.labels, ...added])].filter((l) => !remove.some((r) => sameName(r, l)));
      i.updatedAt = now();
      writeIssue(s, i);
    });
    line(issueUrl(s, n));
  },
};
function setState(s, argv, name, state) {
  const o = flags(argv, REPO, `issue ${name}`);
  onlyHere(s, o, `issue ${name}`);
  const n = issueArg(o, `issue ${name}`);
  withLock(s.lock, () => {
    const i = loadIssue(s, n);
    if (i.state === state) return;
    const t = now();
    i.state = state;
    i.closedAt = state === "CLOSED" ? t : null;
    i.updatedAt = t;
    writeIssue(s, i);
  });
}

const labelCommands = {
  create(s, argv) {
    const o = flags(argv, { ...REPO, "--color|-c": 1, "--description|-d": 1, "--force|-f": 0 }, "label create");
    onlyHere(s, o, "label create");
    if (o._.length !== 1) unsupported("label create without one name");
    const name = checkTitle(o._[0]);
    if (name.includes(",")) fail("proteus local mode: a label name has no comma");
    const color = o["--color"] === undefined ? undefined : o["--color"].replace(/^#/, ""), description = o["--description"];
    if (color !== undefined && !/^[0-9a-fA-F]{6}$/.test(color)) fail(`proteus local mode: invalid color: ${o["--color"]}`);
    if (description !== undefined && description.length > MAX_BODY) fail("proteus local mode: the description is too long");
    withLock(s.lock, () => {
      const labels = readLabels(s), hit = labels.find((l) => sameName(l.name, name)), t = now();
      if (hit && !o["--force"]) fail(`proteus local mode: label "${name}" already exists; use --force to update it`);
      if (hit) Object.assign(hit, { ...(color !== undefined && { color }), ...(description !== undefined && { description }), updatedAt: t });
      else labels.push({ name, description: description || "", color: color || DEFAULT_COLOR, createdAt: t, updatedAt: t });
      writeJSON(s.labels, labels);
    });
  },
  list(s, argv) {
    const o = flags(argv, { ...REPO, ...OUT, "--limit|-L": 1 }, "label list");
    onlyHere(s, o, "label list");
    if (o._.length) unsupported(`label list ${o._[0]}`);
    const fields = jsonFields(o, LABEL_FIELDS), rows = readLabels(s).slice(0, limit(o, 30)).map((l) => labelJSON(s, l));
    if (fields) return emitFields(rows, o, fields);
    for (const r of rows) line([r.name, r.description, `#${r.color}`].join("\t"));
  },
};

// ---- gh api: this slice's paths
const USER = { login: LOGIN, id: 0, type: "User", name: "" };
function milestoneAPI(s, m, issues) {
  const mine = issues.filter((i) => i.milestone === m.number);
  return {
    number: m.number, id: m.number, title: m.title, description: m.description, state: m.state, creator: { login: LOGIN },
    open_issues: mine.filter((i) => i.state === "OPEN").length, closed_issues: mine.filter((i) => i.state === "CLOSED").length,
    created_at: m.createdAt, updated_at: m.updatedAt, closed_at: m.closedAt, due_on: null, url: `${repoUrl(s)}/milestones/${m.number}`, html_url: `${repoUrl(s)}/milestone/${m.number}`,
  };
}
function api(s, argv) {
  const o = flags(argv, { ...REPO, "--method|-X": 1, "--raw-field|-f": 2, "--jq|-q": 1, "--paginate": 0 }, "api");
  if (o["--repo"] !== undefined) unsupported("api --repo");
  if (o._.length !== 1) unsupported("api without one path");
  const filter = o["--jq"] !== undefined ? compile(o["--jq"]) : null;
  const [route, query = ""] = o._[0].replace(/^\/+/, "").split("?");
  const fields = (o["--raw-field"] || []).map((f) => { const at = f.indexOf("="); return at > 0 ? [f.slice(0, at), f.slice(at + 1)] : fail(`proteus local mode: bad field: ${f}`); });
  const method = (o["--method"] || (fields.length ? "POST" : "GET")).toUpperCase();
  const params = new Map([...new URLSearchParams(query), ...(method === "GET" ? fields : [])]);
  const body = new Map(method === "GET" ? [] : fields);
  const no = () => unsupported(`api ${method === "GET" ? "" : `-X ${method} `}${o._[0]}`);
  if (route === "user") return method === "GET" ? emit(USER, filter) : no();
  const m = /^repos\/([^/]+\/[^/]+)\/(.+)$/.exec(route);
  if (!m || (m[1] !== "{owner}/{repo}" && m[1] !== s.repo)) no();
  if (pr.api(s, method, m[2], { params, body, filter, no })) return;
  const comments = /^issues\/([1-9]\d{0,14})\/comments$/.exec(m[2]);
  if (comments && method === "GET") {
    const n = Number(comments[1]);
    if (!issueExists(s, n)) fail("gh: Not Found (HTTP 404)");
    return emit(readIssue(s, n).comments.map((c) => ({ id: c.id, body: c.body, user: { login: LOGIN }, author_association: "OWNER", created_at: c.createdAt, updated_at: c.createdAt, html_url: commentUrl(s, n, c), issue_url: issueUrl(s, n), url: `${repoUrl(s)}/issues/comments/${c.id}` })), filter);
  }
  if (m[2] !== "milestones") no();
  if (method === "GET") {
    const state = params.has("state") ? params.get("state") : "open";
    if (!["open", "closed", "all"].includes(state)) fail("gh: Validation Failed (HTTP 422)");
    const issues = readIssues(s);
    return emit(readMilestones(s).filter((x) => state === "all" || x.state === state).map((x) => milestoneAPI(s, x, issues)), filter);
  }
  if (method !== "POST") no();
  for (const k of body.keys()) if (k !== "title" && k !== "description") no();
  const title = checkTitle(body.get("title")), description = body.get("description") || "";
  if (description.length > MAX_BODY) fail("proteus local mode: the description is too long");
  const made = withLock(s.lock, () => {
    const list = readMilestones(s), meta = readMeta(s), t = now();
    if (list.some((x) => x.title === title)) fail("gh: Validation Failed (HTTP 422): a milestone with this title exists");
    const number = Math.max(meta.nextMilestone, ...list.map((x) => x.number + 1));
    meta.nextMilestone = number + 1;
    const ms = { number, title, description, state: "open", createdAt: t, updatedAt: t, closedAt: null };
    writeJSON(s.meta, meta);
    list.push(ms);
    writeJSON(s.milestones, list);
    return ms;
  });
  emit(milestoneAPI(s, made, []), filter);
}

function authStatus(s, argv) {
  const o = flags(argv, {}, "auth status");
  if (o._.length) unsupported(`auth status ${o._[0]}`);
  line(`proteus local mode: logged in as ${LOGIN}; no network, no GitHub`);
}
function repoView(s, argv) {
  const o = flags(argv, OUT, "repo view");
  if (o._.length > 1 || (o._.length && o._[0] !== s.repo)) unsupported(`repo view ${o._[0]}`);
  const fields = jsonFields(o, REPO_FIELDS), name = s.repo.split("/")[1];
  const row = { name, nameWithOwner: s.repo, owner: { id: LOGIN, login: LOGIN }, url: repoUrl(s), visibility: "PRIVATE", viewerPermission: "ADMIN" };
  if (fields) return emitFields(row, o, fields);
  line(`name:\t${s.repo}\ndescription:\t`);
}

// the store of common, every directory on its path checked
function open(common) {
  const s = layout(common);
  for (const d of [s.root, s.tracker, s.issues]) realDir(d);
  return { ...s, repo: repoName(common) };
}

function run(common, argv) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "issue" && Object.prototype.hasOwnProperty.call(issueCommands, sub)) return issueCommands[sub](open(common), rest);
  if (cmd === "label" && Object.prototype.hasOwnProperty.call(labelCommands, sub)) return labelCommands[sub](open(common), rest);
  if (cmd === "pr") return pr.run(common, sub, rest);
  if (cmd === "api") return api(open(common), argv.slice(1));
  if (cmd === "auth" && sub === "status") return authStatus(open(common), rest);
  if (cmd === "repo" && sub === "view") return repoView(open(common), rest);
  return unsupported(argv.filter((a) => a !== undefined).slice(0, 2).join(" ") || "(no command)");
}

// ---- --init
const shQuote = (p) => `'${p.replace(/'/g, "'\\''")}'`;
// in a .cmd file, inside double quotes, only % still expands
const cmdQuote = (p) => `"${p.replace(/%/g, "%%")}"`;
const shLauncher = (...words) => `#!/bin/sh\nexec node ${words.map(shQuote).join(" ")} "$@"\n`;
const cmdLauncher = (script) => `@node ${cmdQuote(script)} %*\r\n`;

function mkReal(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  return realDir(dir);
}
// text at file, written only when it differs: the hooks dir can move between installs
function writeFresh(file, text, mode) {
  try { if (fs.readFileSync(file, "utf8") === text) return; } catch {}
  writeFile(file, text, mode);
}
function init(common) {
  const s = layout(common);
  pr.checkOrigin(s); // before anything is written, the mode marker included
  for (const d of [s.root, s.bin, s.tracker, s.issues, s.pulls, s.statuses, s.checks]) mkReal(d);
  const gh = path.join(s.bin, "gh"), cmd = path.join(s.bin, "gh.cmd");
  for (const f of [s.meta, s.labels, s.milestones, gh, cmd]) noLink(f);
  writeFresh(gh, shLauncher(SCRIPT), 0o755);
  writeFresh(cmd, cmdLauncher(SCRIPT));
  withLock(s.lock, () => {
    if (!fs.existsSync(s.meta)) writeJSON(s.meta, { nextNumber: 1, nextComment: 1, nextMilestone: 1 });
    if (!fs.existsSync(s.labels)) writeJSON(s.labels, []);
    if (!fs.existsSync(s.milestones)) writeJSON(s.milestones, []);
  });
  pr.initOrigin(s);
  // last, so a half-made store never reads as local mode
  // the sandbox cannot write here, so only an unsandboxed setup turns local mode on
  const mode = path.join(lib.leadDir(common), "local-mode");
  if (!fs.existsSync(mode)) lib.leadWrite(common, mode, "1\n");
  return s;
}

const pr = require(path.join(__dirname, "proteus-local-pr.js"))({
  fail, unsupported, flags, onlyHere, limit, csv, jsonFields, emit, emitFields, line, bodyOf, checkTitle, readStoreJSON, malformed, writeJSON, withLock, nextNumber, numbersIn, readMeta, repoUrl,
  isTime, isCount, isText, isObj, realDir, noLink, mkReal, writeFresh, unlink, sleep, now, open, shLauncher, LOGIN, MAX_BODY, MAX_FILE, MAX_ENTRIES, REPO, OUT, script: SCRIPT,
});

function main(argv) {
  try {
    // the origin's hooks run in the bare repo, not a checkout; the push's stdin names the refs
    if (argv[0] === "--pre-receive") { pr.preReceive(process.cwd(), fs.readFileSync(0, "utf8")); return 0; }
    if (argv[0] === "--post-receive") { try { pr.postReceive(process.cwd(), fs.readFileSync(0, "utf8")); } catch (e) { process.stderr.write(`proteus local mode: no local check: ${e.message}\n`); } return 0; }
    if (argv[0] === "--run-check") { pr.runCheck(argv[1], argv[2]).catch((e) => { process.stderr.write(`proteus local mode: ${e.message}\n`); process.exitCode = 1; }); return undefined; }
    if (argv[0] === "--init") {
      if (argv.length > 1) unsupported(`--init ${argv[1]}`);
      const common = lib.repoCommon(process.cwd());
      if (!common) fail("proteus local mode: not in a git checkout");
      init(common);
      return 0;
    }
    const common = lib.localCommon(process.cwd());
    if (!common) fail("proteus local mode: this repo is not in local mode; the stand-in never falls through to a real gh");
    return run(common, argv) || 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Fail ? e.message : `proteus local mode: ${e.message}`}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { compile, render, init, open, withLock, repoName, shLauncher, cmdLauncher, readIssue, readIssues, nextNumber, pr, LOCK_STALE_MS };
