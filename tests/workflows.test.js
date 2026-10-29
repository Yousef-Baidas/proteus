// Workflow hardening tests: node tests/workflows.test.js. Both .github/workflows/ci.yml and the shipped
// templates/ci/proteus-gates.yml keep ${{ }} out of run: scripts (a fork names its own head branch), hold a read-only
// token that checkout does not persist, pin every action to a commit SHA, and install without lifecycle scripts.
// templates/ci/proteus-trust.yml, on pull_request_target, runs only the base's code in two jobs: scan, read-only and
// tokenless, runs the pinned scanners on the head as data under head/; post, the one job with a write scope
// (statuses), checks out only the base and reads scan's artifact.
// Also checks the anti-slop plugin's provenance record. Reads files only; no temp dir.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { ok, summary } = require(path.join(__dirname, "lib.js"));

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n"); // a win32 checkout may have CRLF
const indent = (l) => l.length - l.trimStart().length;

// every run: script in a workflow as { line, text }: the value on the key's line plus every following line indented
// deeper than the key (a | or > block, or a plain scalar's continuation); comment lines never open one
function runScripts(yml) {
  const lines = yml.split("\n");
  const out = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)(- )?run:(.*)$/.exec(l);
    if (!m) return;
    const key = m[1].length + (m[2] ? 2 : 0);
    let text = m[3];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > key); j++) text += "\n" + lines[j];
    out.push({ line: i + 1, text });
  });
  return out;
}

// the lines of the step that opens at line i (a "- " item): up to the next line indented no deeper than its dash
function stepAt(lines, i) {
  const dash = indent(lines[i]);
  let j = i + 1;
  while (j < lines.length && (!lines[j].trim() || indent(lines[j]) > dash)) j++;
  return lines.slice(i, j).join("\n");
}

const interpolated = (yml) => runScripts(yml).filter((s) => s.text.includes("${{"));

// self-check: the scan sees an expression in an inline, a literal and a folded script, and none in env: or with:
const planted = [
  "jobs:",
  "  a:",
  "    steps:",
  "      - run: echo ${{ github.head_ref }}",
  "      - name: block",
  "        env:",
  "          OK: ${{ github.base_ref }}",
  "        run: |",
  "          echo one",
  "          git rev-list origin/${{ github.base_ref }}..HEAD",
  "      - name: folded",
  "        run: >-",
  "          echo",
  "          ${{ github.event.pull_request.title }}",
  "      - uses: actions/checkout@0000000000000000000000000000000000000000 # v4",
  "        with:",
  "          ref: ${{ github.sha }}",
  "      - run: echo clean",
].join("\n");
ok("self-check: an expression in an inline, a literal and a folded run: script is found; env:, with: and a clean script are not",
  interpolated(planted).map((s) => s.line).join(",") === "4,8,12" && runScripts(planted).length === 4, JSON.stringify(interpolated(planted)));

const FILES = { ci: [".github", "workflows", "ci.yml"], template: ["templates", "ci", "proteus-gates.yml"] };
const checkoutShas = new Set();
for (const [name, p] of Object.entries(FILES)) {
  const yml = read(...p);
  const lines = yml.split("\n");
  const scripts = runScripts(yml);
  ok(`${name}: no run: script interpolates \${{ }} (values reach scripts through env:)`,
    scripts.length > 0 && !interpolated(yml).length, interpolated(yml).map((s) => `${p.join("/")}:${s.line}: ${s.text.trim()}`).join(" | "));
  ok(`${name}: the base ref reaches every script through env BASE_REF, quoted`,
    /BASE_REF: \$\{\{ github\.base_ref \}\}/.test(yml) && scripts.filter((s) => /base_ref|BASE_REF/i.test(s.text)).every((s) => /"origin\/\$BASE_REF/.test(s.text)));

  ok(`${name}: a top-level permissions block grants contents: read and no job asks for write`,
    /^permissions:\n {2}contents: read\n(?! )/m.test(yml) && !/^\s*[\w-]+: write\b/m.test(yml) && !/write-all/.test(yml));

  const uses = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*- uses:/.test(l));
  ok(`${name}: every action is pinned to a full commit SHA with a version comment`,
    uses.length > 0 && uses.every(({ l }) => /- uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(l)), uses.map(({ l }) => l.trim()).join(" | "));
  ok(`${name}: no action, commented examples included, is referenced by a movable tag or branch`,
    !lines.some((l) => /uses: [\w.-]+\/[\w./-]+@(?![0-9a-f]{40}\b|<)/.test(l)), lines.filter((l) => /uses:/.test(l)).join(" | "));

  const checkouts = uses.filter(({ l }) => /actions\/checkout@/.test(l));
  for (const { l } of checkouts) checkoutShas.add(/@([0-9a-f]{40})/.exec(l)?.[1]);
  ok(`${name}: every checkout sets persist-credentials: false`,
    checkouts.length > 0 && checkouts.every(({ i }) => /\n\s+persist-credentials: false(\s|$)/.test(stepAt(lines, i))), checkouts.length);

  ok(`${name}: npm installs skip lifecycle scripts`,
    /npm ci --ignore-scripts/.test(yml) && !/npm ci(?! --ignore-scripts)/.test(yml), (yml.match(/.*npm ci\b.*/g) || []).join(" | "));
}
// proteus-trust.yml runs on pull_request_target with a token that may post statuses: the base's code only, two jobs
// on two VMs (steps of one job share a VM and a uid, so step order isolates nothing): scan reads the head with no
// write scope and no token in any step, post holds the one write scope, never checks out the head and reads the
// scan's artifact as data
const trust = read("templates", "ci", "proteus-trust.yml");
const tLines = trust.split("\n");
ok("trust: runs on pull_request_target into proteus/** only, no pull_request or push trigger",
  /^on:\n {2}pull_request_target:\n {4}branches: \["proteus\/\*\*"\]\npermissions:/m.test(trust) && !/^\s+(pull_request|push|workflow_run):/m.test(trust));
ok("trust: no run: script interpolates ${{ }}", runScripts(trust).length > 0 && !interpolated(trust).length, interpolated(trust).map((s) => s.text.trim()).join(" | "));
// the jobs, each as its own text: from its key under jobs: to the next
const jobs = {};
{
  const at = tLines.indexOf("jobs:");
  let name = null;
  for (const l of tLines.slice(at + 1)) {
    const m = /^ {2}([\w-]+):$/.exec(l);
    if (m) { name = m[1]; jobs[name] = ""; } else if (name) jobs[name] += l + "\n";
    if (/^\S/.test(l)) break;
  }
}
const { scan = "", post = "" } = jobs;
ok("trust: exactly two jobs, scan then post, and post needs scan", Object.keys(jobs).join() === "scan,post" && /^ {4}needs: scan$/m.test(post) && !/needs:/.test(scan), Object.keys(jobs).join());
ok("trust: top-level contents: read; scan holds contents: read only; the only write scope is statuses, on post",
  /^permissions:\n {2}contents: read\n(?! )/m.test(trust) && (trust.match(/^\s*[\w-]+: write\b/gm) || []).map((l) => l.trim()).join() === "statuses: write"
  && /^ {4}permissions:\n {6}contents: read\n(?! {6})/m.test(scan)
  && /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {6}statuses: write\n/m.test(post) && !/write-all/.test(trust), JSON.stringify(jobs));
ok("trust: no secret and no token in the scan job; github.token appears once, in post",
  !/secrets\.|github\.token/.test(scan) && (trust.match(/github\.token/g) || []).length === 1 && /GH_TOKEN: \$\{\{ github\.token \}\}/.test(post), scan);
const usesOf = (job) => job.split("\n").map((l, i, a) => ({ l, i, a })).filter(({ l }) => /^\s*- uses:/.test(l)).map(({ l, i, a }) => ({ l: l.trim(), step: stepAt(a, i) }));
const sUses = usesOf(scan), pUses = usesOf(post);
const pin = (name) => new RegExp(`^- uses: actions/${name}@[0-9a-f]{40} # v\\d+(\\.\\d+)*$`);
ok("trust: every action, commented ones included, pinned to a full commit; checkout to the gates' commit",
  sUses.map(({ l }) => /actions\/([\w-]+)@/.exec(l)[1]).join() === "checkout,checkout,upload-artifact"
  && pUses.map(({ l }) => /actions\/([\w-]+)@/.exec(l)[1]).join() === "checkout,download-artifact"
  && [...sUses, ...pUses].every(({ l }) => ["checkout", "upload-artifact", "download-artifact"].some((n) => pin(n).test(l)))
  && tLines.filter((l) => /\buses:/.test(l)).length === 5
  && [...sUses, ...pUses].filter(({ l }) => /checkout@/.test(l)).every(({ l }) => checkoutShas.has(/@([0-9a-f]{40})/.exec(l)[1])), tLines.filter((l) => /\buses:/.test(l)).join(" | "));
ok("trust: scan checks out the base sha as its workspace and the head only under head/, neither with a persisted token",
  /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/.test(sUses[0].step) && !/\bpath:/.test(sUses[0].step)
  && /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/.test(sUses[1].step) && /\n\s+path: head\n/.test(sUses[1].step)
  && sUses.slice(0, 2).every(({ step }) => /\n\s+persist-credentials: false(\s|$)/.test(step)), sUses.map(({ step }) => step).join("\n---\n"));
ok("trust: post checks out the base only: its one checkout is the base sha, no head ref, no head/ path",
  /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/.test(pUses[0].step) && !/\bpath:/.test(pUses[0].step) && /\n\s+persist-credentials: false(\s|$)/.test(pUses[0].step)
  && !/^\s*ref: [^#]*head\b/m.test(post) && !/\bpath: head\b/.test(post), post);
ok("trust: head.sha appears only as a checkout ref in scan or as HEAD_SHA in env",
  tLines.filter((l) => /^[^#]*head\.(sha|ref)/.test(l)).every((l) => /^\s*(HEAD_SHA: |ref: )\$\{\{ github\.event\.pull_request\.head\.sha \}\}(\s|$)/.test(l)));
ok("trust: scan uploads $RUNNER_TEMP/scan as the proteus-scan artifact; post downloads it there",
  /\n\s+name: proteus-scan\n\s+path: \$\{\{ runner\.temp \}\}\/scan\n/.test(sUses[2].step) && /\n\s+name: proteus-scan\n\s+path: \$\{\{ runner\.temp \}\}\/scan(\n|$)/.test(pUses[1].step),
  sUses[2].step + "\n---\n" + pUses[1].step);
const dedent = (job) => runScripts(job).map((s) => s.text.replace(/^\s*[|>]-?[ \t]*\n/, "").replace(/^ +/gm, "").trim()); // a block's lines, dedented
const sText = dedent(scan), pText = dedent(post);
ok("trust: scan runs install and proteus-scan.js; post runs only the base's proteus-security.js on the artifact; values through env",
  sText.length === 2 && sText[0].startsWith("set -euo pipefail\n")
  && sText[1] === 'node teams/templates/hooks/proteus-scan.js --require --dir head --out "$RUNNER_TEMP/scan" --base "$BASE_SHA" --head "$HEAD_SHA"'
  && pText.length === 1 && pText[0] === 'node teams/templates/hooks/proteus-security.js --ci "$PR_NUMBER" "$HEAD_SHA" --findings "$RUNNER_TEMP/scan"'
  && /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/.test(post) && /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/.test(scan), [...sText, ...pText].join(" | "));
ok("trust: no script enters or runs anything under head/; the scan reads it with --dir head",
  [...sText, ...pText].map((t) => t.replace(/--dir head /, "").replace(/--head "\$HEAD_SHA"|\$HEAD_SHA/g, "")).every((t) => !/\bhead\b/.test(t)) && /--dir head /.test(sText[1]), sText.join(" | "));
ok("trust: every scanner pinned: no package-manager install, every image by digest, every download checked against a sha256",
  !/\b(pipx|pip|npm|uv|brew) install\b/.test(sText[0]) && (sText[0].match(/semgrep\/semgrep@sha256:[0-9a-f]{64}\b/g) || []).length === 2 && !/semgrep\/semgrep(:|\s)/.test(sText[0])
  && (sText[0].match(/\bcurl /g) || []).length === 3 && (sText[0].match(/ {2}[\w.-]+" \| sha256sum -c -$/gm) || []).length === 3
  && (sText[0].match(/echo "[0-9a-f]{64} {2}/g) || []).length === 3 && !/curl [^\n]*\|/.test(sText[0]), sText[0]);
ok("trust: the header no longer claims step order isolates the scanners from the token",
  !/before any step holds the token/.test(trust) && /two VMs/.test(trust));
ok("gates template: no longer calls MERGE a review comment, and names the statuses the ruleset requires",
  !/MERGE is a review comment/.test(read(...FILES.template)) && /proteus\/verdict/.test(read(...FILES.template)) && /proteus-trust\.yml/.test(read(...FILES.template)));

ok("ci and template pin checkout to the same commit", checkoutShas.size === 1 && !checkoutShas.has(undefined), [...checkoutShas].join(","));

// ci.yml's triggers: worker branches are proteus-work/..., so the old hive/** filter is gone; main and runs stay
const ci = read(...FILES.ci);
ok("ci: push and pull_request run on main and proteus/**, no hive/** filter",
  /\n {2}push:\n {4}branches: \[main, "proteus\/\*\*"\]\n {2}pull_request:\n {4}branches: \[main, "proteus\/\*\*"\]\n/.test(ci) && !/hive/.test(ci));
ok("ci: the gates job reads the matrix result through env",
  /\n {2}gates:\n[\s\S]*RESULT: \$\{\{ needs\.test\.result \}\}[\s\S]*run: test "\$RESULT" = success/.test(ci));

// the vendored anti-slop plugin records its source, commit and licence, and carries that licence
const up = read("tools", "oxlint", "anti-slop", "UPSTREAM.md");
const lic = read("tools", "oxlint", "anti-slop", "LICENSE");
ok("anti-slop: UPSTREAM.md names the source repo, a full commit and the MIT licence; LICENSE sits beside it",
  /github\.com\/dmmulroy\/anti-slop/.test(up) && /`[0-9a-f]{40}`/.test(up) && /\bMIT\b/.test(up) && /^MIT License\n\nCopyright \(c\) \d{4} Dillon Mulroy\n/.test(lic));

summary();
