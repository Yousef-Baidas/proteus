#!/usr/bin/env node
// UserPromptSubmit hook for the lead's session (main checkout, main thread).
// 1. Journals every human message to <git-common-dir>/proteus/journal.jsonl (last 500 kept), verbatim
//    but for secrets (tokens, keys, private key blocks, password=… ; lib.redact), which become
//    [redacted]; the autostart re-injects the newest ten after a compaction.
// 2. Nudges the lead to log decisions to the run log.
// 3. Context meter: at PROTEUS_HANDOFF_AT tokens or above (default 75% of the lead's context window,
//    lib.handoffLines: 150000 on a 200k window), tells the lead to hand off.
// Silent for PROTEUS=0, subagents, and linked worktrees.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const KEEP = 500;

if (process.env.PROTEUS === "0") process.exit(0);

lib.run((ev, ad) => {
  const root = lib.projectRoot(ev);
  if (!lib.isLead(ev, root)) return;
  const prompt = ev.prompt;
  const out = [];

  // task notifications, loop wakeups and peer messages arrive here too; they are not the human
  if (ev.fromHuman && prompt.trim()) {
    const common = lib.gitCommonDir(root);
    if (common) journal(path.join(lib.stateDir(common), "journal.jsonl"), { ts: new Date().toISOString(), session_id: ev.session, prompt: lib.redact(prompt) });
    if (prompt.length > 40 && !prompt.trimStart().startsWith("/"))
      out.push("proteus: if this message holds a decision, correction, or taste note, log it as one line on the run log before acting.");
  }

  const q = questionsNudge(root);
  if (q) out.push(q);

  const ctx = ad.contextTokens(ev);
  if (ctx && ctx >= lib.handoffLines(ev, root).at)
    out.push(`proteus: context at ${Math.round(ctx / 1000)}k. Finish the current step, log position to the run log, then /handoff and start a fresh lead.`);

  if (out.length) ad.context(ev, out.join("\n"), "prompt");
});

// open questions from the inbox cache, at most once per 10 minutes
function questionsNudge(root) {
  const common = lib.gitCommonDir(root);
  const inbox = common && lib.readInbox(common);
  if (!inbox || !inbox.questions.length) return "";
  const stamp = path.join(lib.stateDir(common), "questions-nudged");
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < 10 * 60 * 1000) return ""; } catch {}
  fs.writeFileSync(stamp, new Date().toISOString() + "\n");
  return `open questions: ${inbox.questions.map((i) => "#" + i.n).join(", ")} (answer via /proteus-review or type questions)`;
}

function journal(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  // a record is at least 60 bytes, so a smaller file cannot hold more than KEEP lines
  if (fs.statSync(file).size < KEEP * 60) return;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length <= KEEP) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.slice(-KEEP).join("\n") + "\n");
  fs.renameSync(tmp, file);
}
