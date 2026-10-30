#!/usr/bin/env node
// Stall watchdog for the lead, in place of a timer that woke the lead's model every 20 minutes to look:
//   node <hooks>/proteus-watchdog.js [--wait] [--idle <min>] [--ended <min>] [--grace <min>] [--every <s>] [--max <min>]
//   node <hooks>/proteus-watchdog.js --forget <agent>... | --forget all
// It reads the beat files (lib.beat: the lead's guard stamps a worker's or verifier's file on each of its
// tool calls, proteus-stall.js marks a stop without a report and removes the file on a report; only agents
// the lead spawned itself are tracked, and a stop that hands a final message back to the lead is a report) and
// prints only what needs the lead:
//   STALL <agent> <type> no tool call for <m>m, cwd <dir>         idle --idle minutes (default 40)
//   STALL <agent> <type> stopped <m>m ago without a report, ...   --ended minutes after the stop (default 10)
//   STALL-AGAIN <agent> ...                                       still stalled --grace minutes (default 20) after its STALL
// The lead messages a STALL agent and stops a STALL-AGAIN one, then dispatches a fresh worker on the same
// worktree. A tool call by the agent clears the flag. One-shot by default: exit 1 with the lines, else 0
// and one `ok` line. --wait checks every --every seconds (default 60), prints nothing until something is
// stalled, then exits, so a background run wakes the lead only then; it gives up after --max minutes
// (default 1440). --forget drops agents the lead stopped itself, for good: a later stop of one does not bring it
// back (--forget all: of any agent spawned before it). Beats a day old are removed. No model,
// no network, no git process.
// The beats are lead state in <git-common-dir>/proteus-lead, written by the hooks. This script runs from the
// lead's shell, which a sandbox profile keeps out of proteus-lead (#236): the forgotten list (lib.forget) goes to
// <git-common-dir>/proteus instead, a forgotten agent's beat is skipped, and a STALL flag or a beat removal that
// cannot be written is left out (a stalled agent is then named on every check, not once per grace period).
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const USAGE = "usage: node proteus-watchdog.js [--wait] [--idle <min>] [--ended <min>] [--grace <min>] [--every <s>] [--max <min>] | --forget <agent>... | --forget all";

const DEFAULTS = { idle: 40, ended: 10, grace: 20 };
const ms = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : 0; };
const mins = (d) => `${Math.round(d / MIN)}m`;

// the tracked beats, each { file, rec }, the forgotten agents' left out
function beats(common) {
  const dir = lib.beatsDir(common);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  return names.map((f) => ({ file: path.join(dir, f), rec: lib.readJSON(path.join(dir, f), null) }))
    .filter((b) => b.rec && b.rec.agent && !lib.forgotten(common, b.rec.agent, b.rec.spawn || b.rec.first));
}

// one read of the beats, writing nothing: the agents stalled at now, each { again, agent, type, why, cwd, file, rec },
// an agent flagged less than opt.grace minutes ago left out; with active (beats under a day old) and newest tool call
function stalls(common, now, opt = DEFAULTS) {
  const out = [], old = [];
  let active = 0;
  let newest = 0;
  for (const { file, rec } of beats(common)) {
    const last = ms(rec.last);
    const ended = ms(rec.ended);
    if (now - Math.max(last, ended) > DAY) { old.push(file); continue; }
    active++;
    newest = Math.max(newest, last);
    let why = "";
    if (ended && now - ended >= opt.ended * MIN) why = `stopped ${mins(now - ended)} ago without a report`;
    else if (!ended && now - last >= opt.idle * MIN) why = `no tool call for ${mins(now - last)}`;
    if (!why) continue;
    const flagged = ms(rec.flagged);
    if (flagged && now - flagged < opt.grace * MIN) continue;
    out.push({ again: !!flagged, agent: rec.agent, type: rec.type || "agent", why, cwd: rec.cwd || "?", file, rec });
  }
  return { stalled: out, old, active, newest };
}

function main() {
  const opt = { wait: false, ...DEFAULTS, every: 60, max: 1440, forget: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.replace(/^--/, "");
    if (a === "--wait") opt.wait = true;
    else if (a === "--forget") { opt.forget = argv.slice(i + 1); break; }
    else if (["--idle", "--ended", "--grace", "--every", "--max"].includes(a) && +argv[i + 1] > 0) opt[key] = +argv[++i];
    else { console.error(USAGE); process.exit(2); }
  }

  const common = lib.gitCommonDir(lib.projectRoot());
  if (!common) { console.error("watchdog: not in a git repo"); process.exit(2); }
  const dir = lib.beatsDir(common);
  const fileOf = (agent) => path.join(dir, `${String(agent).replace(/[^\w.-]/g, "_")}.json`);
  const drop = (file) => { try { lib.leadRemove(common, file); } catch {} };

  if (opt.forget) {
    if (!opt.forget.length) { console.error(USAGE); process.exit(2); }
    const all = opt.forget.includes("all");
    const gone = all ? beats(common).map((b) => ({ file: b.file, agent: b.rec.agent })) : opt.forget.map((a) => ({ file: fileOf(a), agent: a }));
    // remembered, so a stop hook that fires after this does not track the agent again (#179)
    lib.forget(common, gone.map((g) => g.agent), all);
    const files = gone.map((g) => g.file);
    for (const f of files) drop(f);
    console.log(`watchdog: forgot ${files.length} agent${files.length === 1 ? "" : "s"}`);
    return;
  }

  // one pass: the lines to print; flags each newly stalled agent so the next pass stays quiet for --grace
  function check(now) {
    const { stalled, old, active, newest } = stalls(common, now, opt);
    for (const f of old) drop(f);
    const out = [];
    for (const s of stalled) {
      out.push(`${s.again ? "STALL-AGAIN" : "STALL"} ${s.agent} ${s.type} ${s.why}, cwd ${s.cwd}`);
      try { lib.leadJSON(common, s.file, { ...s.rec, flagged: new Date(now).toISOString() }); } catch {}
    }
    return { out, active, newest };
  }

  const report = (out) => {
    for (const l of out) console.log(l);
    console.log("STALL: message the agent (status? report DONE/RED/NEEDS now, or continue in the foreground). STALL-AGAIN: stop it, `--forget` it, and dispatch a fresh worker on the same worktree.");
    process.exitCode = 1;
  };

  if (!opt.wait) {
    const { out, active, newest } = check(Date.now());
    if (out.length) report(out);
    else console.log(active ? `watchdog: ok, ${active} agent${active === 1 ? "" : "s"} tracked, newest tool call ${mins(Date.now() - newest)} ago` : "watchdog: ok, no agent tracked");
    return;
  }

  const until = Date.now() + opt.max * MIN;
  (function tick() {
    const { out } = check(Date.now());
    if (out.length) return report(out);
    if (Date.now() >= until) return console.log(`watchdog: nothing stalled in ${opt.max} minutes; run it again while agents are out`);
    setTimeout(tick, opt.every * 1000);
  })();
}

module.exports = { stalls, DEFAULTS };
if (require.main === module) main();
