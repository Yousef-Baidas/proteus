#!/usr/bin/env node
// PreToolUse hook for the lead's session (main checkout); tools are the agents' (edit, read, shell,
// monitor, spawn), mapped from the CLI's by the harness adapter.
// Main thread:
// 1. The lead writes no code: Edit/Write inside the repo is refused except the docs it owns.
// 2. The model ladder (proteus-lib modelCaps): every Agent call names its model; one above the
//    lead's, a solo model (Fable by default: the lead is its one instance), or one under the
//    floor (Haiku by default) is refused.
// 3. Context at PROTEUS_HANDOFF_HARD (default 180000) or above: no new Agent spawns. While a linked
//    skill has drifted from teams/skills-lock.json (lib.lockDrift), no proteus worker or verifier
//    spawn either; helpers (scout, guide, anything not proteus-*-worker/verifier) pass.
// 4. `--edit-last` is refused: every agent posts as the same GitHub account. So is a comment that opens with
//    ACCEPT, CHANGES or ANSWER, the human's words (lib.verdictPost).
// 5. No `gh pr merge --admin`, no push to main or to an existing run branch (creating proteus/<run> passes), no
//    deleting either, no lifting or rewriting branch protection or a ruleset (lib.branchDenial).
// 6. The lead does not Read images (renders cost ~1.5k tokens each) unless the human's
//    latest prompt names the file.
// Subagents (ev.agent set; they run in the lead's process, so a worktree's own hooks may never load):
//   no background Bash, no Monitor, no --edit-last, no ACCEPT / CHANGES / ANSWER comment, nothing rule 5 refuses. An edit inside a checkout with .claude/proteus-owned
//   must be an owned path (same rule as proteus-owned-paths.js); an edit in this repo's main checkout
//   while a run branch exists (proteus/* or a pre-rename run's, lib.runOpen) is refused (except the
//   scout's teams/*/skills.txt). All else passes.
// Linked worktrees and PROTEUS=0 sessions pass untouched.
// Exit 2 = block; the message on stderr reaches the model as the tool's error.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

// docs the lead may write: the repo docs, ADRs, lessons, nothing else
const LEAD_MAY_WRITE = [/^CONTEXT\.md$/, /^CONVENTIONS\.md$/, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^docs\/adr\/[^/]+\.md$/, /^docs\/lessons\/[^/]+\.md$/];
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?|exr|hdr)$/i;
// the agents that run team skills: proteus-worker, proteus-verifier, proteus-<team>-worker/verifier
const PIPELINE = /^proteus-(?:[a-z0-9-]+-)?(?:worker|verifier)$/;

if (process.env.PROTEUS === "0") process.exit(0);

lib.run((ev, ad) => {
  const BYPASS = ` ${ad.bypass} opens a session without this guard.`;
  if (ev.agent) {
    const why = lib.workerDenial(ev) || (ev.tool === "edit" && subagentEdit(ev));
    if (why) ad.deny(why);
    return;
  }
  // the lead's own shell stays cheap: regexes, a file read only for a gh comment naming a body file, git calls only for a push
  if (ev.tool === "shell") {
    if (/--edit-last\b/.test(ev.command)) ad.deny(lib.EDIT_LAST_MSG);
    const why = lib.verdictPost(ev.command, ev.cwd) || lib.branchDenial(ev.command, ev.cwd);
    if (why) ad.deny(why);
    return;
  }
  if (ev.tool === "monitor") return;

  const root = lib.projectRoot(ev);
  if (lib.isLinked(root)) return;

  if (ev.tool === "spawn") {
    const why = modelDenial(lib.modelCaps(ev, root), ev.spawnModel);
    if (why) ad.deny(why + BYPASS);
    const ctx = ad.contextTokens(ev);
    if (ctx >= lib.envInt("PROTEUS_HANDOFF_HARD", 180000)) ad.deny(`context at ${Math.round(ctx / 1000)}k: /handoff before dispatching more.`);
    if (PIPELINE.test(ev.spawnType)) {
      const drift = lib.lockDrift(root);
      if (drift.length) ad.deny(`no ${ev.spawnType} spawn while team skills differ from their pins. ${lib.relockHint(drift)}` + BYPASS);
    }
    return;
  }

  const target = ev.path;
  if (!target) return;
  if (ev.tool === "read") {
    if (IMAGE.test(target) && !humanNamed(ev, ad, target))
      ad.deny(`proteus: the lead does not open images (each costs ~1.5k tokens of lead context). Spawn a subagent on the ladder's mid model: "Read ${target}; answer in 5 lines: <what to check>", or post the path on the review issue for the human. ${ad.bypass} skips this guard.`, { json: true });
    return; // lib.run exits 0 once stdout drains
  }
  if (ev.tool !== "edit") return;
  const rel = ev.paths.map((p) => lib.relPath(root, p)).find((r) => r && !LEAD_MAY_WRITE.some((re) => re.test(r)));
  if (!rel) return; // outside the repo (temp issue bodies, memory) or a doc the lead keeps
  ad.deny(`the lead does not edit ${rel}. Decide the fix, then dispatch it to a proteus-<profile>-worker (model per the ladder).` + BYPASS);
});

// the ladder: every spawn names its model, never above the lead's rung, never a solo model, never under the floor
function modelDenial(c, name) {
  if (!c.ladder.length) return ""; // no ladder and no known lead model
  const use = `use "${c.top}" for hard tickets and every verdict, "${c.mid}" for standard tickets and helpers`;
  if (!name) return `every Agent call names its model (the agent's default may sit above the lead's): ${use}.`;
  const r = lib.rungOf(c.ladder, name);
  if (r < 0) return `model "${name}" is not on the ladder (${c.ladder.join(" < ")}); ${use}.`;
  if (c.solo.includes(c.ladder[r])) return `${c.ladder[r]} runs once per project${c.leadRung === r ? " and the lead is it" : ""}; ${use}. The human lifts this with a \`models: solo=none\` line in AGENTS.md.`;
  if (r > c.cap) return `model "${name}" is above the lead (${c.lead || "unknown"}); nothing above ${c.top}: ${use}.`;
  if (r < c.floor) return `model "${name}" is under the floor (${c.floorName}); it does not produce or review work: ${use}.`;
  return "";
}

// the escape hatch: the human's latest prompt names the file; any doubt denies
function humanNamed(ev, ad, target) {
  try {
    const prompt = ad.lastHumanPrompt(ev);
    return !!prompt && prompt.includes(path.basename(String(target).replace(/\\/g, "/")));
  } catch { return false; }
}

// a subagent's edit: owned paths in any checkout that lists them; the main checkout is off limits during a run
function subagentEdit(ev) {
  for (const target of ev.paths) {
    const why = subagentPath(ev, target);
    if (why) return why;
  }
  return "";
}

function subagentPath(ev, target) {
  const cwd = path.resolve(ev.cwd || lib.projectRoot(ev));
  const abs = path.resolve(cwd, String(target));
  const wt = lib.gitRoot(path.dirname(abs));
  if (!wt) return "";
  if (fs.existsSync(lib.ownedFile(wt))) return lib.ownedDenial(wt, abs);
  if (lib.isLinked(wt)) return "";
  const common = lib.gitCommonDir(wt);
  if (!common || common !== lib.gitCommonDir(path.resolve(lib.projectRoot(ev))) || !lib.runOpen(common)) return "";
  const rel = lib.relPath(wt, abs);
  if (ev.agentType === "proteus-scout" && /^teams\/[^/]+\/skills\.txt$/.test(rel)) return "";
  const own = lib.gitRoot(cwd);
  const hint = own && own !== wt && lib.isLinked(own) && lib.gitCommonDir(own) === common
    ? `yours is ${own}: edit ${path.join(own, rel)}`
    : "none found from your cwd; comment NEEDS on the issue and stop";
  return `workers edit only inside their worktree (${hint}). ${rel} is in the main checkout while a run is open.`;
}
