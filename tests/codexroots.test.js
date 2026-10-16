// Codex writable_roots editor (#104): writableRoots reads, adds and removes roots in a config.toml's text, keeps
// the rest byte for byte, does nothing the second time, compares paths as the platform does, and refuses the
// forms it cannot edit safely. Pure text in, text out; no files, no network.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const cx = require(path.join(__dirname, "..", "templates", "hooks", "proteus-harness-codex.js"));
const { writableRoots: wr, samePath } = cx;

const T = (body) => `[sandbox_workspace_write]\n${body}`;

// read
{
  const r = wr(T(`writable_roots = ["/a", '/b', "C:\\\\x"] # mine\n`));
  ok("codex roots: reads basic and literal strings, escapes decoded", JSON.stringify(r.roots) === JSON.stringify(["/a", "/b", "C:\\x"]), JSON.stringify(r));
  ok("codex roots: no file, no table, no key: no roots", [null, "model = \"x\"\n", T("network_access = true\n")].every((t) => JSON.stringify(wr(t).roots) === "[]"));
}

// add, remove, idempotent, the rest kept byte for byte
{
  const text = `# top\nmodel = "x"\r\n\n[sandbox_workspace_write] # sb\nnetwork_access = true\nwritable_roots = [\n  "/a", # one\n  '/b',\n] # end\n\n[other]\ny = 1\n`;
  const add = wr(text, { add: ["/c"] });
  ok("codex roots: add goes in before the ], everything else untouched",
    add.text === text.replace("  '/b',\n]", "  '/b',\n\"/c\"]") && JSON.stringify(add.added) === '["/c"]', JSON.stringify(add.text));
  const again = wr(add.text, { add: ["/c"] });
  ok("codex roots: adding a listed root again changes nothing", again.text === add.text && !again.added.length && again.roots.includes("/c"));
  const rm = wr(text, { remove: ["/a"] });
  ok("codex roots: remove drops the value and its comma, comments stay", rm.text === text.replace(`"/a", `, "") && JSON.stringify(rm.removed) === '["/a"]', JSON.stringify(rm.text));
  ok("codex roots: removing an unlisted root changes nothing", wr(rm.text, { remove: ["/a"] }).text === rm.text);
  const both = wr(T('writable_roots = ["/a", "/b"]\n'), { add: ["/c", "/c"], remove: ["/b"] });
  ok("codex roots: add and remove together, a repeated add listed once", both.text === T('writable_roots = ["/a", "/c"]\n'), both.text);
  ok("codex roots: removing every root leaves an empty array", wr(T('writable_roots = ["/a", "/b"]\n'), { remove: ["/a", "/b"] }).text === T("writable_roots = []\n"));
  ok("codex roots: nothing to add and no file: no file made", wr(null).text === null && wr(null, { remove: ["/a"] }).text === null);
  ok("codex roots: no file: one table made", wr(null, { add: ["/a"] }).text === T('writable_roots = ["/a"]\n'));
  ok("codex roots: a quoted table header is the same table, not a second one",
    wr('["sandbox_workspace_write"]\nnetwork_access = true\n', { add: ["/a"] }).text === '["sandbox_workspace_write"]\nwritable_roots = ["/a"]\nnetwork_access = true\n');
  ok("codex roots: a string holding # or , is a value, not syntax",
    wr(T('writable_roots = ["/a,#", "/b"]\n'), { remove: ["/b"] }).text === T('writable_roots = ["/a,#"]\n'));
}

// paths compared as the platform does
{
  ok("codex roots: linux compares case and separators exactly", !samePath("/A/b", "/a/b", "linux") && samePath("/a/b/", "/a//b", "linux"));
  ok("codex roots: darwin folds case", samePath("/Users/Me/x", "/users/me/X", "darwin"));
  ok("codex roots: win32 folds case and either separator", samePath("C:\\Users\\Me\\x", "c:/users/me/X/", "win32") && !samePath("C:\\a", "D:\\a", "win32"));
  const t = T('writable_roots = ["C:/Users/Me/proj-proteus"]\n');
  ok("codex roots: on win32 a root listed with / and another case is not added again", wr(t, { add: ["c:\\users\\me\\Proj-Proteus"] }, "win32").text === t);
  ok("codex roots: on win32 it is removed whatever its case or separator", wr(t, { remove: ["C:\\USERS\\ME\\PROJ-PROTEUS"] }, "win32").text === T("writable_roots = []\n"));
  ok("codex roots: on linux another case is another folder", wr(T('writable_roots = ["/A"]\n'), { add: ["/a"] }, "linux").text === T('writable_roots = ["/A", "/a"]\n'));
}

// forms it cannot edit safely: refused with a reason, whatever is asked
{
  const odd = {
    "[[sandbox_workspace_write]]\nwritable_roots = []\n": /\[\[sandbox_workspace_write\]\].*make it one/,
    "[[ 'sandbox_workspace_write' ]]\n": /array of tables/,
    "[sandbox_workspace_write]\n[sandbox_workspace_write]\n": /twice/,
    "[sandbox_workspace_write]\n['sandbox_workspace_write']\n": /twice/,
    'sandbox_workspace_write = { writable_roots = ["/a"] }\n': /form/,
    'sandbox_workspace_write.writable_roots = ["/a"]\n': /form/,
    'x = """\n[sandbox_workspace_write]\n"""\n': /multi-line/,
    [T('writable_roots = []\nwritable_roots = ["/x"]\n')]: /writable_roots twice/,
    [T('writable_roots = "/a"\n')]: /other than an array/,
    [T("writable_roots = [1]\n")]: /cannot read/,
    [T('writable_roots = ["/a"\n')]: /unterminated/,
  };
  for (const [t, why] of Object.entries(odd)) {
    const r = [wr(t), wr(t, { add: ["/z"] }), wr(t, { remove: ["/a"] })];
    ok(`codex roots: refused: ${JSON.stringify(t)}`, r.every((x) => typeof x.error === "string" && why.test(x.error) && !("text" in x)), JSON.stringify(r[1]));
  }
}

lib.summary();
