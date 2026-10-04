#!/usr/bin/env node
// gh with backoff, for writes: node <hooks>/proteus-gh.js <gh args...> (comments, issue and PR creates, reviews).
// GitHub's secondary limits (docs.github.com, rate limits for the REST API): about 80 content-creating requests a
// minute and 500 an hour. A refused write is retried, not dropped: after `retry-after` seconds when gh shows it,
// else at least a minute, doubling, with jitter. Output and exit code are gh's from the last attempt.
// Env: PROTEUS_GH_ATTEMPTS (5), PROTEUS_GH_BASE_S (60), PROTEUS_GH_MAX_WAIT_S (600 total sleep; a wait past it ends the retries).
"use strict";
const { spawnSync } = require("child_process");

const num = (name, dflt) => { const n = parseFloat(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : dflt; };
const LIMITED = /secondary rate limit|abuse (detection|rate)|HTTP 429|too many requests|retry-after:?\s*\d/i;
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(s * 1000));

function main(args) {
  // a body piped in (--body-file -, --input -) is read once so every attempt can send it again
  const stdin = args.some((a) => a === "-" || /[=@]-$/.test(a)) ? require("fs").readFileSync(0) : undefined;
  const attempts = Math.max(1, Math.floor(num("PROTEUS_GH_ATTEMPTS", 5)));
  const base = num("PROTEUS_GH_BASE_S", 60), cap = num("PROTEUS_GH_MAX_WAIT_S", 600);
  let slept = 0;
  for (let n = 1; ; n++) {
    const r = spawnSync("gh", args, { input: stdin, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.error) { console.error(`proteus-gh: cannot run gh: ${r.error.message}`); return 1; }
    const text = `${r.stdout}\n${r.stderr}`;
    const limited = r.status !== 0 && LIMITED.test(text);
    const ra = /retry-after:?\s*(\d+)/i.exec(text);
    const wait = ra ? +ra[1] + Math.random() : base * 2 ** (n - 1) * (0.5 + Math.random() / 2);
    if (!limited || n >= attempts || slept + wait > cap) {
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      return r.status ?? 1;
    }
    console.error(`proteus-gh: rate limited, retry ${n}/${attempts - 1} in ${wait.toFixed(1)}s`);
    sleep(wait);
    slept += wait;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
