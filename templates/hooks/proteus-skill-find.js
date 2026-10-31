#!/usr/bin/env node
// Skill discovery for the scout (#10): the candidates for one term that clear the bar, ranked.
//   node <hooks>/proteus-skill-find.js <term> [--json]
// Queries, in order: skills.sh's search API; the installed skills (proteus-skillpath.js's roots, the term matched
// against each skill's name and description); GitHub-wide (`gh search code --filename SKILL.md`); the curated
// marketplaces (anthropics/skills, anthropics/claude-plugins-official, anthropics/claude-plugins-community, by
// their git tree). A GitHub repo's stars, pushed_at and default-branch sha come from `gh api`.
// The bar: pushed within 365 days, and trusted (anthropics/* or installed) or stars >= 50 or installs >= 100.
// A candidate below it is never printed. The rest rank trusted first, then max(installs, stars), then pushed_at;
// the same repo and skill from two sources merge into one with the highest numbers.
// Prints one line per candidate, `<rank> <owner/repo> <skill> <source> stars=<n> installs=<n> pushed=<date>
// sha=<sha7> [trusted]`, `NONE <term>` when none, and `SKIP <source>: <reason>` for a source that failed while
// the rest still run. --json prints {term, candidates, skipped} instead.
// Exit 0 on any result (NONE too), 2 bad usage. Writes nothing.
"use strict";
const fs = require("fs");
const path = require("path");

const USAGE = "usage: node proteus-skill-find.js <term> [--json]";
const API = "https://skills.sh/api/search?q=";
const MARKETPLACES = ["anthropics/skills", "anthropics/claude-plugins-official", "anthropics/claude-plugins-community"];
const DAY = 86400000;
const MAX_AGE_DAYS = 365, MIN_STARS = 50, MIN_INSTALLS = 100;
const GH_TIMEOUT = 30000, FETCH_TIMEOUT = 15000;
// names from the network are printed to the scout only when they look like names
const REPO = /^[\w.-]+\/[\w.-]+$/, SKILL = /^[\w.-]+$/;

const flat = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim().slice(0, 200);
const num = (n) => (Number.isFinite(+n) && +n > 0 ? Math.floor(+n) : 0);
const parse = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };
const matches = (term, ...texts) => { const t = term.toLowerCase(), h = t.replace(/\s+/g, "-"); return texts.some((x) => { const s = String(x || "").toLowerCase(); return s.includes(t) || s.includes(h); }); };
const skillOf = (p, repo) => { const d = path.posix.dirname(String(p)); return d === "." ? repo.split("/")[1] : path.posix.basename(d); };

function defaultGh(args) {
  const lib = require(path.join(__dirname, "proteus-lib.js"));
  return lib.ghTry(args, process.cwd(), GH_TIMEOUT);
}
const defaultFetch = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { accept: "application/json" } });

// a gh call's JSON output, or a throw with gh's reason
function ghJSON(gh, args) {
  const r = gh(args);
  if (!r.ok) throw new Error(flat(r.err) || "gh failed");
  const j = parse(r.out, undefined);
  if (j === undefined) throw new Error("gh printed no JSON");
  return j;
}

async function fromSkillsSh(term, deps) {
  const res = await deps.fetch(API + encodeURIComponent(term));
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "no response"}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.skills)) throw new Error("no skills[] in the response");
  return j.skills.map((s) => ({ source: "skills.sh", repo: String(s && s.source), skill: String(s && s.skillId), path: "", installs: num(s && s.installs) }));
}

// the nearest plugin.json above a SKILL.md (inside its root): its GitHub owner/repo, if it names one
function pluginRepo(md, root) {
  for (let d = path.dirname(md); d.length >= root.length && d !== path.dirname(d); d = path.dirname(d)) {
    for (const sub of [".claude-plugin", ".codex-plugin"]) {
      const f = path.join(d, sub, "plugin.json");
      if (!fs.existsSync(f)) continue;
      const j = parse(fs.readFileSync(f, "utf8"), {}) || {};
      const url = typeof j.repository === "string" ? j.repository : (j.repository && j.repository.url) || j.homepage || "";
      const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(String(url));
      return m ? `${m[1]}/${m[2]}` : "";
    }
  }
  return "";
}
function head(file) {
  try { const fd = fs.openSync(file, "r"); try { const b = Buffer.alloc(4096); return b.toString("utf8", 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); } } catch { return ""; }
}
function fromInstalled(term, deps) {
  const out = [];
  for (const root of deps.roots()) for (const md of require(path.join(__dirname, "proteus-skillpath.js")).find(root, null)) {
    const skill = path.basename(path.dirname(md)), text = head(md);
    const desc = (/^description:\s*(.*)$/m.exec(text) || [])[1], name = (/^name:\s*(.*)$/m.exec(text) || [])[1];
    if (!matches(term, skill, name, desc)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(md).mtimeMs; } catch {}
    out.push({ source: "installed", repo: pluginRepo(md, root) || "installed/local", skill, path: md, trusted: true, pushedMs: mtime });
  }
  return out;
}

function fromGithub(term, deps) {
  const j = ghJSON(deps.gh, ["search", "code", "--filename", "SKILL.md", term, "--json", "repository,path"]);
  if (!Array.isArray(j)) throw new Error("gh search printed no list");
  return j.map((h) => { const repo = String((h && h.repository && h.repository.nameWithOwner) || ""); return { source: "github", repo, skill: skillOf(h && h.path, repo), path: String((h && h.path) || "") }; });
}

function fromMarketplaces(term, deps, skipped) {
  const out = [];
  for (const repo of MARKETPLACES) {
    try {
      const j = ghJSON(deps.gh, ["api", `repos/${repo}/git/trees/HEAD?recursive=1`]);
      for (const t of (j && Array.isArray(j.tree) ? j.tree : [])) {
        const p = String((t && t.path) || "");
        if (path.posix.basename(p) !== "SKILL.md") continue;
        const skill = skillOf(p, repo);
        if (matches(term, skill)) out.push({ source: "marketplace", repo, skill, path: p });
      }
    } catch (e) { skipped.push({ source: `marketplace ${repo}`, reason: e.message }); }
  }
  return out;
}

const trustedRepo = (repo) => /^anthropics\//i.test(repo);
const pass = (c, now) => now - c.pushedMs <= MAX_AGE_DAYS * DAY && (c.trusted || c.stars >= MIN_STARS || c.installs >= MIN_INSTALLS);
const score = (c) => Math.max(c.installs, c.stars);
const rank = (a, b) => (b.trusted - a.trusted) || (score(b) - score(a)) || (b.pushedMs - a.pushedMs);

async function search(term, deps = {}) {
  deps = { fetch: defaultFetch, gh: defaultGh, roots: () => require(path.join(__dirname, "proteus-skillpath.js")).roots(), now: Date.now(), ...deps };
  const skipped = [], raw = [];
  const source = async (name, fn) => { try { raw.push(...(await fn())); } catch (e) { skipped.push({ source: name, reason: flat(e && e.message) || "failed" }); } };
  await source("skills.sh", () => fromSkillsSh(term, deps));
  await source("installed", () => fromInstalled(term, deps));
  await source("github", () => fromGithub(term, deps));
  await source("marketplace", () => fromMarketplaces(term, deps, skipped));

  // one entry per repo and skill, keeping the highest numbers; the first source to find it names it
  const merged = new Map();
  for (const c of raw) {
    if (!REPO.test(c.repo) || !SKILL.test(c.skill)) continue;
    const k = `${c.repo.toLowerCase()} ${c.skill.toLowerCase()}`, m = merged.get(k);
    const e = { stars: 0, installs: 0, pushedMs: 0, trusted: false, path: "", ...c };
    e.trusted = e.trusted || trustedRepo(e.repo);
    if (!m) { merged.set(k, e); continue; }
    m.installs = Math.max(m.installs, e.installs);
    m.pushedMs = Math.max(m.pushedMs, e.pushedMs);
    m.trusted = m.trusted || e.trusted;
    m.path = m.path || e.path;
  }

  // GitHub's numbers, once per repo; a repo gh cannot read keeps what it had, and an unknown push date fails the bar
  const repos = new Map();
  const info = (repo) => {
    if (!repos.has(repo)) { try { const j = ghJSON(deps.gh, ["api", `repos/${repo}`]); repos.set(repo, { stars: num(j.stargazers_count), pushedMs: Date.parse(j.pushed_at) || 0 }); } catch { repos.set(repo, null); } }
    return repos.get(repo);
  };
  const local = (c) => c.repo === "installed/local";
  for (const c of merged.values()) {
    const i = local(c) ? null : info(c.repo);
    if (i) { c.stars = Math.max(c.stars, i.stars); c.pushedMs = Math.max(c.pushedMs, i.pushedMs); }
  }
  const kept = [...merged.values()].filter((c) => pass(c, deps.now)).sort(rank);
  const shas = new Map();
  for (const c of kept) {
    if (local(c)) { c.sha = ""; continue; }
    if (!shas.has(c.repo)) { const r = deps.gh(["api", `repos/${c.repo}/commits/HEAD`, "-q", ".sha"]); shas.set(c.repo, r.ok && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : ""); }
    c.sha = shas.get(c.repo);
  }
  const candidates = kept.map((c, i) => ({ rank: i + 1, repo: c.repo, skill: c.skill, source: c.source, path: flat(c.path), stars: c.stars, installs: c.installs, pushed_at: new Date(c.pushedMs).toISOString(), sha: c.sha, trusted: c.trusted }));
  return { term, candidates, skipped: skipped.map((s) => ({ source: s.source, reason: flat(s.reason) })) };
}

const line = (c) => `${c.rank} ${c.repo} ${c.skill} ${c.source} stars=${c.stars} installs=${c.installs} pushed=${c.pushed_at.slice(0, 10)} sha=${c.sha ? c.sha.slice(0, 7) : "-"}${c.trusted ? " trusted" : ""}`;

// argv without node and the script; returns { code, out, err }
async function main(argv, deps) {
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, out: `${USAGE}
Lists the skills for one term that clear the bar (pushed within ${MAX_AGE_DAYS} days; anthropics/* or installed,
or ${MIN_STARS}+ stars, or ${MIN_INSTALLS}+ installs), ranked trusted first, then max(installs, stars), then recency.
Sources: skills.sh, installed skills, GitHub code search, the anthropics marketplaces. One line per candidate,
NONE <term> when none, SKIP <source>: <reason> for a source that failed. --json prints {term, candidates, skipped}.
Exit 0 on any result; 2 on usage.\n`, err: "" };
  const json = argv.includes("--json"), rest = argv.filter((a) => a !== "--json");
  const term = rest.length === 1 ? rest[0].trim() : "";
  if (!term || term.startsWith("-") || term.length > 100 || /\p{Cc}/u.test(term)) return { code: 2, out: "", err: `${USAGE}\n(--help explains the argument)\n` };
  const r = await search(term, deps);
  if (json) return { code: 0, out: JSON.stringify(r, null, 2) + "\n", err: "" };
  const lines = [...r.skipped.map((s) => `SKIP ${s.source}: ${s.reason}`), ...(r.candidates.length ? r.candidates.map(line) : [`NONE ${flat(term)}`])];
  return { code: 0, out: lines.join("\n") + "\n", err: "" };
}

if (require.main === module) {
  require(path.join(__dirname, "proteus-lib.js")).homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir
  main(process.argv.slice(2)).then((r) => { process.stdout.write(r.out); process.stderr.write(r.err); process.exitCode = r.code; },
    (e) => { process.stderr.write(`proteus-skill-find: ${flat(e && e.message)}\n`); process.exitCode = 0; });
}
module.exports = { search, main, pass, rank, MARKETPLACES };
