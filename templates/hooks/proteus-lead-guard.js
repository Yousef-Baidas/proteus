#!/usr/bin/env node
// PreToolUse hook for the lead's session (main checkout); tools are the agents' (edit, read, shell,
// monitor, spawn), mapped from the CLI's by the harness adapter.
// Main thread:
// 1. The lead writes no code: Edit/Write inside the repo is refused except the docs it owns and the tickets'
//    owned-path records (.proteus/owned/<id>).
// 2. The model ladder (proteus-lib modelCaps): every Agent call names its model; one above the
//    lead's, a solo model (Fable by default: the lead is its one instance), or one under the
//    floor (Sonnet by default, so Haiku) is refused.
// 3. Context at PROTEUS_HANDOFF_HARD (default 90% of the lead's window, lib.handoffLines: 180000
//    on 200k) or above: no new Agent spawns. While a linked skill has drifted from
//    teams/skills-lock.json (lib.lockDrift), no proteus worker or verifier spawn either; helpers (scout, guide, anything not proteus-*-worker/verifier) pass.
// 4. `--edit-last` is refused: every agent posts as the same GitHub account. So is a comment that opens with
//    ACCEPT, CHANGES or ANSWER, the human's words (lib.verdictPost).
// 5. No `gh pr merge --admin`, no push to main or to an existing run branch (creating proteus/<run> passes), no
//    deleting either, no lifting or rewriting branch protection or a ruleset, no commit status or check run
//    posted by hand (lib.branchDenial), and no proteus-signoff.js: the verdict status is a verifier's.
// 6. The lead does not Read images (renders cost ~1.5k tokens each) unless the human's
//    latest prompt names the file.
// Subagents (ev.agent set; they run in the lead's process, so a worktree's own hooks may never load):
//   no background Bash, no Monitor, no --edit-last, no ACCEPT / CHANGES / ANSWER comment, nothing rule 5 refuses, proteus-signoff.js only from a verifier (lib.signoffDenial), nothing lib.agentShellDenial refuses
//   (force-push, set up or through the API too, git -C outside its own worktree, shell writes to .claude/, .codex/, .git/ or the gates,
//   through xargs, find -exec, git checkout/restore/apply/am/stash, patch, rm -r/mv/rsync of a parent). An edit inside a checkout with .claude/proteus-owned
//   must be an owned path (same rule as proteus-owned-paths.js) in the agent's own worktree (bindingDenial:
//   its cwd's, else the one its brief names, else the one its first edit bound it to, until it commits there); an edit in this repo's main checkout
//   while a run branch exists (proteus/* or a pre-rename run's, lib.runOpen) is refused (except the
//   scout's teams/*/skills.txt, and scratch under <git-common-dir>/proteus/scratch/, lib.inScratch). All else passes. Each call stamps the agent's beat (lib.beat) for the watchdog.
//   A shell call let through gets the fingerprint proteus-shell-check.js compares after it (PostToolUse).
//   The lead's own shell call let through opens a window in lead-flight.json (proteus-shell-check.js leadStart).
// Guest mode (lib.guestDir): the lead's docs and teams/ live in the guest dir outside the repo. Rule 1 applies
//   there, and the repo's own copies of those docs are refused; a subagent edit in the guest dir counts as one in the main checkout.
// lead-edits (lib.leadEdits): repo files matching the globs on AGENTS.md's `lead-edits:` line pass rule 1, guest mode
//   included, except what lib.leadEditDenial always refuses (.claude, .codex, gates, CI, links, outside the repo).
// Linked worktrees and PROTEUS=0 sessions pass untouched.
// Exit 2 = block; the message on stderr reaches the model as the tool's error.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const { bindFile, bound, cwdWorktree, samePath: same } = lib;

// docs the lead may write: CONTEXT.md, AGENTS.md, ADRs, lessons, and CONVENTIONS.md (bootstrap writes it; after
// that it is the human's, and the lead adds a line only on the human's approval, which a hook cannot see).
// CLAUDE.md is not listed: it is the human's, and a docs-diet ticket edits it through a worker.
// .proteus/owned/<id> is a ticket's owned paths as the lead records them on the run branch, which CI checks the
// worker's PR against (proteus-owned-check.js --ci).
const LEAD_MAY_WRITE = [/^CONTEXT\.md$/, /^CONVENTIONS\.md$/, /^AGENTS\.md$/, /^docs\/adr\/[^/]+\.md$/, /^docs\/lessons\/[^/]+\.md$/, /^\.proteus\/owned\/[A-Za-z0-9][\w.-]*$/];
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?|exr|hdr)$/i;
// the agents that run team skills: proteus-worker, proteus-verifier, proteus-<team>-worker/verifier
const PIPELINE = /^proteus-(?:[a-z0-9-]+-)?(?:worker|verifier)$/;

if (process.env.PROTEUS === "0") process.exit(0);

lib.run((ev, ad) => {
  const BYPASS = ` ${ad.bypass} opens a session without this guard.`;
  if (ev.agent) {
    lib.beat(ev, "tool"); // liveness for proteus-watchdog.js, refused calls included
    const why = lib.workerDenial(ev) || (ev.tool === "edit" && subagentEdit(ev, ad));
    if (why) ad.deny(why);
    // what the shell call is let through to do is checked after it ran (proteus-shell-check.js, PostToolUse)
    if (ev.tool === "shell") return shellCheck("snapshot", ev);
    return;
  }
  // the lead's own shell stays cheap: regexes, a file read only for a gh comment naming a body file, git calls only for a push
  if (ev.tool === "shell") {
    if (lib.editsLast(ev.command)) ad.deny(lib.EDIT_LAST_MSG);
    if (/proteus-signoff\.js/.test(ev.command) && lib.signsOff(ev.command)) ad.deny(lib.SIGNOFF_MSG.lead);
    const why = lib.verdictPost(ev.command, ev.cwd) || lib.branchDenial(ev.command, ev.cwd);
    if (why) ad.deny(why);
    return shellCheck("leadStart", ev);
  }
  if (ev.tool === "monitor") return;

  const root = lib.projectRoot(ev);
  if (lib.isLinked(root)) return;

  if (ev.tool === "spawn") {
    const why = modelDenial(lib.modelCaps(ev, root), ev.spawnModel);
    if (why) ad.deny(why + BYPASS);
    const ctx = ad.contextTokens(ev);
    if (ctx && ctx >= lib.handoffLines(ev, root).hard) ad.deny(`context at ${Math.round(ctx / 1000)}k: /handoff before dispatching more. Finish the step, log the position on the run log, /handoff, and let a fresh lead dispatch; workers in flight keep running.`);
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
      ad.deny(`proteus: the lead does not open images (each costs ~1.5k tokens of lead context). Spawn a subagent on the helper model (helper: in models=): "Read ${target}; answer in 5 lines: <what to check>", or post the path on the review issue for the human. ${ad.bypass} skips this guard.`, { json: true });
    return; // lib.run exits 0 once stdout drains
  }
  if (ev.tool !== "edit") return;
  const guest = lib.guestDir(root), extra = lib.leadEdits(root);
  for (const p of ev.paths) {
    const rel = lib.relPath(root, p), mine = (r) => LEAD_MAY_WRITE.some((re) => re.test(r));
    // the human's lead-edits globs (AGENTS.md) name repo files, in guest mode too; never the guards (lib.leadEditDenial)
    if (rel && extra.some((g) => lib.ownedMatch(g, rel))) {
      const why = lib.leadEditDenial(root, p, rel);
      if (why) ad.deny(`lead-edits: ${why} Dispatch the change to a worker, or the human makes it.` + BYPASS);
      continue;
    }
    // guest mode: the docs the lead keeps live in the guest dir, and the repo's own copies are not Proteus's to touch
    if (rel && guest && mine(rel)) ad.deny(`guest mode: this repo keeps no Proteus files; ${rel} lives at ${slash(path.join(guest, rel))}. Edit it there.` + BYPASS);
    if (rel && !mine(rel)) ad.deny(`the lead does not edit ${rel}. Decide the fix, then dispatch it to a proteus-<profile>-worker (model per the ladder) as a ticket or a numbered BACK-TO-WORKER. The lead writes only CONTEXT.md, CONVENTIONS.md (bootstrap and human-approved standing rules), AGENTS.md, docs/adr/*.md, docs/lessons/*.md, the owned-path records .proteus/owned/<id>, and files matching the human's \`lead-edits:\` line in AGENTS.md.` + BYPASS);
    const grel = !rel && guest ? lib.relPath(guest, p) : null;
    if (grel && !mine(grel)) ad.deny(`the lead does not edit ${grel} in the guest dir ${slash(guest)}. Team files are the scout's; anything else goes to a worker.` + BYPASS);
  } // else outside the repo (temp issue bodies, memory) or a doc the lead keeps
});

// the ladder: every spawn names its model, never above the lead's rung, never a solo model, never under the floor
function modelDenial(c, name) {
  if (!c.ladder.length) return ""; // no ladder and no known lead model
  const t = (x) => `"${x.model}"${x.effort ? ` with ${c.effortParam} "${x.effort}"` : ""}`;
  const use = `use ${t(c.tiers.judge)} for verdicts, contracts, escalations, conflicts and the scout, ${t(c.tiers.build)} for tickets, ${t(c.tiers.helper)} for wave QA, the guide and helpers`;
  if (!name) return `every Agent call names its model (the agent's default may sit above the lead's): ${use}.`;
  const r = lib.rungOf(c.ladder, name, c.aliases);
  if (r < 0) return `model "${name}" is not on the ladder (${c.ladder.join(" < ")}); ${use}.`;
  if (c.solo.includes(c.ladder[r])) return `${c.ladder[r]} runs once per project${c.leadRung === r ? " and the lead is it" : ""}; ${use}. The human lifts this with a \`models: solo=none\` line in AGENTS.md.`;
  if (r > c.cap) return `model "${name}" is above the lead (${c.lead || "unknown"}); nothing above ${c.top}: ${use}.`;
  if (r < c.floor) return `model "${name}" is under the floor (${c.floorName}); it does not produce or review work: ${use}.`;
  return "";
}

// the escape hatch: the human's latest prompt names the file as a whole token; any doubt denies
function humanNamed(ev, ad, target) {
  try {
    const prompt = ad.lastHumanPrompt(ev);
    if (!prompt) return false;
    const base = path.basename(String(target).replace(/\\/g, "/")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // a whole token: not inside a longer name (data.png) or extension (a.png.bak); a sentence's full stop is fine
    return new RegExp(`(?<![\\w.-])${base}(?![\\w-]|\\.\\w)`).test(prompt);
  } catch { return false; }
}

// a subagent's edit: owned paths in any checkout that lists them; the main checkout is off limits during a run
// proteus-shell-check.js before a call it lets through: a subagent's fingerprint (snapshot), the lead's window
// (leadStart); a hook copy without it (an old install) skips it
async function shellCheck(fn, ev) {
  let check;
  try { check = require(path.join(__dirname, "proteus-shell-check.js")); } catch { return; }
  try { if (typeof check[fn] === "function") await check[fn](ev); } catch (e) { if (process.env.PROTEUS_DEBUG) process.stderr.write(`proteus shell-check: ${e.stack}\n`); }
}

function subagentEdit(ev, ad) {
  let brief = null; // read once per call, and only when an edit lands in a git checkout
  const briefOf = () => (brief ??= (() => { try { return String(ad.briefText(ev) || ""); } catch { return ""; } })());
  for (const target of ev.paths) {
    const why = subagentPath(ev, target, briefOf);
    if (why) return why;
  }
  return "";
}

function subagentPath(ev, target, briefOf) {
  const cwd = path.resolve(ev.cwd || lib.projectRoot(ev));
  const abs = path.resolve(cwd, String(target));
  const guest = guestPath(ev, abs);
  if (guest !== null) return guest;
  const wt = lib.gitRoot(path.dirname(abs));
  if (!wt) return "";
  const common = lib.gitCommonDir(wt);
  if (lib.inScratch(common, abs)) return ""; // proteus-scratch.js --path: the agents' sanctioned temp space
  if (fs.existsSync(lib.ownedFile(wt))) return bindingDenial(ev, cwd, wt, common, abs, briefOf) || lib.ownedDenial(wt, abs);
  if (lib.isLinked(wt)) {
    // an unprepared linked worktree (the lead's _run, an inspection checkout) is no worker's, so leaving the
    // brief's worktree for it is refused; with no worktree in the brief it passes as before
    const named = common && lib.briefWorktree(briefOf(), common);
    return named && !same(lib.realOr(named), lib.realOr(wt)) ? leftBrief(lib.relPath(wt, abs), wt, named) : "";
  }
  if (!common || common !== lib.gitCommonDir(path.resolve(lib.projectRoot(ev))) || !lib.runOpen(common)) return "";
  const rel = lib.relPath(wt, abs);
  if (ev.agentType === "proteus-scout" && /^teams\/[^/]+\/skills\.txt$/.test(rel)) return "";
  const fromCwd = lib.gitRoot(cwd);
  const own = fromCwd && fromCwd !== wt && lib.isLinked(fromCwd) && lib.gitCommonDir(fromCwd) === common ? fromCwd : lib.briefWorktree(briefOf(), common) || bound(common, ev.agent);
  const hint = own && !same(own, wt) && fs.existsSync(own)
    ? `yours is ${slash(own)}: edit ${slash(path.join(own, rel))}`
    : "none found from your cwd; comment NEEDS on the issue and stop";
  return `workers edit only inside their worktree (${hint}). ${rel} is in the main checkout while a run is open.`;
}

// guest mode: the guest dir stands in for the main checkout (null when abs is outside it, or no guest mode)
function guestPath(ev, abs) {
  const root = path.resolve(lib.projectRoot(ev)), guest = lib.guestDir(root);
  const rel = guest ? lib.relPath(guest, abs) : null;
  if (rel === null) return null;
  const common = lib.gitCommonDir(root);
  if (!common || !lib.runOpen(common)) return "";
  if (ev.agentType === "proteus-scout" && /^teams\/[^/]+\/skills\.txt$/.test(rel)) return "";
  return `${rel} is in the guest dir ${slash(guest)}, which holds this repo's Proteus files; workers do not edit it while a run is open. Edit only inside your worktree, or comment NEEDS on the issue and stop.`;
}

// One worker, one worktree. A subagent's worktree is its cwd's when that is a prepared worktree (a
// session opened there); else the one prepared worktree its brief names (ad.briefText, read from the
// subagent's transcript; Codex cannot show it), which binds from the first call, so a first edit in a
// sibling's worktree is refused; else the prepared worktree of its first edit. Each binding is recorded
// per agent id in <git-common-dir>/proteus/agents/ (Claude Code and Codex both report agent_id; a
// subagent's cwd stays the lead's). With no worktree in the brief (helpers, the scout, the guide, a
// contracts worker naming one per ticket), an edit in another prepared worktree is refused while the
// agent's own has uncommitted work; once that is committed (a contracts worker moving to its next
// ticket) the binding moves.
const leftBrief = (rel, wt, named) => `${rel} is in ${slash(wt)}, but your brief names ${slash(named)} as your worktree. ` +
  `Edit under ${slash(named)}, or comment "NEEDS ${rel}: <why>" on the issue and stop.`;
function bindingDenial(ev, cwd, wt, common, abs, briefOf = () => "") {
  if (!common || !lib.isLinked(wt)) return "";
  const rel = lib.relPath(wt, abs);
  const deny = (own, why) => `${rel} is in ${slash(wt)}, another worker's worktree; yours is ${slash(own)}${why}. ` +
    `Edit under yours, or comment "NEEDS ${rel}: <why>" on the issue and stop.`;
  const fromCwd = cwdWorktree(cwd, common);
  if (fromCwd) return same(fromCwd, wt) ? "" : deny(fromCwd, " (your cwd)");
  const file = bindFile(common, ev.agent);
  const named = lib.briefWorktree(briefOf(), common);
  if (named) {
    if (!same(lib.realOr(named), lib.realOr(wt))) return leftBrief(rel, wt, named);
    if (bound(common, ev.agent) !== named) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, named + "\n"); } catch {}
    }
    return "";
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wt + "\n", { flag: "wx" }); // the first edit binds; exclusive, so two parallel calls cannot both bind
    return "";
  } catch {}
  const own = bound(common, ev.agent);
  if (!own || same(own, wt)) return "";
  if (fs.existsSync(own) && lib.git(["status", "--porcelain"], own)) return deny(own, " (uncommitted work there)");
  try { fs.writeFileSync(file, wt + "\n"); } catch {}
  return "";
}

const slash = (p) => String(p).replace(/\\/g, "/");
