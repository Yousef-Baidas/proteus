// Change-tier tests: node tests/tiers.test.js (needs git). The classifier reads the tiers block of teams/ROUTING.md;
// the worktree pre-commit hook and the CI tier step fail a change that outgrew its declared tier; the guards let
// the Direct helper edit, commit and push its batch branch and nothing broader.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const T = require(path.join(__dirname, "lib.js"));
const { ok, g, summary } = T;
const W = T.workdir("tiers");
const lib = require(path.join(HOOKS, "proteus-lib.js"));
const TIER = path.join(HOOKS, "proteus-tier.js");

// ---- the classifier
const block = (rules) => "# Routing\n\n| a | b |\n|---|---|\n\n```tiers\n" + rules + "\n```\n";
const B = lib.parseTiers(block([
  "# comment line",
  "CONVENTIONS.md   full",
  "**/auth/**       full",
  "docs/api/**      standard",
  "docs/**          direct  lines=10 files=2   # trailing comment",
  "src/**           quick   lines=50",
].join("\n")));
const cls = (...c) => lib.classifyTier(B, c.map(([p, n]) => ({ path: p, lines: n || 0 })));
ok("parse: rules in order with limits, comments skipped", B.errors.length === 0 && B.rules.length === 5 &&
  B.rules[3].glob === "docs/**" && B.rules[3].lines === 10 && B.rules[3].files === 2 && B.rules[4].files === Infinity, JSON.stringify(B));
ok("parse: no tiers fence is null", lib.parseTiers("# Routing\n```js\nx\n```\n") === null && lib.parseTiers("") === null);
const bad = lib.parseTiers(block("docs/** cheap\nsrc/** quick lines=many"));
ok("parse: an unknown tier or option is an error, not a default", bad.errors.length === 2 && bad.rules.length === 0 && /bad tiers line "docs\/\*\* cheap"/.test(bad.errors[0]), bad.errors);
ok("classify: no block is standard (today's pipeline)", lib.classifyTier(null, [{ path: "README.md", lines: 1 }]).tier === "standard");
ok("classify: a docs typo is direct", cls(["docs/guide.md", 2]).tier === "direct");
ok("classify: first match wins (docs/api is standard, not direct)", cls(["docs/api/openapi.md", 1]).tier === "standard");
ok("classify: by path, never by extension (markdown outside docs/ is standard; CONVENTIONS.md is full)",
  cls(["skills/x/SKILL.md", 1]).tier === "standard" && cls(["CONVENTIONS.md", 1]).tier === "full");
ok("classify: a leading **/ also matches at the root", cls(["auth/login.ts", 1]).tier === "full" && cls(["src/auth/login.ts", 1]).tier === "full");
let c = cls(["docs/a.md", 6], ["docs/b.md", 6]);
ok("classify: over a rule's lines= costs one tier more and says why", c.tier === "quick" && /docs\/a\.md, docs\/b\.md: direct \(docs\/\*\*\), over lines=10 \(12\) → quick/.test(c.why[0]), c.why);
ok("classify: over files= too", cls(["docs/a.md"], ["docs/b.md"], ["docs/c.md"]).tier === "quick");
c = cls(["docs/a.md", 1], ["src/x.ts", 5], ["lib/y.ts", 1]);
ok("classify: the highest path wins, unmatched paths are standard", c.tier === "standard" && c.why.length === 1 && /lib\/y\.ts: standard \(no tier rule\)/.test(c.why[0]), c.why);
const over = (d, ...p) => lib.tierOverrun(lib.parseDeclared(d), cls(...p));
ok("overrun: fits → empty; outgrown → names the tier it needs and the re-run",
  over("direct", ["docs/a.md", 1]) === "" && /needs the standard tier, declared direct:\n  lib\/y\.ts[\s\S]*re-runs the work order at standard/.test(over("direct", ["lib/y.ts", 1])));
ok("overrun: a human quick: covers standard work, never full", over("quick (human)", ["lib/y.ts", 1]) === "" && over("quick", ["lib/y.ts", 1]) !== "" &&
  /needs the full tier, declared quick \(human\)/.test(over("quick human", ["CONVENTIONS.md", 1])));
ok("overrun: full fits everything", over("Full", ["CONVENTIONS.md", 900]) === "");
ok("declared: unknown word is null", lib.parseDeclared("fast") === null && lib.parseDeclared("standardized") === null);

// ---- a repo with a local remote: the lead's command, the pre-commit hook, CI, the guards
const BARE = path.join(W, "remote.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
put(REPO, "teams/ROUTING.md", block("teams/**  direct\ndocs/**  direct  lines=5\n**/auth/**  full"));
put(REPO, "docs/a.md", "a\n"); put(REPO, "src/x.ts", "x\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "remote", "add", "origin", BARE); g(REPO, "push", "-q", "-u", "origin", "main"); g(REPO, "remote", "set-head", "origin", "main");
const tier = (cwd, args, env = {}) => T.run(TIER, "", { cwd, args, env });

let r = tier(REPO, ["docs/a.md", "./docs/b.md"]);
ok("lead: planned docs paths print direct and the rule", r.code === 0 && r.out.startsWith("direct\n  docs/a.md, docs/b.md: direct (docs/**)"), r.out + r.err);
r = tier(path.join(REPO, "docs"), ["src/auth/x.ts", "docs/a.md"]);
ok("lead: from a subdirectory the repo's ROUTING.md still applies; a full path wins", r.code === 0 && r.out.startsWith("full\n"), r.out + r.err);
ok("lead: no path is a usage error", tier(REPO, []).code === 2 && tier(REPO, ["--nope"]).code === 2);

// the Direct worktree: the batch branch from main, prepared with --tier direct
const WT = path.join(W, "direct");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/direct/2026-10-04", WT, "main");
r = T.run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "--tier", "direct", "docs/"] });
const base = g(REPO, "rev-parse", "main");
const list = () => fs.readFileSync(lib.ownedFile(WT), "utf8");
ok("worktree: --tier writes the tier and base as a comment the owned check skips", r.code === 0 && /tier direct/.test(r.out) &&
  list() === `# tier direct ${base}\ndocs/\n` && lib.ownedDenial(WT, "docs/a.md") === "", r.out + r.err + list());
ok("worktree: a bad --tier is a usage error", T.run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "--tier", "cheap", "docs/"] }).code === 1 && list().startsWith("# tier direct"));
const commit = (dir, file, text) => {
  put(dir, file, text);
  g(dir, "add", file);
  return spawnSync("git", ["commit", "-qm", "docs: fix typo"], { cwd: dir, encoding: "utf8", env: T.ENV });
};
r = commit(WT, "docs/a.md", "b\n");
ok("pre-commit: a change within Direct commits", r.status === 0, r.stderr);
r = commit(WT, "docs/b.md", lines(4));
ok("pre-commit: the batch is measured from its base, so a second change that passes lines=5 is refused",
  r.status !== 0 && /needs the quick tier, declared direct:\n  docs\/a\.md, docs\/b\.md: direct \(docs\/\*\*\), over lines=5 \(6\) → quick/.test(r.stderr), r.stderr);
g(WT, "reset", "-q", "--hard");
T.run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "--tier", "direct", "docs/", "README.md"] });
ok("worktree: a re-run for the next change in the batch keeps the first base", list() === `# tier direct ${base}\ndocs/\nREADME.md\n`, list());
r = commit(WT, "README.md", "readme\n");
ok("pre-commit: a path with no tier rule is standard and refused on a Direct branch", r.status !== 0 && /needs the standard tier/.test(r.stderr), r.stderr);
g(WT, "reset", "-q", "--hard");

// a Quick worktree under the human's quick: covers standard paths, never full ones
const WQ = path.join(W, "quick");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/quick/7", WQ, "main");
T.run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: REPO, args: [WQ, "--tier", "quick", "--human", "src/"] });
ok("pre-commit: quick (human) commits a standard path", commit(WQ, "src/x.ts", "y\n").status === 0);
r = commit(WQ, "src/auth/login.ts", "z\n");
ok("pre-commit: quick (human) still refuses a full path", r.status !== 0 && /needs the full tier, declared quick \(human\)/.test(r.stderr), r.stderr);
g(WQ, "reset", "-q", "--hard");

// CI: the diff since the base against the declared tier, with the rules as of the base
const ci = (cwd, body, head) => tier(cwd, ["--ci", "origin/main"], { PR_BODY: body, GITHUB_HEAD_REF: head || "" });
r = ci(WT, "Owned: docs/", "proteus-work/direct/2026-10-04");
ok("ci: a Direct batch within its limits passes", r.code === 0 && /fits direct/.test(r.out), r.out + r.err);
r = ci(WQ, "Tier: quick (human)\nOwned: src/", "proteus-work/quick/7");
ok("ci: the PR body's Tier: line is the declared tier", r.code === 0 && /fits quick \(human\)/.test(r.out), r.out + r.err);
ok("ci: no Tier: line means standard; outgrown fails", ci(WQ, "Owned: src/").code === 0 && ci(WQ, "Tier: direct").code === 1);
ok("ci: an unknown Tier: word is an error", ci(WQ, "Tier: tiny").code === 2);
// a Direct branch cannot claim a higher tier in its body, nor loosen the rules in its own diff
put(WT, "teams/ROUTING.md", block("teams/**  direct\ndocs/**  direct  lines=500"));
put(WT, "docs/c.md", lines(20));
g(WT, "add", "-A"); spawnSync("git", ["commit", "-qm", "docs: more", "--no-verify"], { cwd: WT, env: T.ENV });
r = ci(WT, "Tier: full\nOwned: docs/ teams/", "proteus-work/direct/2026-10-04");
ok("ci: a proteus-work/direct/ branch is judged as direct whatever its body says, by the base's rules",
  r.code === 1 && /declared direct:[\s\S]*over lines=5/.test(r.err), r.err);
const NOR = path.join(W, "norouting");
g(W, "init", "-q", "-b", "main", NOR); put(NOR, "a.txt", "a\n"); g(NOR, "add", "-A"); g(NOR, "commit", "-qm", "init");
g(NOR, "checkout", "-q", "-b", "proteus-work/r/1"); put(NOR, "b.txt", "b\n"); g(NOR, "add", "-A"); g(NOR, "commit", "-qm", "feat: b");
ok("ci: a repo with no tiers block is unchanged: everything is standard and passes",
  tier(NOR, ["--ci", "main"], { PR_BODY: "Owned: b.txt" }).code === 0 && tier(NOR, ["a.txt"]).out.startsWith("standard\n"));

// guest mode: teams/ lives in the guest dir, outside git; the lead's command and the pre-commit hook read it there
const GR = path.join(W, "guest");
g(W, "init", "-q", "-b", "main", GR);
put(GR, "docs/a.md", "a\n");
g(GR, "add", "-A"); g(GR, "commit", "-qm", "init");
const GD = path.join(W, "guest-dir");
put(GD, "teams/ROUTING.md", block("docs/**  direct  lines=5"));
put(GR, ".git/proteus/guest.json", JSON.stringify({ dir: GD }));
r = tier(GR, ["docs/a.md"]);
ok("guest: the lead's command reads ROUTING.md from the guest dir", r.code === 0 && r.out.startsWith("direct\n  docs/a.md: direct (docs/**)"), r.out + r.err);
const GW = path.join(W, "guest-wt");
g(GR, "worktree", "add", "-q", "-b", "proteus-work/direct/g", GW, "main");
T.run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: GR, args: [GW, "--tier", "direct", "docs/"] });
r = commit(GW, "docs/a.md", "b\n");
ok("guest: pre-commit measures against the guest dir's rules, so a Direct change commits", r.status === 0, r.stderr);
r = commit(GW, "docs/a.md", lines(9));
ok("guest: and still refuses one over them", r.status !== 0 && /needs the quick tier, declared direct/.test(r.stderr), r.stderr);

// the shipped CI template wires the tier step on worker PRs and a docs-only job for Direct batches into main
const tpl = fs.readFileSync(path.join(ROOT, "templates", "ci", "proteus-gates.yml"), "utf8");
ok("template: PRs into main run, gates on run branches and Quick, a direct job with the docs gate and the tier check",
  /branches: \["proteus\/\*\*", "main"\]/.test(tpl) && /^  gates:\n    # [^\n]*\n    if: github\.event_name == 'push' \|\| startsWith\(github\.base_ref, 'proteus\/'\) \|\| startsWith\(github\.head_ref, 'proteus-work\/quick\/'\)/m.test(tpl) &&
  /- name: tier\n\s+if: startsWith\(github\.head_ref, 'proteus-work\/'\)[\s\S]*proteus-tier\.js --ci/.test(tpl) &&
  /^  direct:\n    if: startsWith\(github\.head_ref, 'proteus-work\/direct\/'\) && !startsWith\(github\.base_ref, 'proteus\/'\)[\s\S]*EDIT-docs[\s\S]*proteus-owned-check\.js --ci[\s\S]*proteus-tier\.js --ci[\s\S]*commit-msg\.js/m.test(tpl));
const shipped = lib.parseTiers(fs.readFileSync(path.join(ROOT, "templates", "teams", "ROUTING.md"), "utf8"));
ok("template: the shipped ROUTING.md tiers block parses; docs typos are direct, CI, lockfiles and CONVENTIONS.md full",
  shipped && !shipped.errors.length && lib.classifyTier(shipped, [{ path: "docs/setup.md", lines: 3 }]).tier === "direct" &&
  ["CONVENTIONS.md", ".github/workflows/ci.yml", "web/package-lock.json", "db/migrations/1.sql", "teams/ROUTING.md"].every((p) => lib.classifyTier(shipped, [{ path: p, lines: 1 }]).tier === "full"));

// ---- the guards: the Direct helper (a subagent) edits in its prepared worktree, commits and pushes its batch
// branch; it still cannot edit the main checkout, push main, or reach a run branch
const LG = path.join(HOOKS, "proteus-lead-guard.js");
const helper = { agent_id: "d1", agent_type: "general-purpose" };
const ev = (tool, ti) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: tool, tool_input: ti, ...helper });
const guard = (tool, ti) => T.run(LG, ev(tool, ti), { cwd: REPO });
ok("guard: the Direct helper edits an owned path in its worktree", guard("Edit", { file_path: path.join(WT, "docs", "a.md") }).code === 0);
ok("guard: and nothing outside its owned paths", guard("Edit", { file_path: path.join(WT, "src", "x.ts") }).code === 2);
r = guard("Edit", { file_path: path.join(REPO, "docs", "a.md") });
ok("guard: an open Direct batch keeps the main checkout off limits", r.code === 2 && /main checkout/.test(r.err), r.err);
const sh = (command) => T.run(LG, { ...ev("Bash", { command }), cwd: WT }, { cwd: WT });
g(WT, "push", "-q", "-u", "origin", "proteus-work/direct/2026-10-04");
ok("guard: the helper commits and pushes the batch branch again, and opens or edits its PR into main",
  ["git commit -m 'docs: fix typo'", "git push", "git push origin proteus-work/direct/2026-10-04", "gh pr create --base main --fill", "gh pr edit 9 --body-file digest.md"].every((cmd) => sh(cmd).code === 0));
ok("guard: still no push to main and no --admin merge", sh("git push origin HEAD:main").code === 2 && sh("gh pr merge 9 --admin").code === 2);

summary();
