#!/usr/bin/env node
// SessionStart hook: start every session in a Proteus repo as the lead,
// as if the human had typed /proteus. Prints the skill body plus a local state line
// so the lead knows what bootstrap can skip without spending a tool call.
// Also: syncs agents and hooks from the Proteus checkout named in proteus.json (lib.configFile; not under the plugin),
// regenerates the project's patched agents (proteus-agent-patch.js; none under the plugin),
// checks the checkout for a newer release tag (background fetch at most daily; with autoUpdate, a fast-forward
// to that tag once its signature verifies; the pending release feeds the status line), offers the tour while it is pending (tour=…), and after
// a compaction (or a startup with an open run) re-injects the run-log tail and, after a
// compaction, the human's last ten messages from the journal. Says when scratch may be stale, for the lead to run
// proteus-scratch.js --sweep --stale from its own shell: this hook runs unsandboxed, so it deletes nothing (#237).
// A home agents can write (lib.homeWritable: self-hosted in this project or in any repo a Proteus sandbox profile makes
// writable, #212) gets none of the sync, patches or update; any other home is read through its realpath alone.
// Under the plugin (CLAUDE_PLUGIN_ROOT) the plugin manager owns updates, so the checkout update is off; instead
// releaseCheck says, in one line, when the installed commit is not a release tag the user's trusted key signed.
// On a public GitHub repo, notes once per repo that everything Proteus posts there is public.
// Re-hashes the linked team skills against teams/skills-lock.json (lib.lockDrift): a drift shows as
// skills-lock=drift:<names> plus a note, and the lead guard refuses worker and verifier spawns until it clears.
// With `isolation: container` in AGENTS.md, runs proteus-container.js doctor: isolation=container, or
// isolation=container-unready plus a note naming the failed row (on a harness other than Claude Code, always unready).
// Silent (no autostart) when: PROTEUS=0, inside a subagent, or in a linked worktree
// (workers and the review session's fresh checkout are not the lead).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const { pluginRoot, sandboxBin } = require(path.join(__dirname, "proteus-confine.js"));

if (process.env.PROTEUS === "0") process.exit(0);

lib.run(async (ev, ad) => {
  if (ev.agent) return;
  const root = path.resolve(lib.projectRoot(ev));
  if (lib.isLinked(root)) return;

  const skillDir = ad.skillDirs(root).find((d) => fs.existsSync(path.join(d, "SKILL.md")));
  if (!skillDir) return;

  const notes = [];
  const cfg = lib.proteusConfig();
  const named = typeof cfg.home === "string" && fs.existsSync(cfg.home) ? path.resolve(cfg.home) : null;
  // resolved once (#212 B7): the check judges both paths, and everything after it reads this realpath, never the
  // named path again, which may pass through a link an agent can retarget
  const home = named && lib.realNative(named);
  let pending = "";
  // what these write is the lead's: a lead window for proteus-shell-check.js, so an agent's shell call in flight
  // (a compact mid-run) gets a notice, not a block, and compares against the state after
  const writes = () => {
    if (pluginRoot()) safe(() => lib.releaseCheck(root, notes, pluginRoot(), process.env.CLAUDE_PLUGIN_DATA));
    // a 1.x checkout proteus.json still names syncs nothing under the plugin: its copies would run beside the plugin's
    // a home agents can write (self-hosted in the project, #212 B6) is never fetched, merged, synced or run from,
    // and no patched agent is regenerated from its agents/ (the shipped text would carry an agent's edit, hooks: in
    // the frontmatter included, into the denied .claude/agents/): this hook runs unsandboxed
    const open = home && !pluginRoot() && safe(() => lib.homeWritable(named, root, lib.trustedCommon(root), { real: home }), true);
    if (open) {
      notes.push(`proteus: ${named} is a place agents can write, so this session does not update it, move it to the plugin, sync its hooks and agents, regenerate patched agents from it, or load code from it; update by running node "${path.join(named, "install.js")}" --update from your own terminal. Its skill link ${ad.skillDirs(root)[1]} still loads a SKILL.md agents can edit: remove that link (the link itself, not the folder it points to) from your own terminal unless you check that file`);
    } else if (home && !pluginRoot()) {
      pending = safe(() => update(home, cfg, notes), "");
      if (ad.name === "claude" && !pending) safe(() => pluginMove(home, cfg, notes));
      safe(() => sync(ad, home, root, notes));
      if (!lib.agentPrefix()) safe(() => agentPatches(ad, home, root, notes));
    }
    if (lib.agentPrefix()) safe(() => pluginPatches(root, notes));
    safe(() => codexRoots(ad, root, home, notes));
  };
  let check = null;
  try { check = require(path.join(__dirname, "proteus-shell-check.js")); } catch {}
  if (check && typeof check.leadRun === "function") {
    const seen = await check.leadRun(ev, writes).catch(() => "");
    if (seen) notes.push(seen);
  } else writes();
  safe(() => publicNote(root, notes));
  const identity = safe(() => agentIdentity(ad, root, home, notes), "identity=unknown");
  const runs = lib.runBranches(lib.gitCommonDir(root)).slice(0, 10);
  const src = ev.source;
  const tour = home && (src === "startup" || src === "clear") ? safe(() => tourState(home, cfg), "") : "";
  // hashed afresh each session start; the guard reuses the result until the lock changes
  const drift = safe(() => lib.lockDrift(root, true), []);
  if (drift.length) notes.push(`proteus: worker and verifier spawns are refused until the team skills match the lock. ${lib.relockHint(drift)}`);
  const state = localState(ad, root, runs, home, pending, drift) + " " + identity + " " + safe(() => inboxState(root), "inbox=unknown") + " " + safe(() => models(ev, root), "models=unknown") + safe(() => isolation(ad, root, notes), "");
  if (tour) notes.push(tourOffer(tour));
  safe(() => scratchNote(root, notes));

  if (src === "resume" || src === "fork") {
    // a resumed session still has the skill in its transcript; only the state line is new
    ad.context(ev, [`proteus: session resumed, you are still the lead. ${state}`, ...notes].join("\n"), "session-start");
    return;
  }
  const extra = [];
  if (src === "compact" || runs.length) extra.push(safe(() => runLogTail(root, runs), ""));
  if (src === "compact") extra.push(safe(() => humanSaid(root), ""));

  const body = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  ad.context(
    ev,
    [
      `proteus autostart: this repo runs on Proteus. The skill below is loaded exactly as if the human had typed ${lib.skillCommand()}; do not wait for the command.`,
      `The human's first message is the work order (or a question about the run). Void only if that message is ${lib.skillCommand("proteus-review")}, another slash command, or says "no proteus".`,
      `References live in ${path.join(skillDir, "references")}${path.sep}.`,
      state,
      src === "compact"
        ? "Context was just compacted. The summary above is a hint, not state: re-derive your position from the tracker (Session start 1-3, then the run-log issue) before any dispatch. Background polls and spawned agents may still be alive; check the task list before spawning a duplicate."
        : "",
      ...notes,
      ...extra.filter(Boolean),
      "",
      body,
    ].join("\n"),
    "session-start"
  );
});

function safe(fn, dflt) { try { return fn(); } catch { return dflt; } }

// background fetch (with tags) at most once a day; the update is the newest release tag past HEAD
// (lib.release). Its commit count goes to proteus.json for the status line, so a release shows even
// with autoUpdate off. With it on, the checkout fast-forwards to that tag only once verifyRelease
// accepts its signature; otherwise one note says why and how to update by hand. A home agents can write
// (lib.homeWritable, #212) never gets here: fetch writes FETCH_HEAD and merge the index and tree by path, through
// any link planted there.
function update(home, cfg, notes) {
  const patch = {};
  const last = typeof cfg.lastFetch === "number" ? cfg.lastFetch : Date.parse(cfg.lastFetch) || 0;
  if (Date.now() - last > 24 * 3600e3) {
    try {
      // the human's global config (credentials, proxy) but none the repo's worktrees could plant (lib.gitCall, #215)
      const [args, o] = lib.gitCall(lib.homeGitDir(home), ["fetch", "--quiet", "--tags"], { user: true });
      const c = spawn("git", args, { cwd: o.cwd, env: o.env, detached: true, stdio: "ignore", windowsHide: true });
      c.on("error", () => {});
      c.unref();
    } catch {}
    patch.lastFetch = Date.now();
  }
  const rel = lib.release(home);
  let behind = rel.ahead;
  if (behind && cfg.autoUpdate === true) {
    try {
      const v = lib.verifyRelease(home, rel.tag);
      const gd = lib.homeGitDir(home);
      if (!gd) throw new Error(`${home} is not a git checkout`);
      const tree = { cwd: home, workTree: home, index: path.join(gd, "index") };
      // tracked changes only, as status --untracked-files=no showed them (no git status, #215)
      const dirty = String(lib.gitRun(gd, ["diff", "--no-ext-diff", "--name-only", "HEAD", "--"], tree));
      if (v.error) {
        notes.push(`proteus: not updating to ${rel.tag}: ${v.error}. To trust the maintainer's key see "Releases" in ${path.join(home, "docs", "updating.md")}; or review the tag, then git -C "${home}" merge --ff-only ${rel.tag} and node "${path.join(home, "install.js")}" --update`);
      } else if (dirty.trim()) {
        notes.push(`proteus: local changes in ${home}; not updating to ${rel.tag}`);
      } else {
        const before = lib.homeGit(home, ["rev-parse", "HEAD"]);
        // the verified commit, already fetched: no network wait, no race with the background fetch
        lib.gitRun(gd, ["merge", "--ff-only", "--quiet", v.commit], { ...tree, timeout: 15000, stdio: ["ignore", "ignore", "pipe"] });
        const log = lib.changelog(home, v.commit, rel.current, rel.tag);
        notes.push(`proteus: updated to ${rel.tag} (${lib.homeGit(home, ["rev-parse", "--short", "HEAD"])})${rel.current ? ` from ${rel.current}` : ""}, signature verified${log.length ? "; CHANGELOG.md:" : ""}`, ...log.map((l) => `  ${l}`));
        behind = 0;
        // an install from before the tour existed gets a what's-new tour from here, not a first-time one
        if (cfg.toured === undefined && before) patch.toured = before;
      }
    } catch (e) {
      // a merge git refuses (an untracked file in the way, a lock) or a git call that failed: say so, once per start
      const why = String(e.stderr || e.message || "").trim().split(/\r?\n/)[0];
      notes.push(`proteus: could not update ${home} to ${rel.tag}${why ? ` (${why})` : ""}; still on ${rel.current || "the old version"}`);
    }
  }
  if ((cfg.behind || 0) !== behind) patch.behind = behind;
  if (Object.keys(patch).length) patchConfig(cfg, patch);
  return behind ? rel.tag : "";
}

// autoUpdate's move to the plugin (#155): on a release that ships it, with the claude CLI on PATH and no proteus@proteus
// installed yet, install.js --update runs in the background at most once a day. It pins the plugin to the verified
// release and moves every repo the sources name; offline or with gh logged out it changes nothing. Its output goes
// to proteus-update.log beside proteus.json.
function pluginMove(home, cfg, notes) {
  if (cfg.autoUpdate !== true || !fs.existsSync(path.join(home, ".claude-plugin", "plugin.json"))) return;
  const tried = typeof cfg.pluginTried === "number" ? cfg.pluginTried : 0;
  if (Date.now() - tried < DAY) return;
  const dir = path.dirname(lib.configFile());
  const installed = safe(() => JSON.parse(fs.readFileSync(path.join(dir, "plugins", "installed_plugins.json"), "utf8")).plugins["proteus@proteus"], null);
  if (Array.isArray(installed) && installed.length) return;
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const cli = (process.env.PATH || "").split(path.delimiter).some((d) => d && exts.some((x) => safe(() => fs.statSync(path.join(d, `claude${x}`)).isFile(), false)));
  if (!cli) return;
  const log = path.join(dir, "proteus-update.log");
  const fd = fs.openSync(log, "w");
  try {
    const c = spawn(process.execPath, [path.join(home, "install.js"), "--update"], { cwd: require("os").tmpdir(), detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    c.on("error", () => {});
    c.unref();
  } finally { fs.closeSync(fd); }
  patchConfig(cfg, { pluginTried: Date.now() });
  notes.push(`proteus: moving to the Claude Code plugin in the background (install.js --update); its output is in ${log}`);
}

function patchConfig(cfg, patch) {
  safe(() => {
    const next = { ...lib.proteusConfig(), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || (k === "behind" && !next[k])) delete next[k];
    lib.writeJSON(lib.configFile(), next);
  });
  Object.assign(cfg, patch);
}

// printed only while the tour is pending, so a toured install carries none of it
function tourOffer(tour) {
  const n = tour.split(":")[1];
  const line = n ? `Proteus has ${n} new feature${n === "1" ? "" : "s"} since your last tour: type \`tour\`, or \`tour off\`.` : "New to Proteus? Type `tour` for a short walkthrough, or `tour off`.";
  return `proteus ${tour}: open your first reply with this one line, then carry on: "${line}" (the hook repeats the offer, you do not; \`tour\` → references/tour.md).`;
}

// the tour offer: tour=new until the first tour, tour=whats-new:N once N features landed since the
// last one. At most three session starts, then recorded as declined; nothing at all once taken.
const FEATURE = /^feat(\([^)]*\))?!?:|^\w+(\([^)]*\))?!:/;
function tourState(home, cfg) {
  let field = "tour=new";
  const head = lib.homeGit(home, ["rev-parse", "HEAD"]);
  if (cfg.toured) {
    if (!head || head === cfg.toured) return "";
    const n = lib.homeGit(home, ["log", "--format=%s", `${cfg.toured}..HEAD`]).split("\n").filter((l) => FEATURE.test(l)).length;
    if (!n) return "";
    field = `tour=whats-new:${n}`;
  }
  const offers = (cfg.tourOffers || 0) + 1;
  if (offers > 3) { patchConfig(cfg, { toured: head || "none", tourOffers: undefined }); return ""; }
  patchConfig(cfg, { tourOffers: offers });
  return field;
}

// agents and hooks to where the harness keeps them, only when bytes differ; never deletes, and a
// Codex role without the generated header (the user's own) is skipped
// (install-lead-hooks removes the files the adapter skips)
function sync(ad, home, root, notes) {
  let n = 0;
  let hooks = 0;
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const f of ls(path.join(home, "agents"))) {
    if (!f.endsWith(".md")) continue;
    let a = null;
    try { a = ad.agentFile(f, fs.readFileSync(path.join(home, "agents", f), "utf8")); } catch {}
    if (a && lib.syncText(a.text, path.join(ad.agentsDir, a.name), ad.generated)) n++;
  }
  const hooksSrc = path.join(home, "templates", "hooks");
  for (const f of ls(hooksSrc)) {
    if (f === "install-lead-hooks.js" || (ad.skipHooks || []).includes(f)) continue; // the installer runs from the source
    const s = path.join(hooksSrc, f);
    if (fs.statSync(s).isFile() && lib.syncFile(s, path.join(ad.hooksDir(root), f))) hooks++;
  }
  // a new hook file may need a new registration; the CommonJS marker (#77) this sync can bring is excluded from
  // git by install.js --project, not here: this hook runs unsandboxed and writes nothing in the git dir (#236)
  if (hooks) ad.registerLead(root);
  if (n + hooks) notes.push(`proteus: synced ${n + hooks} files from ${home}`);
}

// the project's patched agents (.claude/proteus-agents.json) regenerated from the shipped ones, so an
// auto-update reaches them too; the checkout's module first, since this hook may predate it
function agentPatches(ad, home, root, notes) {
  const mod = [path.join(home, "templates", "hooks", "proteus-agent-patch.js"), path.join(__dirname, "proteus-agent-patch.js")].find((p) => fs.existsSync(p));
  if (!mod) return;
  const r = require(mod).apply(root, home, ad, undefined, true);
  const cmd = `node "${path.join(home, "install.js")}" --project`;
  if (r.error) notes.push(`proteus: ${r.error}; generated agents left as they were. Tell the human; once fixed, ${cmd}`);
  else if (r.written.length + r.removed.length) notes.push(`proteus: ${[...r.written.map((p) => `${p} regenerated`), ...r.removed.map((p) => `${p} removed`)].join(", ")} (${r.file}); agent types load at session start, so the change applies from the next session`);
  // a link the repo commits (#22); an older checkout's module has no refused list
  if (!r.error && r.refused && r.refused.length) notes.push(`proteus: refused ${r.refused.join(", ")} (a link, or a link on the way); no generated agent written or removed through it. Tell the human`);
}

// under the plugin nothing is patched: a generated copy would sit beside the plugin's own proteus:<agent> under the bare name
// (agentPrefix is "" on Codex, so this is Claude Code's patch file)
function pluginPatches(root, notes) {
  if (fs.existsSync(path.join(root, ".claude", "proteus-agents.json"))) notes.push("proteus: .claude/proteus-agents.json is not applied under the plugin; its agents run as shipped");
}

// A public repo publishes the run log, briefs, contracts, evidence and questions: said once per repo,
// recorded in <common>/proteus-lead/visibility.json. Until then gh is asked at most once a day (3 s
// timeout; any failure, no remote or offline, just waits for the next day).
const DAY = 24 * 3600e3;
function publicNote(root, notes) {
  const common = lib.gitCommonDir(root);
  if (!common) return;
  const file = lib.leadPath(common, "visibility.json");
  const seen = lib.readJSON(file, null) || {};
  if (seen.warned) return;
  let vis = typeof seen.visibility === "string" ? seen.visibility : "";
  let at = typeof seen.at === "number" ? seen.at : 0;
  if (Date.now() - at >= DAY) {
    vis = lib.gh(["repo", "view", "--json", "visibility", "-q", ".visibility"], root, 3000).toUpperCase();
    at = Date.now();
    lib.leadJSON(common, file, { at, visibility: vis });
  }
  if (vis !== "PUBLIC") return;
  notes.push("proteus: this repo is public on GitHub. The run log, issues, contracts, review briefs, evidence branches and questions Proteus posts are readable by anyone. Tell the human once, in your first reply, so nothing private goes into a work order, an answer or an evidence file. (Shown once per repo.)");
  lib.leadJSON(common, file, { at, visibility: vis, warned: new Date().toISOString() });
}

// one line when a scratch dir or a ledgered stray has been idle 72h, the --stale sweep's shortest wait. The sweep
// itself deletes under <common>/proteus/scratch and <common>/worktrees, which agents can write, so only the lead's
// sandboxed shell runs it (#237); this only lstat's. The sweep caches the size the next state line reads.
const SCRATCH_IDLE = 72 * 3600e3;
function scratchNote(root, notes) {
  const common = lib.gitCommonDir(root);
  if (!common) return;
  const old = (t) => Date.now() - t > SCRATCH_IDLE;
  const dir = lib.scratchDir(common);
  let stale = false;
  try {
    const st = fs.lstatSync(dir);
    if (st.isDirectory() && !st.isSymbolicLink()) stale = fs.readdirSync(dir).some((n) => { try { return old(fs.lstatSync(path.join(dir, n)).mtimeMs); } catch { return false; } });
  } catch {}
  if (!stale) stale = lib.tailLines(lib.leadPath(common, "scratch-ledger.jsonl"), 1 << 20, true).some((l) => { try { const r = JSON.parse(l); return typeof r.path === "string" && old(+r.at || 0); } catch { return false; } });
  if (stale) notes.push(`proteus: scratch may be stale (idle 72h or more); free it from your shell: node "${path.join(__dirname, "proteus-scratch.js")}" --sweep --stale`);
}

// Codex: worker worktrees live in .worktrees/, inside the project, so writable_roots needs no entry for them. A
// folder beside the project that an older run still has worktrees in stays listed (added back if lost) until they
// merge, then goes. The adapter's own writer does that when config.toml exists; any other case only names the
// command. Silent when nothing changes.
function codexRoots(ad, root, home, notes) {
  if (typeof ad.sandboxRoots !== "function") return;
  const check = ad.sandboxRoots(root, false);
  if (!check.error && !(check.missing || []).length && !(check.stale || []).length) return;
  const w = !check.error && fs.existsSync(check.file) ? ad.sandboxRoots(root) : check;
  if (w.changed) {
    const did = [...w.missing.map((d) => `${d} added back (an older run still has worktrees there)`), ...w.stale.map((d) => `${d} dropped (no worktree of an older run is left in it)`)];
    notes.push(`proteus: writable_roots in ${w.file}: ${did.join("; ")}`);
    return;
  }
  const cmd = home ? `node "${path.join(home, "install.js")}" --update` : "install.js --update";
  notes.push(`proteus: ${w.error || `${w.missing.join(", ")} is not in writable_roots of ${w.file}`}; ${cmd} (install.ps1 -Update on Windows) finishes the move`);
}

// The agents' GitHub login: with "agentGh" in proteus.json (install.js --agent-login), every agent shell command,
// the lead's included, runs gh under that config dir, so the human's own login stays the human's. Claude Code takes
// the variable through its env file for this session; Codex through the project's config.toml from its next
// session. Returns the identity= token: separate, shared (agents post as the human), or next (Codex, set for next time).
function agentIdentity(ad, root, home, notes) {
  if (typeof ad.exportEnv !== "function") return "identity=unknown";
  const dir = lib.agentGhDir();
  const fix = home ? `node "${path.join(home, "install.js")}" --agent-login` : "install.js --agent-login";
  if (dir && !fs.existsSync(dir)) notes.push(`proteus: agentGh ${dir} does not exist; ${fix} sets it up`);
  const use = dir && fs.existsSync(dir) ? dir : "";
  const w = ad.exportEnv(root, { GH_CONFIG_DIR: use });
  if (w.error) {
    if (use) notes.push(`proteus: agents post as the human: ${w.error}`);
    return "identity=shared";
  }
  if (!use) return "identity=shared";
  if (w.changed) {
    notes.push(`proteus: GH_CONFIG_DIR for agent shells written to ${w.file}; Codex reads it from the next session`);
    return "identity=next";
  }
  return "identity=separate";
}

// the open run's log issue
function runLogTail(root, runs) {
  const list = JSON.parse(lib.gh(["issue", "list", "--label", lib.CURRENT.log, "--state", "open", "--json", "number,title", "--limit", "5"], root) || "null");
  if (!Array.isArray(list)) return "";
  if (!list.length) return `run-log: no open issue labelled ${lib.CURRENT.log}.`;
  const pick = list.find((i) => runs.some((r) => String(i.title).includes(lib.runName(r)))) || list[0];
  const view = JSON.parse(lib.gh(["issue", "view", String(pick.number), "--json", "comments"], root) || "{}");
  const bodies = ((view && view.comments) || []).slice(-12).map((c) => String((c && c.body) || "").trim()).filter(Boolean);
  const kept = [];
  let total = 0;
  for (let i = bodies.length - 1; i >= 0; i--) {
    if (total + bodies[i].length > 3000) { if (!kept.length) kept.unshift(bodies[i].slice(-3000)); break; }
    kept.unshift(bodies[i]);
    total += bodies[i].length;
  }
  return [`run-log #${pick.number} tail (newest last):`, ...kept.map((b) => "- " + b.replace(/\n/g, "\n  "))].join("\n");
}

// open needs-human questions/reviews: the cache when under 10 min old, else a 3 s refresh
function inboxState(root) {
  const common = lib.gitCommonDir(root);
  if (!common) return "inbox=unknown";
  let age = Infinity;
  try { age = Date.now() - fs.statSync(lib.inboxFile(common)).mtimeMs; } catch {}
  const inbox = (age > 10 * 60 * 1000 && lib.refreshInbox(root, common, 3000)) || lib.readInbox(common);
  return inbox ? `inbox=${inbox.questions.length}q/${inbox.reviews.length}r` : "inbox=unknown";
}

// a regular file, not a link to one (lstat), in a state dir that is not a link either: a journal that is a link
// or a FIFO is never opened, and the open itself does not follow a link swapped in since (lib.tailLines regular)
const regularFile = (f) => { try { return fs.lstatSync(path.dirname(f)).isDirectory() && fs.lstatSync(f).isFile(); } catch { return false; } };

function humanSaid(root) {
  const common = lib.gitCommonDir(root);
  if (!common) return "";
  const f = lib.leadPath(common, "journal.jsonl");
  const lines = regularFile(f) ? [...new Set(lib.tailLines(f, 512 * 1024, true))].slice(-10) : [];
  const said = lines.flatMap((l) => {
    // redacted again on the way out: a journal written before redaction existed may hold secrets
    const p = safe(() => { const raw = JSON.parse(l).prompt; return typeof raw === "string" ? lib.redact(raw) : ""; }, "");
    return typeof p === "string" && p.trim() ? ["- " + (p.length > 400 ? p.slice(0, 400) + "…" : p).replace(/\n/g, "\n  ")] : [];
  });
  return said.length ? ["human said (verbatim, newest last):", ...said].join("\n") : "";
}

// AGENTS.md `isolation: container` (#80): workers run through proteus-container.js. Its doctor (the sandbox's bin copy
// when there is one, which no agent can write) gates it: a failing row makes it container-unready, and the lead waits
function isolation(ad, root, notes) {
  if ((lib.agentsLine(root, "isolation") || "").trim() !== "container") return "";
  const wait = "No worker runs until it passes; tell the human this in one line and wait.";
  if (ad.name !== "claude") { notes.push(`proteus: isolation: container is set, but the container runner drives Claude Code only, not ${ad.name}. ${wait}`); return " isolation=container-unready"; }
  const common = lib.gitCommonDir(root), bin = common && path.join(sandboxBin(common), "proteus-container.js");
  const script = bin && safe(() => fs.lstatSync(bin).isFile(), false) ? bin : path.join(__dirname, "proteus-container.js");
  const r = lib.spawnArgv(process.execPath, [script, "doctor"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  if (r.status === 0) return " isolation=container";
  const row = String(r.stdout || "").split("\n").find((l) => /^FIX\b/.test(l)) || (r.error ? `doctor did not finish (${r.error.code || r.error.message})` : `doctor exited ${r.status}`);
  notes.push(`proteus: isolation: container is set, but node ${script} doctor fails: ${row.replace(/^FIX\s+/, "")}. ${wait}`);
  return " isolation=container-unready";
}

// the ladder for this session: the lead's model, and each role tier's model (@effort where the
// harness passes effort per spawn)
function models(ev, root) {
  safe(() => lib.saveLead(ev, root));
  const c = lib.modelCaps(ev, root);
  if (!c.ladder.length) return "models=unknown";
  const lead = c.leadRung >= 0 ? c.ladder[c.leadRung] : "unknown";
  const t = (x) => x.model + (x.effort ? `@${x.effort}` : "");
  return `models=lead:${lead},judge:${t(c.tiers.judge)},build:${t(c.tiers.build)},helper:${t(c.tiers.helper)}`;
}

// guest mode: the docs and teams/ are read from the guest dir; the repo's CI, lefthook and root docs are not Proteus's
function localState(ad, root, runs, home, pending, drift) {
  const guest = lib.guestDir(root), base = guest || root;
  const has = (f) => fs.existsSync(path.join(base, f));
  const read = (f) => { try { return fs.readFileSync(path.join(base, f), "utf8"); } catch { return ""; } };
  const ls = (d) => { try { return fs.readdirSync(path.join(base, d)); } catch { return []; } };
  const agents = read("AGENTS.md") + "\n" + read("CLAUDE.md"); // older installs keep ## Learned in CLAUDE.md
  const profiles = (() => { try { return fs.readdirSync(path.join(base, "teams"), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(base, "teams", e.name, "skills.txt"))).map((e) => e.name); } catch { return []; } })();
  const shipped = profiles.filter((p) => /shipped default/.test(read(`teams/${p}/skills.txt`).split("\n")[0]));
  const unlinked = profiles.filter((p) => ls(ad.teamSkills(path.join("teams", p))).length === 0);
  // root agent docs over budget, and any CLAUDE_*.md / CLAUDE-*.md split at all
  const bloat = guest ? [] : ls(".").filter((f) => /^(CLAUDE|AGENTS).*\.md$/.test(f)).map((f) => {
    const text = read(f);
    const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    return lines > 150 || /^CLAUDE[_-]/.test(f) ? `${f}:${lines}` : "";
  }).filter(Boolean);
  const lessons = ls(path.join("docs", "lessons")).filter((f) => f.endsWith(".md")).length;
  const common = lib.gitCommonDir(root);
  const scratch = common ? Math.round(((lib.readJSON(lib.leadPath(common, "scratch-size.json"), {}) || {}).bytes || 0) / 1048576) : 0;
  const yn = (b) => (b ? "yes" : "NO");
  return (
    "proteus-state (local files only; tracker not queried): " +
    [
      ...(guest ? [`guest=${guest.split(path.sep).join("/")}`] : []),
      `CONTEXT.md=${yn(has("CONTEXT.md"))}`,
      `CONVENTIONS.md=${yn(has("CONVENTIONS.md"))}`,
      `AGENTS.md#Learned=${yn(/^## Learned/m.test(agents))}`,
      `teams=${profiles.length ? profiles.join(",") : "NO"}`,
      `skills-unscouted=${shipped.join(",") || "none"}`,
      `skills-unlinked=${unlinked.join(",") || "none"}`,
      `skills-lock=${drift.length ? `drift:${drift.join(",")}` : yn(has("teams/skills-lock.json"))}`,
      `ci-gates=${guest ? "guest" : yn(has(".github/workflows/proteus-gates.yml"))}`,
      `lefthook=${guest ? "guest" : yn(has("lefthook.yml"))}`,
      `protection=${/protection:\s*none/.test(agents) ? "none" : "on"}`,
      `proteus-branches=${runs.join(",") || "none"}`,
      `doc-bloat=${bloat.join(",") || "none"}`,
      `lessons=${lessons}`,
      ...(scratch > 1024 ? [`scratch=${scratch}MB`] : []),
      ...(ad.contextModeOn() ? [] : ["context-mode=missing"]),
      `proteus-src=${home || "none"}`,
      ...(lib.agentPrefix() ? [`agent-prefix=${lib.agentPrefix()}`] : []),
      ...(pending ? [`proteus-update=${pending} (node ${path.join(home, "install.js")} --update)`] : []),
    ].join(" ")
  );
}
