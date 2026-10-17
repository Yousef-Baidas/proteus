#!/usr/bin/env node
// The human's inbox: open needs-human issues, split into questions (proteus-question) and
// reviews (proteus-review), cached in <git-common-dir>/proteus/inbox.json.
//   node .claude/hooks/proteus-inbox.js            one line per item, from the cache
//   node .claude/hooks/proteus-inbox.js --refresh  query gh, rewrite the cache, then print
//   node .claude/hooks/proteus-inbox.js --count    "<questions> <reviews>"
// gh failing keeps the old cache; always exits 0.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const args = process.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  console.log(`usage: node proteus-inbox.js [--refresh | --count]
The human's inbox: open needs-human issues, split into questions (proteus-question) and reviews
(proteus-review), cached in <git-common-dir>/proteus/inbox.json.
  (no flag)   one line per item, from the cache
  --refresh   query gh, rewrite the cache, then print
  --count     "<questions> <reviews>"
gh failing keeps the old cache. Always exits 0.`);
  return;
}
try {
  // the session's repo (the cwd's), else the one this script is installed in
  const root = lib.repoRoot();
  const common = root && lib.gitCommonDir(root);
  if (!common) return;
  const inbox = (args.includes("--refresh") && lib.refreshInbox(root, common)) || lib.readInbox(common);
  if (args.includes("--count")) console.log(inbox ? `${inbox.questions.length} ${inbox.reviews.length}` : "0 0");
  else if (!inbox) console.log("inbox: no cache (gh unreachable?)");
  else if (!inbox.questions.length && !inbox.reviews.length) console.log(`inbox: empty (as of ${inbox.at})`);
  else for (const [tag, list] of [["question", inbox.questions], ["review", inbox.reviews]]) for (const i of list) console.log(`${tag} #${i.n} ${i.title}`);
} catch {}
// no process.exit: it can drop a piped stdout that has not drained yet
