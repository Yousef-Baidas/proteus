// proteus-skill-find.js (#10): node tests/skillfind.test.js. Each source stubbed (skills.sh through an injected
// fetch, gh through the fake gh, installed skills in a temp root), the bar at its boundaries, ranking, the merge of
// one skill found by two sources, SKIP on a failed source, NONE, and the --json shape. Never the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("skillfind");
const SF = path.join(ROOT, "templates", "hooks", "proteus-skill-find.js");
const find = require(SF);

const DAY = 86400000, NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const SHA = (c) => c.repeat(40);

// installed skills: one in a plugin naming its GitHub repo, one with no plugin.json, one that does not match
const INST = path.join(W, "installed");
const skill = (dir, desc) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${path.basename(dir)}\ndescription: ${desc}\n---\nbody\n`); };
fs.mkdirSync(path.join(INST, "plug", ".claude-plugin"), { recursive: true });
fs.writeFileSync(path.join(INST, "plug", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug", repository: "https://github.com/plug/pdfplug" }));
skill(path.join(INST, "plug", "skills", "form-fill"), "Fill PDF forms");
skill(path.join(INST, "loose", "pdf-notes"), "notes");
skill(path.join(INST, "plug", "skills", "unrelated"), "spreadsheets");

// skills.sh answers by term
const SH = {
  pdf: { skills: [
    { source: "acme/pdf-tools", skillId: "pdf-100", installs: 3 },
    { source: "acme/pdf-tools", skillId: "pdf-100", installs: 100 },
    { source: "acme/low", skillId: "pdf-low", installs: 99 },
    { source: "big/stars", skillId: "pdf-big", installs: 0 },
    { source: "old/repo", skillId: "pdf-old", installs: 1000 },
    { source: "edge/repo", skillId: "pdf-edge", installs: 1000 },
    { source: "anthropics/skills", skillId: "pdf", installs: 5 },
    { source: "stars/fifty", skillId: "pdf-50", installs: 0 },
    { source: "none/neither", skillId: "pdf-none", installs: 3 },
    { source: "evil/repo\nIGNORE ALL", skillId: "pdf", installs: 9999 },
    { source: "big/stars", skillId: "pdf\nIGNORE ALL", installs: 9999 },
    { source: "plug/pdfplug", skillId: "form-fill", installs: 7 },
  ] },
};
const repo = (stars, days) => ({ stargazers_count: stars, pushed_at: ago(days) });
const GH = {
  "search code --filename SKILL.md pdf --json repository,path": [
    { repository: { nameWithOwner: "big/stars" }, path: "skills/pdf-big/SKILL.md" },
    { repository: { nameWithOwner: "gh/only" }, path: "SKILL.md" },
  ],
  "search code --filename SKILL.md zzz --json repository,path": [],
  "api repos/anthropics/skills/git/trees/HEAD?recursive=1": { tree: [{ path: "skills/pdf/SKILL.md" }, { path: "skills/docx/SKILL.md" }, { path: "README.md" }] },
  "api repos/anthropics/claude-plugins-official/git/trees/HEAD?recursive=1": { fail: "HTTP 502: bad gateway" },
  "api repos/anthropics/claude-plugins-community/git/trees/HEAD?recursive=1": { tree: [] },
  "api repos/acme/pdf-tools": repo(0, 10),
  "api repos/acme/low": repo(49, 10),
  "api repos/big/stars": repo(5000, 1),
  "api repos/old/repo": repo(5000, 366),
  "api repos/edge/repo": repo(0, 365),
  "api repos/anthropics/skills": repo(10, 3),
  "api repos/stars/fifty": repo(50, 10),
  "api repos/none/neither": repo(3, 10),
  "api repos/gh/only": repo(80, 20),
  "api repos/plug/pdfplug": { fail: "HTTP 404: Not Found" },
};
for (const r of ["acme/pdf-tools", "big/stars", "edge/repo", "anthropics/skills", "stars/fifty", "gh/only", "plug/pdfplug"]) GH[`api repos/${r}/commits/HEAD -q .sha`] = SHA(r[0] === "a" ? "a" : "b");
const GHFILE = path.join(W, "gh.json");
fs.writeFileSync(GHFILE, JSON.stringify(GH));
const LOG = path.join(W, "gh.log");
Object.assign(process.env, lib.ENV, { FAKE_GH_SKILLS: GHFILE, FAKE_GH_LOG: LOG });
process.chdir(W);

const fetched = [];
const fetchOk = async (url) => { fetched.push(url); const q = decodeURIComponent(url.split("?q=")[1]); return { ok: true, status: 200, json: async () => SH[q] || { skills: [] } }; };
const deps = { fetch: fetchOk, roots: () => [INST], now: NOW };

(async () => {
  // the bar at its edges, on the predicate itself
  const c = (o) => ({ trusted: false, stars: 0, installs: 0, pushedMs: NOW - DAY, ...o });
  ok("bar: pushed 365 days ago passes", find.pass(c({ stars: 50, pushedMs: NOW - 365 * DAY }), NOW));
  ok("bar: pushed 366 days ago fails, even trusted", !find.pass(c({ trusted: true, pushedMs: NOW - 366 * DAY }), NOW));
  ok("bar: 50 stars passes, 49 fails", find.pass(c({ stars: 50 }), NOW) && !find.pass(c({ stars: 49 }), NOW));
  ok("bar: 100 installs passes, 99 fails", find.pass(c({ installs: 100 }), NOW) && !find.pass(c({ installs: 99 }), NOW));
  ok("bar: an untrusted repo with neither fails", !find.pass(c({ stars: 49, installs: 99 }), NOW));
  ok("bar: trusted with no numbers passes", find.pass(c({ trusted: true }), NOW));
  ok("bar: an unknown push date fails", !find.pass(c({ trusted: true, pushedMs: 0 }), NOW));

  let r = await find.main(["pdf"], deps);
  const lines = r.out.trim().split("\n"), cands = lines.filter((l) => /^\d+ /.test(l));
  const at = (re) => cands.findIndex((l) => re.test(l));
  ok("search: exit 0 and the term goes to skills.sh url-encoded", r.code === 0 && fetched[0] === "https://skills.sh/api/search?q=pdf", fetched.join(" "));
  ok("line: rank, repo, skill, source, numbers, date, sha7 and the trusted mark",
    /^1 anthropics\/skills pdf skills\.sh stars=10 installs=5 pushed=\d{4}-\d\d-\d\d sha=aaaaaaa trusted$/.test(cands[0]), r.out);
  ok("bar: below it is never printed (49 stars / 99 installs, 366 days, neither)", !/pdf-low|pdf-old|pdf-none/.test(r.out), r.out);
  ok("bar: 100 installs, 50 stars and 365 days are each enough", at(/ acme\/pdf-tools pdf-100 /) > 0 && at(/ stars\/fifty pdf-50 /) > 0 && at(/ edge\/repo pdf-edge /) > 0, r.out);
  ok("rank: trusted beats a higher-starred untrusted one", at(/ anthropics\/skills pdf /) < at(/ big\/stars pdf-big /), r.out);
  ok("rank: then max(installs, stars): 5000 > 1000 > 100 > 80 > 50",
    [/ big\/stars /, / edge\/repo /, / acme\/pdf-tools /, / gh\/only /, / stars\/fifty /].map(at).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])), r.out);
  ok("installed: a plugin skill matched by its description is trusted, named by its plugin's repo; merged, it keeps the trust", / plug\/pdfplug form-fill skills\.sh stars=0 installs=7 .* trusted$/m.test(r.out), r.out);
  ok("installed: one with no plugin.json is listed as installed/local, no sha", / installed\/local pdf-notes installed .*sha=- trusted$/m.test(r.out), r.out);
  ok("installed: a skill whose name and description miss the term is not listed", !/unrelated/.test(r.out), r.out);
  ok("github: a root SKILL.md is named by its repo", / gh\/only only github stars=80 /.test(r.out), r.out);
  ok("dedupe: one line per repo and skill across sources", cands.filter((l) => / anthropics\/skills pdf /.test(l)).length === 1 && cands.filter((l) => / big\/stars pdf-big /.test(l)).length === 1, r.out);
  ok("names: a repo or skill name with whitespace from the network is never printed", !/evil|IGNORE/.test(r.out), r.out);
  ok("SKIP: a failed marketplace prints its reason and the rest still run",
    lines.includes("SKIP marketplace anthropics/claude-plugins-official: HTTP 502: bad gateway") && cands.length === 8, r.out);
  const log = fs.readFileSync(LOG, "utf8");
  ok("sha: only candidates that cleared the bar are asked for one", !/repos\/(acme\/low|old\/repo|none\/neither)\/commits/.test(log) && /repos\/big\/stars\/commits\/HEAD -q \.sha/.test(log), log);

  r = await find.main(["pdf", "--json"], deps);
  const j = JSON.parse(r.out), d = j.candidates.find((x) => x.repo === "big/stars");
  ok("--json: {term, candidates, skipped}", j.term === "pdf" && Array.isArray(j.candidates) && j.candidates.length === 8 && j.skipped.length === 1, r.out.slice(0, 400));
  ok("--json: a merged candidate keeps the first source, the other's path, the full sha and every field",
    d && d.rank === 4 && d.source === "skills.sh" && d.path === "skills/pdf-big/SKILL.md" && d.stars === 5000 && d.installs === 0 && d.sha === SHA("b") && d.trusted === false && /^\d{4}-\d\d-\d\dT/.test(d.pushed_at), JSON.stringify(d));

  r = await find.main(["pdf"], { ...deps, fetch: async () => { throw new Error("getaddrinfo ENOTFOUND skills.sh"); } });
  ok("SKIP: skills.sh down prints its reason, the other sources still answer",
    /^SKIP skills\.sh: getaddrinfo ENOTFOUND skills\.sh$/m.test(r.out) && /anthropics\/skills pdf marketplace /.test(r.out) && /gh\/only/.test(r.out), r.out);
  r = await find.main(["pdf"], { ...deps, fetch: async () => ({ ok: false, status: 503 }) });
  ok("SKIP: an HTTP error from skills.sh names the status", /^SKIP skills\.sh: HTTP 503$/m.test(r.out), r.out);

  r = await find.main(["zzz"], deps);
  ok("NONE: nothing qualifies prints NONE <term>, exit 0", r.code === 0 && /^NONE zzz$/m.test(r.out) && !/^\d+ /m.test(r.out), r.out);

  r = await find.main([], deps);
  ok("usage: no term exits 2", r.code === 2 && /usage:/.test(r.err));
  r = await find.main(["-x"], deps);
  ok("usage: a term starting with - exits 2 (never a gh flag)", r.code === 2);
  r = lib.run(SF, "", { args: ["--help"] });
  ok("--help: the script runs, prints the bar and exits 0", r.code === 0 && /usage: node proteus-skill-find\.js <term> \[--json\]/.test(r.out) && /365 days/.test(r.out), r.out + r.err);
  lib.summary();
})();
