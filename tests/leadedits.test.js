// lead-edits tests: node tests/leadedits.test.js (needs git). A `lead-edits:` line in AGENTS.md (#113) lets the
// lead edit the repo files its globs match, on Claude Code and Codex, in guest mode too, but never Proteus's own
// hooks, gates, CI or CLI settings, whatever the line says and however the path is spelled or linked.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("leadedits");
const LG = path.join(SRC, "proteus-lead-guard.js");
const hl = require(path.join(SRC, "proteus-lib.js"));

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const agents = (line, dir = REPO) => fs.writeFileSync(path.join(dir, "AGENTS.md"), `# Agents\n\n## Learned\n${line ? line + "\r\n" : ""}labels: created\n`);

const at = (f) => path.join(REPO, ...f.split("/"));
const write = (file) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Write", tool_input: { file_path: file, content: "x" } }, { cwd: REPO });
const pass = (f) => write(at(f)).code === 0;
const refused = (f, re) => { const r = write(at(f)); return r.code === 2 && (!re || re.test(r.err)); };
const fails = (fn, list) => list.filter((f) => !fn(f));

agents("");
ok("no lead-edits line: .editorconfig is refused as before", refused(".editorconfig", /the lead does not edit \.editorconfig\. Decide the fix/));
// SKILL.md rule 1 leaves the detail to this message: what the lead may write, and how a fix goes out instead
ok("lead edit refusal: names the ticket route and the lead's own files", refused("src/a.js", /ticket or a numbered BACK-TO-WORKER[\s\S]*CONTEXT\.md, CONVENTIONS\.md[\s\S]*AGENTS\.md, docs\/adr\/[\s\S]*docs\/lessons\/[\s\S]*`lead-edits:` line/));

agents("lead-edits: .vscode/* .editorconfig .gitattributes .gitignore .github/**");
ok("lead-edits: the listed files pass, and what is below a folder a glob matches (#96)", !fails(pass, [".editorconfig", ".gitattributes", ".gitignore", ".vscode/settings.json", ".vscode/sub/x.json", ".github/CODEOWNERS"]).length);
ok("lead-edits: the lead's own docs still pass", !fails(pass, ["AGENTS.md", "CONTEXT.md", "docs/adr/0001-x.md"]).length);
ok("lead-edits: anything the globs do not match is still refused", !fails((f) => refused(f, /the lead does not edit/), ["src/a.js", ".vscodex/x.json", "editorconfig", "a.txt"]).length);
ok("lead-edits: .github/** never reaches the workflows or actions",
  !fails((f) => refused(f, /holds Proteus's hooks, gates or CLI settings/), [".github/workflows/proteus-gates.yml", ".github/actions/x/action.yml"]).length);

// the never list against a line that asks for everything
agents("lead-edits: ** .claude/** .codex/* teams/** lefthook.yml");
const never = [".claude/settings.json", ".claude/hooks/proteus-lead-guard.js", ".claude/proteus-owned", ".codex/hooks.json", ".codex/config.toml", ".agents/skills/x/SKILL.md",
  ".git/hooks/commit-msg", ".git/config", ".git/proteus/guest.json", "teams/templates/hooks/commit-msg.js", "teams/ROUTING.md", "teams/skills-lock.json",
  "lefthook.yml", ".lefthook.yml", "lefthook-local.yml", "lefthook.toml", ".lefthook/pre-commit/x.sh", ".config/lefthook.yml",
  ".github/workflows/proteus-gates.yml", ".github/workflows/other.yml", ".github/actions/setup/action.yml"];
ok("never: Proteus's hooks, gates, CI and CLI settings are refused even under ** and their own globs",
  !fails((f) => refused(f, /holds Proteus's hooks, gates or CLI settings; no lead-edits line covers it/), never).length, fails((f) => refused(f), never).join(", "));
const tricks = [".CLAUDE/settings.json", ".Claude/hooks/x.js", ".claude./settings.json", ".claude /settings.json", "CLAUDE~1/settings.json", ".codex::$INDEX_ALLOCATION/hooks.json",
  "Teams/templates/hooks/commit-msg.js", "LeftHook.YML", ".GitHub/Workflows/x.yml", ".GIT/hooks/pre-commit", ".github/workflows./x.yml"];
ok("never: case, trailing dots and spaces, :streams and 8.3 aliases do not get around it on any OS", !fails((f) => refused(f, /holds Proteus's hooks/), tricks).length, fails((f) => refused(f, /holds/), tricks).join(", "));
ok("never: a .. through an allowed dir lands on the never list and is refused",
  refused(["src", "..", ".claude", "settings.json"].join("/"), /\.claude\/settings\.json holds/) && write([REPO, "docs", "..", ".codex", "hooks.json"].join(path.sep)).code === 2);
ok("never: ordinary files under ** pass (.gitignore, .github/dependabot.yml, src/a.js, a file named like a dir on the list)",
  !fails(pass, [".gitignore", ".github/dependabot.yml", "src/a.js", "claude/x", "my.claude/x", ".githooks-notes.md", "teams.md"]).length);

// links: a link is not written through, and a path whose real location is off limits is refused
const link = (target, at, dir) => { try { fs.symlinkSync(target, path.join(REPO, at), dir ? "junction" : "file"); return true; } catch { return false; } };
fs.mkdirSync(path.join(REPO, ".claude"), { recursive: true });
fs.mkdirSync(path.join(W, "outside"), { recursive: true });
if (!link(path.join(REPO, ".claude"), "cfg", true) || !link(path.join(W, "outside"), "out", true) || !link(path.join(W, "nowhere", "deeper"), "dangling", true))
  console.log("skip: link cases (this OS or account cannot make links)");
else {
  ok("links: a dir link into .claude is refused by its real path", refused("cfg/settings.json", /cfg\/settings\.json resolves to \.claude\/settings\.json/));
  ok("links: a dir link out of the repo is refused", refused("out/x.txt", /out\/x\.txt resolves outside the repo/) && refused("out/new/deep.txt", /resolves outside the repo/));
  ok("links: a dangling dir link is refused", refused("dangling/x.txt", /link/));
  ok("links: the link itself is not written through", refused("cfg", /cfg is a link; the lead does not write through one/));
  if (link(path.join(REPO, "a.txt"), ".editorconfig")) ok("links: a file link, even to an allowed file, is not written through", refused(".editorconfig", /is a link/));
  for (const f of ["cfg", "out", "dangling", ".editorconfig"]) try { fs.unlinkSync(path.join(REPO, f)); } catch { try { fs.rmdirSync(path.join(REPO, f)); } catch {} }
}

// lib: the line reader models: shares, CRLF and absence
agents("lead-edits:  .vscode/*\t.editorconfig ");
ok("lib.leadEdits: whitespace-separated globs, CR stripped", JSON.stringify(hl.leadEdits(REPO)) === JSON.stringify([".vscode/*", ".editorconfig"]), JSON.stringify(hl.leadEdits(REPO)));
agents("models: floor=haiku");
ok("lib.agentsLine: models: still read through it; no lead-edits line is []", hl.modelPolicy(REPO).floor === "haiku" && hl.agentsLine(REPO, "lead-edits") === null && hl.leadEdits(REPO).length === 0);

// Codex: the same guard on apply_patch
agents("lead-edits: .vscode/* .editorconfig .codex/** .claude/**");
const patch = (...lines) => ({ command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") });
const codex = (ti) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "c1", cwd: REPO, model: "gpt-6-sol", tool_name: "apply_patch", tool_input: ti, tool_use_id: "u1" }, { cwd: REPO, env: { PROTEUS_HARNESS: "codex" } });
ok("codex: a patch of lead-edits files passes", codex(patch("*** Update File: .editorconfig\n@@\n-a\n+b", "*** Add File: .vscode/settings.json\n+{}")).code === 0);
let r = codex(patch("*** Update File: .editorconfig\n@@\n-a\n+b", "*** Update File: .codex/hooks.json\n@@\n-a\n+b"));
ok("codex: a patch that also touches .codex/ is refused, though the line lists .codex/**", r.code === 2 && /lead-edits: \.codex\/hooks\.json holds Proteus's hooks/.test(r.err) && /PROTEUS=0 codex/.test(r.err), r.err);
r = codex(patch("*** Update File: .editorconfig", "*** Move to: .claude/settings.json\n@@\n-a\n+b"));
ok("codex: moving a lead-edits file onto the never list is refused", r.code === 2 && /lead-edits: \.claude\/settings\.json holds/.test(r.err), r.err);

// guest mode: the line lives in the guest dir's AGENTS.md; its globs name the repo's own files
const GD = path.join(W, "guest");
fs.mkdirSync(GD, { recursive: true });
fs.mkdirSync(path.join(REPO, ".git", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".git", "proteus", "guest.json"), JSON.stringify({ dir: GD }));
fs.rmSync(path.join(REPO, "AGENTS.md"));
agents("lead-edits: .editorconfig .vscode/* AGENTS.md .claude/**", GD);
ok("guest: the repo's own .editorconfig and .vscode/ pass", pass(".editorconfig") && pass(".vscode/settings.json"));
r = write(path.join(GD, ".editorconfig"));
ok("guest: a guest-dir copy of a lead-edits file is not the lead's", r.code === 2 && /in the guest dir/.test(r.err), r.err);
ok("guest: the lead's docs still go to the guest dir; a lead-edits glob naming the repo's AGENTS.md is the human's call",
  write(path.join(GD, "AGENTS.md")).code === 0 && refused("CONTEXT.md", /guest mode/) && pass("AGENTS.md"));
ok("guest: the never list holds", refused(".claude/settings.json", /holds Proteus's hooks/));

lib.summary();
