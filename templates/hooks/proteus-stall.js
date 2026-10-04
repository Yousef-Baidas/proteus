#!/usr/bin/env node
// Stop / SubagentStop / TeammateIdle hook: an agent that ends its turn "waiting on"
// a background job never wakes (the notification cannot arrive after the turn ends), so the
// stop is blocked once with an order to poll in the foreground.
// Lead's session: SubagentStop + TeammateIdle. Worker worktrees: Stop.
// Never loops: stop_hook_active → pass; the same message is never blocked twice.
// Final reports (DONE, VERDICT, RED, NEEDS, WAVE-…, MERGE, BACK-TO-WORKER, CONTRACT-WRONG) never block.
// A subagent's stop also updates its beat for proteus-watchdog.js: a report removes it, a stop that
// passes without one marks it ended, a blocked stop counts as activity.
"use strict";
const crypto = require("crypto");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const REASON = "You ended your turn waiting on a background job. Nothing will wake you. Poll it now in the foreground until it finishes, then report.";
const FINAL = /^\s*(\*\*)?(DONE|VERDICT|RED|NEEDS|WAVE-|MERGE|BACK-TO-WORKER|CONTRACT-WRONG|AUTO-ACCEPT|AUTO-HOLD)\b/;
const WAITING_ON = /\b(waiting (on|for) (the |a |my |its |this )?(background|job|render|build|process|task|run|download|upload|export|bake|training|deploy|ci|pipeline|poll|command|script|server)|still (running|rendering|building|in progress))\b/i;
const WAIT_VERB = /\b(wait(ing)?|will (check|report|poll|resume|update|follow up|continue)|i'll (check|report|poll|resume|continue|let you know)|once (it|the [\w-]+|that) (finishes|completes|is done|ends)|when (it|the [\w-]+|that) (finishes|completes|is done|ends)|notif(y|ied|ication)|monitor(ing)?|check back)\b/i;
const BACKGROUND = /\b(background(ed)?|job|render(ing)?|process|build|task|pid|nohup|in progress|running)\b/i;

lib.run((ev, ad) => {
  const text = String(ad.lastAssistantText(ev) || "");
  if (FINAL.test(text)) { lib.beat(ev, "done"); return; }
  if (ev.stopActive || !text.trim()) { lib.beat(ev, "ended"); return; }
  const end = text.slice(-800); // the waiting sentence sits at the end of the message
  const waiting = WAITING_ON.test(end) || (WAIT_VERB.test(end) && (BACKGROUND.test(end) || ev.busy));
  if (!waiting || seenBefore(ev, text)) { lib.beat(ev, "ended"); return; }

  lib.beat(ev, "tool");
  ad.keepGoing(ev, REASON);
});

// one block per distinct message: an idle teammate has no stopActive
function seenBefore(ev, text) {
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common) return false;
  const file = path.join(lib.stateDir(common), "stall-blocked.json");
  const key = crypto.createHash("sha1").update(`${ev.agent || ev.teammate || ev.session}\n${text}`).digest("hex");
  const seen = lib.readJSON(file, []);
  const list = Array.isArray(seen) ? seen : [];
  if (list.includes(key)) return true;
  lib.writeJSON(file, list.concat(key).slice(-100));
  return false;
}
