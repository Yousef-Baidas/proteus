#!/usr/bin/env node
// Stall watchdog for the lead, in place of a timer that woke the lead's model every 20 minutes to look:
//   node <hooks>/proteus-watchdog.js [--wait] [--idle <min>] [--ended <min>] [--grace <min>] [--every <s>] [--max <min>]
//   node <hooks>/proteus-watchdog.js --forget <agent>... | --forget all
// It reads the beat files (lib.beat: the lead's guard stamps a worker's or verifier's file on each of its
// tool calls, proteus-stall.js marks a stop without a report and removes the file on a report) and
// prints only what needs the lead:
//   STALL <agent> <type> no tool call for <m>m, cwd <dir>         idle --idle minutes (default 40)
//   STALL <agent> <type> stopped <m>m ago without a report, ...   --ended minutes after the stop (default 10)
//   STALL-AGAIN <agent> ...                                       still stalled --grace minutes (default 20) after its STALL
// The lead messages a STALL agent and stops a STALL-AGAIN one, then dispatches a fresh worker on the same
// worktree. A tool call by the agent clears the flag. One-shot by default: exit 1 with the lines, else 0
// and one `ok` line. --wait checks every --every seconds (default 60), prints nothing until something is
// stalled, then exits, so a background run wakes the lead only then; it gives up after --max minutes
// (default 1440). --forget drops agents the lead stopped itself. Beats a day old are removed. No model,
// no network, no git process.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const USAGE = "usage: node proteus-watchdog.js [--wait] [--idle <min>] [--ended <min>] [--grace <min>] [--every <s>] [--max <min>] | --forget <agent>... | --forget all";

const opt = { wait: false, idle: 40, ended: 10, grace: 20, every: 60, max: 1440, forget: null };
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
const beats = () => {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  return names.map((f) => ({ file: path.join(dir, f), rec: lib.readJSON(path.join(dir, f), null) })).filter((b) => b.rec && b.rec.agent);
};

if (opt.forget) {
  if (!opt.forget.length) { console.error(USAGE); process.exit(2); }
  const files = opt.forget.includes("all") ? beats().map((b) => b.file) : opt.forget.map(fileOf);
  for (const f of files) fs.rmSync(f, { force: true });
  console.log(`watchdog: forgot ${files.length} agent${files.length === 1 ? "" : "s"}`);
  return;
}

const ms = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : 0; };
const mins = (d) => `${Math.round(d / MIN)}m`;

// one pass: the lines to print; flags each newly stalled agent so the next pass stays quiet for --grace
function check(now) {
  const out = [];
  let active = 0;
  let newest = 0;
  for (const { file, rec } of beats()) {
    const last = ms(rec.last);
    const ended = ms(rec.ended);
    if (now - Math.max(last, ended) > DAY) { fs.rmSync(file, { force: true }); continue; }
    active++;
    newest = Math.max(newest, last);
    let why = "";
    if (ended && now - ended >= opt.ended * MIN) why = `stopped ${mins(now - ended)} ago without a report`;
    else if (!ended && now - last >= opt.idle * MIN) why = `no tool call for ${mins(now - last)}`;
    if (!why) continue;
    const flagged = ms(rec.flagged);
    if (flagged && now - flagged < opt.grace * MIN) continue;
    out.push(`${flagged ? "STALL-AGAIN" : "STALL"} ${rec.agent} ${rec.type || "agent"} ${why}, cwd ${rec.cwd || "?"}`);
    try { lib.writeJSON(file, { ...rec, flagged: new Date(now).toISOString() }); } catch {}
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
