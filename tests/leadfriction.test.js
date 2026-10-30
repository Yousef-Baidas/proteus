// Lead guard friction tests: node tests/leadfriction.test.js (needs git). #271: a command the verdict guard cannot
// judge is refused for that reason, never as a verdict post; the lead writes in its own scratch dir and nowhere
// else under .git.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("leadfriction");
const LG = path.join(SRC, "proteus-lead-guard.js");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

const hook = (tool, ti, extra = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: tool, tool_input: ti, ...extra }, { cwd: REPO });
const VERDICT = /ACCEPT, CHANGES and ANSWER are the human's words/;
const sub = { agent_id: "a1", agent_type: "proteus-worker" };

// fix 1: the run's opening command, trimmed: proteus-gh.js through a variable, heredoc bodies, an ACCEPTANCE block
{
  const H = path.join(SRC).replace(/\\/g, "/");
  const cmd = `H=${H}; G="node $H/proteus-gh.js"; S=$(node $H/proteus-scratch.js --path wordstat); R=wordstat
cat > $S/t-a.md <<'EOF'
Check: test/cli.test.js::lines.
EOF
A=$($G issue create --title "lines: add --lines" --label proteus --milestone "$R/flags" --body-file $S/t-a.md | tail -1); echo $A
$G issue comment 1 --body "spec APPROVED by the human.
ACCEPTANCE $R/flags
1. node src/cli.js --lines prints 2." | tail -1`;
  const lead = hook("Bash", { command: cmd }), agent = hook("Bash", { command: cmd }, sub);
  ok("verdict guard: a gh call through a variable is not refused as a verdict post (#271)", !VERDICT.test(lead.err) && !VERDICT.test(agent.err), lead.err + agent.err);
  ok("verdict guard: it is refused for the real reason, naming the variable and the fix", lead.code === 2 && /\$G runs a program through a variable/.test(lead.err) && /Name gh or proteus-gh\.js literally/.test(lead.err), lead.err);
  const plain = cmd.replace(/\$G /g, `node ${H}/proteus-gh.js `).replace(/^H=.*?R=wordstat\n/, "R=wordstat\n").replace(/\$S\//g, "/tmp/");
  const r = hook("Bash", { command: plain });
  ok("verdict guard: the same command naming proteus-gh.js literally passes", !VERDICT.test(r.err) && !/cannot read what the command posts/.test(r.err), r.err);
  const why = (c) => hook("Bash", { command: c }).err;
  ok("verdict guard: eval, xargs, a $( ) program and inline code each name their own reason",
    /eval runs text as a command/.test(why("eval 'gh issue comment 1 --body ACCEPT'")) && /xargs builds the gh call/.test(why("echo 1 | xargs gh issue comment --body-file -")) &&
    /a \$\( \) or backtick runs as a program/.test(why("$(which gh) issue comment 1 --body ACCEPT")) && /inline node code calls gh/.test(why("node -e \"require('child_process').execSync('gh issue comment 1 --body ACCEPT')\"")));
  ok("verdict guard: a literal ACCEPT post is still refused as one", VERDICT.test(why("gh issue comment 1 --body ACCEPT")));
}

// fix 2: the lead writes under <git-common-dir>/proteus/scratch/<key>/ and nowhere else under .git
{
  const SCR = path.join(REPO, ".git", "proteus", "scratch", "wordstat");
  fs.mkdirSync(SCR, { recursive: true });
  const OUT = path.join(W, "outside"); fs.mkdirSync(OUT);
  const write = (f) => hook("Write", { file_path: f, content: "x" });
  const edit = (f) => hook("Edit", { file_path: f, old_string: "a", new_string: "b" });
  ok("lead scratch: Write and Edit pass inside the run's scratch dir, a new subdir too", write(path.join(SCR, "t-a.md")).code === 0 && edit(path.join(SCR, "t-a.md")).code === 0 && write(path.join(SCR, "new", "b.md")).code === 0);
  const refused = (f) => { const r = write(f); return r.code === 2 && /the lead does not edit/.test(r.err); };
  ok("lead scratch: a sibling under .git/proteus is refused", refused(path.join(REPO, ".git", "proteus", "agents", "x")) && refused(path.join(REPO, ".git", "proteus", "x.md")));
  ok("lead scratch: a file directly in scratch/, outside any key, is refused", refused(path.join(REPO, ".git", "proteus", "scratch", "x.md")));
  ok("lead scratch: a .. escape out of the scratch dir is refused", refused(`${SCR}${path.sep}..${path.sep}..${path.sep}agents${path.sep}x`) && refused(path.join(SCR, "..", "..", "..", "config")));
  let linked = false;
  try { fs.symlinkSync(OUT, path.join(SCR, "out"), "junction"); fs.symlinkSync(path.join(REPO, "a.txt"), path.join(SCR, "a-link")); fs.symlinkSync(path.join(OUT, "gone"), path.join(SCR, "dangling")); linked = true; } catch {}
  if (linked) {
    ok("lead scratch: a symlink out of the scratch dir is refused: a linked dir, a linked file, a dangling link", refused(path.join(SCR, "out", "x.md")) && refused(path.join(SCR, "a-link")) && refused(path.join(SCR, "dangling")));
  } else ok("lead scratch: the symlink case skipped (no symlink here)", true);
  ok("lead scratch: a worker's own scratch rule is unchanged", hook("Write", { file_path: path.join(SCR, "w.md"), content: "x" }, sub).code === 0);
}

// fix 3: the guard refuses exactly what proteus-verdict.js counts, one shared definition (lib.isVerdict)
{
  const hl = require(path.join(SRC, "proteus-lib.js"));
  const said = (body, who) => VERDICT.test(hook("Bash", { command: `gh issue comment 7 --body-file - <<'EOF'\n${body}\nEOF` }, who).err);
  const prose = ["Changes since the last push: the parser takes --top.", "Accept criteria: all eight checks pass.", "ACCEPTED", "CHANGES: none", "DONE #12\nACCEPT criteria met"];
  const counted = ["ACCEPT", "ANSWER", "ACCEPT criteria met", "CHANGES\n- too dark", "CHANGES revision", "  CHANGES revision\n- faster", "ANSWER 2", "\n\nACCEPT"];
  ok("verdict line: the definitions agree: what the reader counts is refused, what it does not passes", ![...prose, ...counted].some((b) => hl.isVerdict(b) !== counted.includes(b)));
  const shut = prose.filter((b) => said(b) || said(b, sub)), open = counted.filter((b) => !said(b) || !said(b, sub));
  ok("verdict line: prose that the verdict reader does not count passes, lead and subagent (#271)", !shut.length, shut.join("\n---\n"));
  ok("verdict line: each form the verdict reader counts is refused, lead and subagent", !open.length, open.join("\n---\n"));
  // drift: the reader and the guard read the same export, so redefining it moves both
  const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
  ok("verdict line: proteus-verdict.js and the guard both use lib.isVerdict, no copy of the regex",
    /lib\.isVerdict\(/.test(src("proteus-verdict.js")) && !/\(ACCEPT\|CHANGES\|ANSWER\)/.test(src("proteus-verdict.js")) && /isVerdict\(t\)/.test(src("proteus-lib.js")));
}

lib.summary();
