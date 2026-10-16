#!/usr/bin/env node
// Owned-path check for changes that never pass through an Edit/Write hook (sed -i, redirects, a script).
//   --staged        git pre-commit in a worker worktree: staged paths against the worktree's owned-path list
//                   (proteus-worktree.js installs this as that worktree's pre-commit hook)
//   --ci <base>     CI on a PR: paths changed since <base> against the ticket's owned paths. The head branch is
//                   env GITHUB_HEAD_REF (else the checked-out branch). Which list counts:
//                   - a worker PR into a run branch (head proteus-work/<run>/<id>, base proteus/<run>): the file
//                     .proteus/owned/<id> as committed on <base>, which the lead writes and only a merged PR
//                     changes; never the PR's own copy, and never the PR body, which the worker writes
//                   - the lead's docs PR (head proteus-work/<run>/lead-docs): the lead's docs, teams/, the
//                     records under .proteus/owned/, and the lead-edits: globs of <base>'s AGENTS.md
//                   - a PR into main (Quick, Direct; the human merges those) or a run whose <base> has no
//                     .proteus/owned/ yet (cut before the records, until its close PR merges): the "Owned:"
//                     line of the PR body (env PR_BODY), entries separated by commas or spaces
// Matching is proteus-lib's ownedMatch, the same rule the edit hooks apply. The owned-path list file itself is
// refused in every mode whatever the globs (lib.isOwnedList), and so is any record under .proteus/owned/ outside
// the lead's docs PR. Exit 1 lists the paths outside the list, or says the list is missing; exit 2 is bad usage.
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 60000 });
const tryGit = (args) => { try { return git(args); } catch { return null; } };
// NUL-separated, so a path with a space or a quote comes back as written; --no-renames lists both ends of a move
const names = (args) => git(["diff", "--name-only", "--no-renames", "-z", ...args]).split("\0").filter(Boolean);
const RECORDS = lib.OWNED_RECORDS;
// what the lead's docs PR may change: the docs the lead guard lets it write, bootstrap's teams/, the records
const LEAD_DOCS = ["CONTEXT.md", "CONVENTIONS.md", "AGENTS.md", "docs/adr/", "docs/lessons/", "teams/", `${RECORDS}/`];
const lines = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const fail = (msg) => { console.error(`proteus-owned-check: ${msg}`); process.exit(1); };

function fromBody() {
  const m = /^Owned:[ \t]*(.+)$/im.exec(process.env.PR_BODY || "");
  const owned = m ? m[1].split(/[,\s]+/).filter(Boolean) : [];
  if (!owned.length) fail("the PR body has no \"Owned: <paths and globs>\" line; copy it from the ticket");
  return owned;
}

const [mode, base] = process.argv.slice(2);
let bad = [];
let from = "";
if (mode === "--staged") {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  if (!require("fs").existsSync(lib.ownedFile(root))) process.exit(0);
  from = path.relative(root, lib.ownedFile(root)).split(path.sep).join("/");
  bad = names(["--cached"]).filter((p) => lib.ownedDenial(root, p));
} else if (mode === "--ci" && base) {
  if (!tryGit(["rev-parse", "--verify", "-q", `${base}^{commit}`])) fail(`${base} is not a commit in this checkout; fetch it (actions/checkout with fetch-depth: 0)`);
  const head = process.env.GITHUB_HEAD_REF || (tryGit(["symbolic-ref", "-q", "--short", "HEAD"]) || "").trim();
  const baseName = base.replace(/^refs\/remotes\//, "").replace(/^[^/]+\/(?=proteus\/)/, "");
  const w = /^proteus-work\/[^/]+\/([A-Za-z0-9][\w.-]*)$/.exec(head);
  const runPr = Boolean(w) && baseName.startsWith("proteus/");
  const recorded = runPr && (tryGit(["cat-file", "-t", `${base}:${RECORDS}`]) || "").trim() === "tree";
  let owned, records = false;
  if (recorded && w[1] === "lead-docs") {
    const leadEdits = /^lead-edits:(.*)$/m.exec(tryGit(["show", `${base}:AGENTS.md`]) || "");
    owned = [...LEAD_DOCS, ...(leadEdits ? leadEdits[1].split(/\s+/).filter(Boolean) : [])];
    from = "the lead's docs (lead-docs PR)";
    records = true;
  } else if (recorded) {
    const file = `${RECORDS}/${w[1]}`;
    owned = lines(tryGit(["show", `${base}:${file}`]));
    if (!owned.length) fail(`${base} has no ${file}, so this PR has no owned paths to check against. The lead records the ticket's owned paths there before dispatch (flow.md step 4); a PR body's Owned: line does not count on a run branch.`);
    from = `${file} on ${base}`;
  } else {
    if (runPr) console.error(`proteus-owned-check: warning: ${base} has no ${RECORDS}/, a run cut before the lead's records; checking the PR body's Owned: line, which the worker writes, until this run's close PR merges`);
    owned = fromBody();
    from = "the PR body's Owned: line";
  }
  // the owned-path list itself fails whatever the list says, as ownedDenial refuses it for --staged; so does a
  // record, which would widen a later check, outside the lead's docs PR
  bad = names([`${base}...HEAD`]).filter((p) => lib.isOwnedList(process.cwd(), p) || (!records && lib.isOwnedRecord(p)) || !owned.some((g) => lib.ownedMatch(g, p)));
} else {
  console.error("usage: node proteus-owned-check.js --staged | --ci <base-ref>");
  process.exit(2);
}
if (bad.length) {
  console.error(`proteus-owned-check: not in ${from}:\n  ${bad.join("\n  ")}\nComment "NEEDS <path>: <why>" on the issue and stop.`);
  process.exit(1);
}
