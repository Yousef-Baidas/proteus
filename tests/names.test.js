// Name contract (#5): nothing Proteus ships still names the pipeline `hive`, outside an allowlisted region.
// Scans every git-tracked file under skills/, agents/, templates/, docs/, plus README.md and install.js, for hive
// branch, label, CI and state names; a hit fails unless it sits in an ALLOW region, found by symbol or marker, never
// by line number. A self-check runs the same scan on a synthetic tree under os.tmpdir() first.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ok, workdir, summary } = require(path.join(__dirname, "lib.js"));

const ROOT = path.join(__dirname, "..");
const SCOPE = ["skills", "agents", "templates", "docs", "README.md", "install.js"];
// anchored both ends: not inside a longer word, name or path segment (archive/, my-hive-logs, foo.git/hive, .git/hive-x)
const PATTERNS = [/(^|[^\w.-])hive(\/|(-evidence|-gates|-log|-review|-debt|-question|-branches)(?![\w-]))/, /"hive"/, /(^|[^\w.-])\.git\/hive(?![\w-])/];

// legacy allowlist: file, the line that opens the region, and either `to` (last line, inclusive)
// or `before` (first line after it); with neither, the region is the opening line alone
const ALLOW = [
  { file: "install.js", why: "OLD_WORKER_SETTINGS", from: /^const OLD_WORKER_SETTINGS = / },
  { file: "install.js", why: "pastShipped", from: /^\/\/ A file identical to a version this checkout once shipped/, to: /^}$/ },
];

// { hits: ["file:line: text"], missing: ["file: why"], ranges: ["file:a-b why"] } for files (paths relative to root)
function scan(root, files) {
  const hits = [], missing = [], ranges = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const allowed = new Set();
    for (const a of ALLOW.filter((x) => x.file === f)) {
      const at = lines.findIndex((l) => a.from.test(l));
      const end = a.to || a.before;
      const stop = at < 0 || !end ? at : lines.findIndex((l, i) => i > at && end.test(l));
      if (at < 0 || stop < 0) { missing.push(`${f}: ${a.why}`); continue; }
      const last = a.before ? stop - 1 : stop;
      for (let i = at; i <= last; i++) allowed.add(i);
      ranges.push(`${f}:${at + 1}-${last + 1} ${a.why}`);
    }
    lines.forEach((l, i) => {
      if (!allowed.has(i) && PATTERNS.some((re) => re.test(l))) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  return { hits, missing, ranges };
}

// self-check: every legacy region holds a hive name and passes; a stray one anywhere else fails
const T = path.join(workdir("names"), "tree");
const put = (f, body) => { fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true }); fs.writeFileSync(path.join(T, f), body); };
put("install.js", [
  "const HOME = 1;",
  "const OLD_WORKER_SETTINGS = \"hive-evidence/\";",
  "// A file identical to a version this checkout once shipped",
  "function pastShipped() {",
  "  return \".git/hive\";",
  "}",
  "function install() {}",
  "",
].join("\n"));
put("skills/proteus/references/tracker.md", "# Tracker\n\nLabels `proteus`, `proteus-log`.\n");
const SELF = ["install.js", "skills/proteus/references/tracker.md"];
const clean = scan(T, SELF);
ok("the self-check tree resolves every allowlist anchor", clean.missing.length === 0, clean.missing.join("; "));
ok("hive names inside the legacy regions pass", clean.hits.length === 0, clean.hits.join("; "));
// near misses: a longer word, name or path segment is not a hive name
put("skills/proteus/references/near.md", "Open archive/x and the my-hive-logs dir, hive-gates-v2, foo.git/hive and .git/hive-x; also Archive/hive-ish.\n");
ok("near misses inside a longer word, name or path segment do not match", scan(T, ["skills/proteus/references/near.md"]).hits.length === 0, scan(T, ["skills/proteus/references/near.md"]).hits.join("; "));
fs.appendFileSync(path.join(T, "skills/proteus/references/tracker.md"), "git push origin hive/x\nlabel \"hive\" and .git/hive\n");
fs.appendFileSync(path.join(T, "install.js"), "const BRANCH = \"hive/\";\n");
const dirty = scan(T, SELF);
ok("a stray `git push origin hive/x` in a reference file fails", dirty.hits.some((h) => h.startsWith("skills/proteus/references/tracker.md:4:")), dirty.hits.join("; "));
ok("a `\"hive\"` label and `.git/hive` in a reference file fail", dirty.hits.some((h) => h.startsWith("skills/proteus/references/tracker.md:5:")), dirty.hits.join("; "));
ok("a hive name in install.js outside the legacy regions fails", dirty.hits.some((h) => h.startsWith("install.js:8:")), dirty.hits.join("; "));
ok("only the three stray lines fail", dirty.hits.length === 3, dirty.hits.join("; "));
fs.writeFileSync(path.join(T, "install.js"), "const OLD_WORKER_SETTINGS = 1;\n");
ok("an allowlist anchor gone from its file fails", scan(T, ["install.js"]).missing.length === 1);

// the real tree: every tracked file in scope
let files = [];
try {
  files = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 30000 }).split("\0").filter(Boolean);
} catch {}
console.log(`${ROOT}: ${files.length} tracked files scanned`);
ok("git lists the tracked files in scope", files.length > 0);
const real = scan(ROOT, files);
console.log(`allowlist: ${real.ranges.join(", ")}`);
ok("every legacy allowlist anchor is found", real.missing.length === 0, real.missing.join("; "));
ok("no shipped file names hive outside the legacy allowlist", real.hits.length === 0, `${real.hits.length} hits: ${real.hits.slice(0, 5).join(" | ")}`);
if (real.hits.length) console.log(real.hits.map((h) => `  ${h}`).join("\n"));

summary();
