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
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
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

// ---------------------------------------------------------------------------
// With the import map (src/lib/jsassets.js, src/lib/assetver.js) "resolves"
// means more than "the file is there".
//
// The page hands the browser a map from every module's plain address
// (/js/ui.js) to a content-addressed one (/js/ui.js?v=<hash>), and the browser
// applies it to every specifier — static or dynamic — after turning it into a
// URL. An import lands on the cached, SHARED copy of a module only when that
// URL is a key of the map, spelled as the map spells it. One that misses (a
// query on the specifier, a file the server's list does not know) is fetched
// under a second address and runs as a second instance of the module: two
// `state` objects, two sockets, nothing failing loudly. And the code that goes
// over the wire is not the file as written but its re-print (comments and
// layout gone, when esbuild is installed): the names its importers ask for
// must still be exported by THAT text.
const jsassets = require("../src/lib/jsassets");
const assetver = require("../src/lib/assetver");
const PUBLIC = path.join(__dirname, "..", "public");
const urlOf = (file) => "/js/" + path.relative(ROOT, file).split(path.sep).join("/");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

// Every module a file names, however it names it:
//   static     import … from "./x.js" · import "./x.js" · export … from "./x.js"
//   dynamic    import("./x.js")
//   by name    lazy("./screens/x.js", …) and lists handed to import() later
//              (["./screens/a.js", "./screens/b.js"]) — any quoted "./….js"
const specifiersOf = (source) => {
  const s = noComments(source);
  const out = new Set();
  for (const m of s.matchAll(/(?:^|[;\s])(?:import|export)\s*(?:[^"'`()]*?\sfrom\s*)?["']([^"']+)["']/g)) out.add(m[1]);
  for (const m of s.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.add(m[1]);
  for (const m of s.matchAll(/["'`](\.{1,2}\/[^"'`\s]*\.js[^"'`\s]*)["'`]/g)) out.add(m[1]);
  return [...out];
};

test("every module the site names, statically or dynamically, is a key of the import map — so it has one address and one instance", () => {
  const map = jsassets.importMap(PUBLIC);
  const keys = new Set(Object.keys(map));
  assert.deepEqual([...keys].sort(), files.map(urlOf).sort(), "the map is every module on disk, no more and no less");
  const problems = [];
  let relative = 0;
  for (const file of files) {
    if (/[\\/]vendor[\\/]/.test(file)) continue; // (built elsewhere; they import nothing of the site's)
    const from = urlOf(file);
    for (const spec of specifiersOf(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) {
        // an absolute address works only when it is exactly a key; a bare name ("lodash") nothing here can resolve
        if (!(spec.startsWith("/js/") && keys.has(spec)) && !/^https?:/.test(spec)) problems.push(`${from}: "${spec}" is neither relative nor a module of the site`);
        continue;
      }
      relative++;
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      if (/[?#]/.test(spec)) problems.push(`${from}: "${spec}" carries a query — it would miss the import map and load a second copy`);
      else if (!keys.has(to)) problems.push(`${from}: "${spec}" → ${to} is not a module the server lists`);
      else if (map[to] !== `${to}?v=${jsassets.asset(PUBLIC, to).hash}`) problems.push(`${from}: ${to} is mapped to something other than its own hash`);
    }
  }
  assert.ok(relative > 150, `${relative} specifiers were read`);
  assert.deepEqual(problems, []);
});

test("the server's own reading of the imports (the preload list, the offline copy) misses none that the files have", () => {
  // jsassets reads static imports with a pattern of its own; anything it
  // misses is a module fetched a round trip late, and — when its file moves —
  // a preload of something that is not there
  const problems = [];
  for (const file of files) {
    if (/[\\/]vendor[\\/]/.test(file)) continue;
    const from = urlOf(file);
    const s = noComments(fs.readFileSync(file, "utf8"));
    const statics = new Set();
    for (const m of s.matchAll(/(?:^|[;\s])(?:import|export)\s*(?:[^"'`()]*?\sfrom\s*)?["'](\.[^"']+)["']/g)) statics.add(path.posix.normalize(path.posix.join(path.posix.dirname(from), m[1])));
    const seen = new Set(jsassets.asset(PUBLIC, from).imports);
    for (const to of statics) if (!seen.has(to)) problems.push(`${from}: jsassets does not see its import of ${to}`);
    for (const to of seen) if (!statics.has(to)) problems.push(`${from}: jsassets sees an import of ${to} that is not there`);
  }
  assert.deepEqual(problems, []);
  // the preload list for boot, and for each address that names a screen, is closed under those imports
  const lists = [assetver.BOOT_ENTRIES, ...assetver.routeEntries(PUBLIC).map(([, entry]) => [entry])];
  assert.ok(lists.length > 8);
  for (const entries of lists) {
    const all = jsassets.closure(PUBLIC, entries);
    for (const url of all) for (const dep of jsassets.asset(PUBLIC, url).imports) assert.ok(all.includes(dep), `${entries[0]}: ${url} -> ${dep} is not preloaded`);
  }
});

test("the code as SERVED (re-printed, when esbuild is there) still exports every name its importers ask for", () => {
  const served = (url) => jsassets.asset(PUBLIC, url).body.toString("utf8");
  const exportsOfText = (s) => {
    const out = new Set();
    for (const m of s.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
    for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(",")) if (n.trim()) out.add(n.trim().split(/\s+as\s+/).pop());
    if (/export\s+default/.test(s)) out.add("default");
    return out;
  };
  const problems = [];
  let checked = 0;
  for (const file of files) {
    if (/[\\/]vendor[\\/]/.test(file)) continue;
    const from = urlOf(file);
    const text = served(from);
    // what was exported as written is exported as served
    for (const name of exportsOf(file)) if (!exportsOfText(text).has(name)) problems.push(`${from}: "${name}" is exported by the file but not by what is served`);
    // named imports, as the served text spells them: import{a,b as c}from"./x.js"
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), m[2]));
      const have = exportsOfText(served(to));
      for (const n of m[1].split(",")) {
        const name = n.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        checked++;
        if (!have.has(name)) problems.push(`${from} (as served): ${to} has no export "${name}"`);
      }
    }
    // a screen loaded by name: lazy("./screens/x.js", "renderX")
    for (const m of text.matchAll(/\blazy\(\s*["'](\.[^"']+)["']\s*,\s*["']([A-Za-z_$][\w$]*)["']\s*\)/g)) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), m[1]));
      checked++;
      if (!exportsOfText(served(to)).has(m[2])) problems.push(`${from}: lazy(${m[1]}) asks for "${m[2]}", which ${to} does not export`);
    }
  }
  assert.ok(checked > 300, `${checked} imported names were checked`);
  assert.deepEqual(problems, []);
});
