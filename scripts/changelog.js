#!/usr/bin/env node
// Changelog fragments: every PR adds changelog.d/<slug>.md instead of editing CHANGELOG.md, so open PRs never conflict there.
// Usage: node scripts/changelog.js                                   print the merged Unreleased notes
//        node scripts/changelog.js --release X.Y.Z [--date YYYY-MM-DD]   fold them into CHANGELOG.md, delete the fragments
// --root <dir> reads <dir> instead of the repo root (tests). Plain Node, no dependencies.
"use strict";
const fs = require("fs");
const path = require("path");

const ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const die = (m) => { process.stderr.write(`changelog: ${m}\n`); process.exit(1); };

// "### Added" sections of bullets -> { Added: [bullet text, ...] }; throws on anything else
function parse(text, label) {
  const out = {};
  let sec = null, item = null;
  text.split(/\r?\n/).forEach((l, i) => {
    const bad = (why) => { throw new Error(`${label}:${i + 1}: ${why}`); };
    const h = /^###\s+(.*?)\s*$/.exec(l);
    if (h) {
      if (!ORDER.includes(h[1])) bad(`unknown section "${h[1]}" (use ${ORDER.join(", ")})`);
      sec = h[1]; item = null; out[sec] = out[sec] || [];
    } else if (/^-\s/.test(l)) {
      if (!sec) bad("bullet before any ### section");
      out[sec].push(l); item = out[sec].length - 1;
    } else if (l.trim()) {
      if (item === null) bad(`expected "### <section>" or a "- " bullet, got "${l.trim().slice(0, 40)}"`);
      out[sec][item] += "\n" + l;
    }
  });
  for (const s of Object.keys(out)) if (!out[s].length) throw new Error(`${label}: section "${s}" has no bullets`);
  return out;
}

function render(parts) {
  const out = [];
  for (const s of ORDER) {
    const items = parts.flatMap((p) => p[s] || []);
    if (items.length) out.push(`### ${s}`, "", ...items, "");
  }
  return out.join("\n");
}

function main(argv) {
  let release = null, date = null, root = path.resolve(__dirname, "..");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i] || die(`${a} needs a value`);
    if (a === "--release") release = v();
    else if (a === "--date") date = v();
    else if (a === "--root") root = path.resolve(v());
    else die(`unknown argument ${a}`);
  }
  if (date && !release) die("--date only goes with --release");
  if (release !== null && !/^\d+\.\d+\.\d+$/.test(release)) die(`version "${release}" is not X.Y.Z`);
  if (date !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0, 10) === date)) die(`date "${date}" is not a real YYYY-MM-DD`);
  if (release && !date) { const d = new Date(); date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

  const dir = path.join(root, "changelog.d");
  const names = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const file = path.join(root, "CHANGELOG.md");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+\[Unreleased\]\s*$/i.test(l));
  let end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  if (end < 0) end = lines.length;

  const parts = [];
  try {
    if (at >= 0) parts.push(parse(lines.slice(at + 1, end).join("\n"), "CHANGELOG.md [Unreleased]"));
    for (const n of names) {
      const p = parse(fs.readFileSync(path.join(dir, n), "utf8"), `changelog.d/${n}`);
      if (!Object.keys(p).length) throw new Error(`changelog.d/${n}: no "### <section>" with bullets`);
      parts.push(p);
    }
  } catch (e) { die(e.message); }
  const body = render(parts);

  if (!release) { process.stdout.write(body ? body : "(no unreleased notes)\n"); return; }
  if (at < 0) die("CHANGELOG.md has no ## [Unreleased] heading");
  if (!body) die("nothing to release: no fragments and no Unreleased bullets");
  if (lines.some((l) => new RegExp(`^##\\s+\\[?v?${release.replace(/\./g, "\\.")}\\]?(\\s|$)`).test(l))) die(`CHANGELOG.md already has a ${release} section`);
  const next = [...lines.slice(0, at + 1), "", `## [${release}] - ${date}`, "", ...body.split("\n"), ...lines.slice(end)];
  fs.writeFileSync(file, next.join("\n"));
  for (const n of names) fs.unlinkSync(path.join(dir, n));
  process.stdout.write(`changelog: ${release} written with ${names.length} fragment${names.length === 1 ? "" : "s"}; fragments deleted\n`);
}

main(process.argv.slice(2));
