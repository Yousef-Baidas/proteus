// Workflow hardening tests: node tests/workflows.test.js. Both .github/workflows/ci.yml and the shipped
// templates/ci/proteus-gates.yml keep ${{ }} out of run: scripts (a fork names its own head branch), hold a read-only
// token that checkout does not persist, pin every action to a commit SHA, and install without lifecycle scripts.
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
