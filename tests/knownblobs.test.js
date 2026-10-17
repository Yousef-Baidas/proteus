// Known shipped blobs (#154): node tests/knownblobs.test.js (needs git and the full history of main).
// scripts/known-blobs.json must equal what scripts/known-blobs.js computes from git log, so a PR that changes a
// shipped file under agents/ or templates/ regenerates it. A shallow clone cannot compute it and fails loudly.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const kb = require(path.join(ROOT, "scripts", "known-blobs.js"));

const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
ok("history: the clone is not shallow (known-blobs needs every commit)", shallow === "false", shallow);
let want = null, err = "";
try { want = kb.render(kb.compute(ROOT)); } catch (e) { err = e.message; }
const have = fs.readFileSync(kb.FILE, "utf8").replace(/\r\n/g, "\n");
ok("known-blobs.json is current (else run: node scripts/known-blobs.js)", want !== null && have === want, err || "stale");
const j = JSON.parse(have);
ok("it lists hook and agent paths, ids as sha1 hex", Object.keys(j.blobs).some((p) => p.startsWith("templates/hooks/")) && Object.keys(j.blobs).some((p) => p.startsWith("agents/")) &&
  Object.values(j.blobs).every((ids) => ids.length && ids.every((id) => /^[0-9a-f]{40}$/.test(id))));
ok("it keeps the past team file texts setup uses as .base", Object.keys(j.texts).includes("templates/teams/ROUTING.md") &&
  Object.entries(j.texts).every(([p, t]) => Object.keys(t).every((id) => j.blobs[p].includes(id))));
lib.summary();
