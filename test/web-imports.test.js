// Every named import between the website's own modules must exist. Browsers
// refuse a module whose import is missing — the whole screen then never loads —
// and nothing else in the unit suite notices: two branches merged cleanly in
// git while one renamed a helper in ui.js that the other still imported, and
// the person sheet was dead until a browser test ran (2026-10-10).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "public", "js");
const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".js")) files.push(p);
  }
})(ROOT);

const exportsOf = (file) => {
  const s = fs.readFileSync(file, "utf8");
  const out = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(",")) if (n.trim()) out.add(n.trim().split(/\s+as\s+/).pop());
  if (/export\s+default/.test(s)) out.add("default");
  return out;
};

test("the website's modules only import names their sources export", () => {
  assert.ok(files.length > 20, "found the website's scripts");
  const problems = [];
  for (const file of files) {
    const s = fs.readFileSync(file, "utf8");
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (!m[2].startsWith(".")) continue;
      const target = path.join(path.dirname(file), m[2].split("?")[0]);
      const rel = path.relative(ROOT, file).replace(/\/g, "/");
      if (!fs.existsSync(target)) {
        problems.push(`${rel}: ${m[2]} does not exist`);
        continue;
      }
      const have = exportsOf(target);
      for (const n of m[1].split(",")) {
        const name = n.trim().split(/\s+as\s+/)[0];
        if (name && !have.has(name)) problems.push(`${rel}: ${m[2]} has no export "${name}"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
