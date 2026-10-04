#!/usr/bin/env node
// SessionStart hook: start every session in a Proteus repo as the lead,
// as if the human had typed /proteus. Prints the skill body plus a local state line
// so the lead knows what bootstrap can skip without spending a tool call.
// Also: syncs agents and hooks from the Proteus checkout named in proteus.json (lib.configFile),
// checks it for a newer release tag (background fetch at most daily; with autoUpdate, a fast-forward
// to that tag once its signature verifies; the pending release feeds the status line), offers the tour while it is pending (tour=…), and after
// a compaction (or a startup with an open run) re-injects the run-log tail and, after a
// compaction, the human's last ten messages from the journal. Starts the scratch safety sweep
// (proteus-scratch.js --sweep --stale) detached, so it never slows the start. Moves the state a
// pre-rename install left in the legacy state dir into <git-common-dir>/proteus (lib.migrateState),
// and lists open runs on either branch prefix: a legacy run keeps its names until it closes.
// On a public GitHub repo, notes once per repo that everything Proteus posts there is public.
// Re-hashes the linked team skills against teams/skills-lock.json (lib.lockDrift): a drift shows as
// skills-lock=drift:<names> plus a note, and the lead guard refuses worker and verifier spawns until it clears.
// Silent (no autostart) when: PROTEUS=0, inside a subagent, or in a linked worktree
// (workers and the review session's fresh checkout are not the lead).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

if (process.env.PROTEUS === "0") process.exit(0);

lib.run((ev, ad) => {
  if (ev.agent) return;
  const root = path.resolve(lib.projectRoot(ev));
  if (lib.isLinked(root)) return;

  const skillDir = ad.skillDirs(root).find((d) => fs.existsSync(path.join(d, "SKILL.md")));
  if (!skillDir) return;

  const notes = [];
  const cfg = lib.proteusConfig();
  const home = typeof cfg.home === "string" && fs.existsSync(cfg.home) ? path.resolve(cfg.home) : null;
  let pending = "";
  if (home) {
    pending = safe(() => update(home, cfg, notes), "");
    safe(() => sync(ad, home, root, notes));
  }
  safe(() => migrateState(root, home, notes));
  safe(() => codexRoots(ad, root, home, notes));
  safe(() => publicNote(root, notes));
  const identity = safe(() => agentIdentity(ad, root, home, notes), "identity=unknown");
  const runs = lib.runBranches(lib.gitCommonDir(root)).slice(0, 10);
  const src = ev.source;
  const tour = home && (src === "startup" || src === "clear") ? safe(() => tourState(home, cfg), "") : "";
  // hashed afresh each session start; the guard reuses the result until the lock changes
  const drift = safe(() => lib.lockDrift(root, true), []);
  if (drift.length) notes.push(`proteus: worker and verifier spawns are refused until the team skills match the lock. ${lib.relockHint(drift)}`);
  const state = localState(ad, root, runs, home, pending, drift) + " " + identity + " " + safe(() => inboxState(root), "inbox=unknown") + " " + safe(() => models(ev, root), "models=unknown");
  if (tour) notes.push(tourOffer(tour));
  safe(() => scratchSweep(root));

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
      "proteus autostart: this repo runs on Proteus. The skill below is loaded exactly as if the human had typed /proteus; do not wait for the command.",
      "The human's first message is the work order (or a question about the run). Void only if that message is /proteus-review, another slash command, or says \"no proteus\".",
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
// accepts its signature; otherwise one note says why and how to update by hand.
function update(home, cfg, notes) {
  const patch = {};
  const last = typeof cfg.lastFetch === "number" ? cfg.lastFetch : Date.parse(cfg.lastFetch) || 0;
  if (Date.now() - last > 24 * 3600e3) {
    try {
      const c = spawn("git", ["-C", home, "fetch", "--quiet", "--tags"], { detached: true, stdio: "ignore", windowsHide: true });
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
      const dirty = execFileSync("git", ["-C", home, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      if (v.error) {
        notes.push(`proteus: not updating to ${rel.tag}: ${v.error}. To trust the maintainer's key see "Releases" in ${path.join(home, "README.md")}; or review the tag, then git -C "${home}" merge --ff-only ${rel.tag} and node "${path.join(home, "install.js")}" --update`);
      } else if (!dirty.trim()) {
        const before = lib.git(["-C", home, "rev-parse", "HEAD"], home);
        // the verified commit, already fetched: no network wait, no race with the background fetch
        execFileSync("git", ["-C", home, "merge", "--ff-only", "--quiet", v.commit], { timeout: 15000, windowsHide: true, stdio: "ignore" });
        const log = lib.changelog(home, v.commit, rel.current, rel.tag);
        notes.push(`proteus: updated to ${rel.tag} (${lib.git(["-C", home, "rev-parse", "--short", "HEAD"], home)})${rel.current ? ` from ${rel.current}` : ""}, signature verified${log.length ? "; CHANGELOG.md:" : ""}`, ...log.map((l) => `  ${l}`));
        behind = 0;
        // an install from before the tour existed gets a what's-new tour from here, not a first-time one
        if (cfg.toured === undefined && before) patch.toured = before;
      }
    } catch {}
  }
  if ((cfg.behind || 0) !== behind) patch.behind = behind;
  if (Object.keys(patch).length) patchConfig(cfg, patch);
  return behind ? rel.tag : "";
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
  const head = lib.git(["-C", home, "rev-parse", "HEAD"], home);
  if (cfg.toured) {
    if (!head || head === cfg.toured) return "";
    const n = lib.git(["-C", home, "log", "--format=%s", `${cfg.toured}..HEAD`], home).split("\n").filter((l) => FEATURE.test(l)).length;
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
  // a new hook file may need a new registration
  if (hooks) ad.registerLead(root);
  // the CommonJS marker (#77) can arrive by this sync before install.js --project excludes it
  if (hooks) safe(() => excludeMarker(ad, root));
  if (n + hooks) notes.push(`proteus: synced ${n + hooks} files from ${home}`);
}

// keeps <hooks dir>/package.json out of `git add`, as install.js's exclude list does
function excludeMarker(ad, root) {
  const line = path.relative(root, path.join(ad.hooksDir(root), "package.json")).split(path.sep).join("/");
  const common = lib.gitCommonDir(root);
  if (!common || !fs.existsSync(path.join(root, line))) return;
  const file = path.join(common, "info", "exclude");
  let cur = "";
  try { cur = fs.readFileSync(file, "utf8"); } catch {}
  if (cur.split(/\r?\n/).includes(line)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
}

// A public repo publishes the run log, briefs, contracts, evidence and questions: said once per repo,
// recorded in <common>/proteus/visibility.json. Until then gh is asked at most once a day (3 s
// timeout; any failure, no remote or offline, just waits for the next day).
const DAY = 24 * 3600e3;
function publicNote(root, notes) {
  const common = lib.gitCommonDir(root);
  if (!common) return;
  const file = path.join(lib.stateDir(common), "visibility.json");
  const seen = lib.readJSON(file, null) || {};
  if (seen.warned) return;
  let vis = typeof seen.visibility === "string" ? seen.visibility : "";
  let at = typeof seen.at === "number" ? seen.at : 0;
  if (Date.now() - at >= DAY) {
    vis = lib.gh(["repo", "view", "--json", "visibility", "-q", ".visibility"], root, 3000).toUpperCase();
    at = Date.now();
    lib.writeJSON(file, { at, visibility: vis });
  }
  if (vis !== "PUBLIC") return;
  notes.push("proteus: this repo is public on GitHub. The run log, issues, contracts, review briefs, evidence branches and questions Proteus posts are readable by anyone. Tell the human once, in your first reply, so nothing private goes into a work order, an answer or an evidence file. (Shown once per repo.)");
  lib.writeJSON(file, { at, visibility: vis, warned: new Date().toISOString() });
}

// only when the run has scratch state; the sweep caches the size the next state line reads
function scratchSweep(root) {
  const store = lib.stateDir(lib.gitCommonDir(root));
  if (!fs.existsSync(path.join(store, "scratch-ledger.jsonl")) && !fs.existsSync(path.join(store, "scratch"))) return;
  const c = spawn(process.execPath, [path.join(__dirname, "proteus-scratch.js"), "--sweep", "--stale"], { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
  c.on("error", () => {});
  c.unref();
}

// state an install from before the rename left in the legacy dir moves into stateDir (never
// overwriting; the *.jsonl logs merge), so the journal survives an auto-update that never re-ran the
// installer; what stays is named
function migrateState(root, home, notes) {
  const common = lib.gitCommonDir(root);
  const r = lib.migrateState(common);
  const left = [...r.kept, ...r.held, ...r.failed];
  if (!left.length) return;
  const cmd = home ? `node "${path.join(home, "install.js")}" --doctor` : "install.js --doctor";
  notes.push(`proteus: ${lib.legacyStateDir(common)} still holds ${left.join(", ")}; ${cmd} says why`);
}

// Codex: an auto-update never re-ran --project, so writable_roots may lack the worker folder. The
// adapter's own writer adds it (and drops the stale legacy root under its rules) when config.toml
// exists; any other case only names the command. Silent when the root is already there.
function codexRoots(ad, root, home, notes) {
  if (typeof ad.sandboxRoots !== "function") return;
  const check = ad.sandboxRoots(root, false);
  if (!check.error && !check.missing && !check.stale) return;
  const w = !check.error && fs.existsSync(check.file) ? ad.sandboxRoots(root) : check;
  if (w.changed) {
    notes.push(`proteus: ${w.dir} added to writable_roots in ${w.file}${w.stale ? ` (${w.stale} dropped: no worktree of a pre-rename run is left in it)` : ""}`);
    return;
  }
  const cmd = home ? `node "${path.join(home, "install.js")}" --update` : "install.js --update";
  notes.push(`proteus: ${w.error || `${w.dir} is not in writable_roots of ${w.file}`}; ${cmd} (install.ps1 -Update on Windows) finishes the move`);
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

// the open run's log issue; a run opened before the rename is labelled with the legacy log label
function runLogTail(root, runs) {
  const find = (label) => JSON.parse(lib.gh(["issue", "list", "--label", label, "--state", "open", "--json", "number,title", "--limit", "5"], root) || "null");
  let list = find(lib.CURRENT.log);
  if (Array.isArray(list) && !list.length && runs.some((b) => lib.schemeOf(b) === lib.LEGACY)) list = find(lib.LEGACY.log);
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

function humanSaid(root) {
  const common = lib.gitCommonDir(root);
  if (!common) return "";
  // a legacy journal the migration could not merge yet is still read, its lines first, each line once
  const files = [lib.legacyStateDir(common), lib.stateDir(common)].flatMap((d) => { const f = path.join(d, "journal.jsonl"); return fs.existsSync(f) ? [f] : []; });
  const lines = [...new Set(files.flatMap((f) => lib.tailLines(f, 512 * 1024)))].slice(-10);
  const said = lines.flatMap((l) => {
    // redacted again on the way out: a journal written before redaction existed may hold secrets
    const p = safe(() => { const raw = JSON.parse(l).prompt; return typeof raw === "string" ? lib.redact(raw) : ""; }, "");
    return typeof p === "string" && p.trim() ? ["- " + (p.length > 400 ? p.slice(0, 400) + "…" : p).replace(/\n/g, "\n  ")] : [];
  });
  return said.length ? ["human said (verbatim, newest last):", ...said].join("\n") : "";
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
  const scratch = common ? Math.round(((lib.readJSON(path.join(lib.stateDir(common), "scratch-size.json"), {}) || {}).bytes || 0) / 1048576) : 0;
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
      ...(pending ? [`proteus-update=${pending} (node ${path.join(home, "install.js")} --update)`] : []),
    ].join(" ")
  );
}
