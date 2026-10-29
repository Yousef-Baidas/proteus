// Ready-set tests: node tests/ready.test.js. proteus-ready.js's readySet is pure, so no gh and no git.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const { readySet, overlaps } = require(path.join(__dirname, "..", "templates", "hooks", "proteus-ready.js"));

const t = (n, o = {}) => ({ n, team: "backend", difficulty: "standard", open: true, milestone: "r1/core", deps: [], owned: [`src/t${n}.js`], inFlight: false, ...o });
const show = (r) => JSON.stringify(r);

// dependency chain 1 → 2 → 3: only the head is ready until 1 merges
let r = readySet([t(1), t(2, { deps: [1] }), t(3, { deps: [2], team: "frontend", difficulty: "hard" })]);
ok("chain: only the ticket with no open depends-on is ready", show(r.ready) === show([{ n: 1, team: "backend", difficulty: "standard", speculative: false }]), show(r));
ok("chain: the rest wait on the ticket before them", show(r.blocked) === show([{ n: 2, reason: "waits on #1" }, { n: 3, reason: "waits on #2" }]), show(r));
r = readySet([t(1, { open: false }), t(2, { deps: [1] }), t(3, { deps: [2], team: "frontend", difficulty: "hard" })]);
ok("chain: #1 merged makes #2 ready, #3 still waits", r.ready.map((x) => x.n).join() === "2" && show(r.blocked) === show([{ n: 3, reason: "waits on #2" }]), show(r));
r = readySet([t(4, { deps: [99] })]);
ok("chain: a depends-on outside the run waits", show(r.blocked) === show([{ n: 4, reason: "waits on #99" }]), show(r));

// path collision with a ticket in flight, glob-aware
r = readySet([t(1, { inFlight: true, owned: ["src/api/**"] }), t(2, { owned: ["src/api/users.js"] }), t(3, { owned: ["src/web/*"] }), t(5, { owned: [] })]);
ok("collision: a path under an in-flight glob is blocked with both paths named", show(r.blocked[0]) === show({ n: 2, reason: "src/api/users.js overlaps src/api/** of #1 in flight" }), show(r));
ok("collision: a disjoint ticket is ready, the in-flight one is not listed", r.ready.map((x) => x.n).join() === "3" && !r.blocked.some((b) => b.n === 1), show(r));
ok("collision: no owned paths is blocked", r.blocked.some((b) => b.n === 5 && b.reason === "no owned paths recorded"), show(r));
ok("overlaps: globs both ways, disjoint extensions do not", overlaps("src/*", "src/a/b.js") && overlaps("src/a.js", "src/") && overlaps("**/auth/**", "lib/auth/x.js") && !overlaps("src/*.js", "src/*.ts"));

// speculative during review: r1/core is under review, its tickets merged; r1/next tickets are speculative
const review = [t(1, { open: false, owned: ["src/core/**"] }), t(6, { milestone: "r1/next", owned: ["src/core/util.js"] }), t(7, { milestone: "r1/next", owned: ["docs/"], deps: [1] })];
r = readySet(review, ["r1/core"]);
ok("review: a next-milestone ticket missing the reviewed paths is ready and marked speculative", show(r.ready) === show([{ n: 7, team: "backend", difficulty: "standard", speculative: true }]), show(r));
ok("review: one touching the milestone under review is blocked", show(r.blocked) === show([{ n: 6, reason: "src/core/util.js overlaps src/core/** of #1 in r1/core under review" }]), show(r));
r = readySet(review);
ok("no review: the same ticket is ready and not speculative", r.ready.map((x) => `${x.n}${x.speculative}`).join() === "6false,7false", show(r));

lib.summary();
