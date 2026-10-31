#!/usr/bin/env node
// PostToolUse hook for the human's verdict in local mode (#310): after the main thread's successful run of a post the
// permission dialog showed, lib.recordPosted appends that post to the verdict record from its pending entry. It runs
// outside the sandbox, where proteus-verdict.js --post cannot write the record. PROTEUS=0 sessions run it too: the
// human's review session is where verdicts go out.
// Exit 0 always; a record that could not be written reaches the model as feedback.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

lib.run((ev, ad) => {
  try { lib.recordPosted(ev); } catch (e) { ad.postBlock(ev, `proteus: the human's verdict was not recorded (${e.message}), so it does not count; tell the human.`); }
});
