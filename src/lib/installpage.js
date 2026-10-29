// /install — the public product page: every app there is for Aurora, its
// current version and date, how to install it, and what changed lately.
//
// It is open to anyone (no session, also on a server that requires sign-in):
// a TV, a friend's phone, a new laptop meet it before they can sign in. So it
// says NOTHING about the household: no library, no profile names, no counts,
// no server state — only the apps' versions, their dates and sizes, and the
// release notes' headlines, scrubbed (see `scrub` below).
//
// Where the facts come from:
//   Android TV      the APK itself (lib/apkinfo.js, the same file /download
//                   hands over); its date from the CHANGELOG release that
//                   shipped "Aurora TV <version>", else the file's date
//   website/server  package.json, dated by its CHANGELOG release
//   Android phone   public/aurora-phone.apk + public/phone-version.json —
//                   "Coming soon" until that APK exists; the slot lights up
//                   by itself the day a build is copied there
//
// The page is public/install.html with {{tokens}}: {{x}} is escaped text,
// {{{x}}} is HTML built here from escaped parts. Rendered at most once every
// two seconds (lib/assetver.js SHELL_RECHECK_MS) — an edit to the notes or a
// new APK shows on the next load.
const fs = require("fs");
const path = require("path");
const apkinfo = require("./apkinfo");

const ROOT = path.join(__dirname, "..", "..");
const PUBLIC = path.join(ROOT, "public");
const TV_APK = path.join(PUBLIC, "aurora-tv.apk");
const PHONE_APK = path.join(PUBLIC, "aurora-phone.apk");
const PHONE_JSON = path.join(PUBLIC, "phone-version.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const isoDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

// ---------- the release notes ----------
// "## <version> — <date>" headings, "- " bullets (the shape /api/changelog reads).
const parseChangelog = (text) => {
  const releases = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^##\s+([^\s—–-]+)(?:\s*[—–-]\s*(.+))?$/.exec(line);
    if (h) {
      cur = { version: h[1], date: (h[2] || "").trim() || null, items: [] };
      releases.push(cur);
      continue;
    }
    // (an indented bullet belongs to the one above it: a TV release's points)
    const b = /^[-*]\s+(.+)$/.exec(line);
    if (b && cur) cur.items.push({ text: b[1], sub: /^\s+[-*]/.test(raw) });
  }
  return releases;
};

// A bullet's readable headline: the **bold lead** when it has one, else its
// first sentence (or up to the first dash) — no parentheses (where names and
// measurements live), no code, at most ~170 characters.
const shorten = (t) => {
  const stops = [/[.!?](?=\s|$)/.exec(t), /\s[—–]\s/.exec(t)].filter(Boolean).map((m) => m.index + (/^[.!?]/.test(m[0]) ? 1 : 0));
  return stops.length ? t.slice(0, Math.min(...stops)) : t;
};
const tidy = (t) =>
  String(t)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s*\([^()]*\)/g, "")
    .replace(/\s*\([^()]*\)/g, "") // (one nesting level)
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
const finish = (t) => {
  t = t.replace(/^[\s,;:.—–-]+/, "").replace(/[\s,;:—–-]+$/, "");
  if (t.length > 170) t = t.slice(0, 167).replace(/\s+\S*$/, "").replace(/[,;:—–-]+$/, "") + "…";
  if (t && !/[.!?…]$/.test(t)) t += ".";
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};
const headline = (item) => {
  const s = String(item);
  const bold = /^\*\*(.+?)\*\*/.exec(s);
  if (bold) return finish(tidy(bold[1]));
  return finish(shorten(tidy(s.replace(/\*\*/g, ""))));
};
// A TV bullet ("**Aurora TV 5.7.1** (checked on …): the TV player now …",
// "**Aurora TV 5.1.25 — smoother on weak boxes.** Tested …", "Aurora TV
// 5.1.22: the logo …"): what it says after its version.
const tvHeadline = (item) => {
  const t = tidy(String(item).replace(/\*\*/g, "")).replace(/^Aurora TV \d+\.\d+\.\d+/, "");
  return finish(shorten(t.replace(/^[\s,;:.—–-]+/, "")));
};

// What must never reach this page: the household's own words. A headline
// that names a profile (name, real name, username) or a title in the library
// is dropped whole — a release note may say "On <a show here> every intro is
// found", and this page is read by strangers. A "<Name>'s report" is dropped
// too (someone outside the profile list).
const wordRe = (w, flags) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, flags);
const householdWords = () => {
  const names = new Set();
  const titles = new Set();
  try {
    for (const p of require("../profiles").list()) {
      for (const v of [p.name, p.realName, p.username]) {
        const s = String(v || "").trim();
        if (s.length >= 2) names.add(s);
        for (const part of s.split(/\s+/)) if (part.length >= 3) names.add(part);
      }
    }
  } catch {}
  try {
    const { index } = require("../media/scanner");
    for (const t of [...(index.movies || []), ...(index.shows || [])]) {
      const s = String((t && t.title) || "").trim();
      if (s.length >= 3) titles.add(s);
    }
  } catch {}
  let ready = false;
  try { ready = !!require("../media/scanner").index.scannedAt; } catch {}
  return { ready, names: [...names].map((n) => wordRe(n, "iu")), titles: [...titles].map((t) => wordRe(t, "u")) };
};
const scrub = (lines, words) =>
  lines.filter((t) => t &&
    !/\b\p{Lu}\p{Ll}+['’]s (report|phone|TV|server|request)\b/u.test(t) &&
    !/\btools\/|\btests?\b|\bCI\b|\.js\b/.test(t) && // (notes for developers, not for this page)
    !words.names.some((re) => re.test(t)) &&
    !words.titles.some((re) => re.test(t)));

const TV_RE = /\*\*Aurora TV (\d+\.\d+\.\d+)\b|^Aurora TV (\d+\.\d+\.\d+)\b/;
const tvVersionIn = (item) => { const m = TV_RE.exec(String(item)); return m ? m[1] || m[2] : null; };

// The TV's releases: one per "Aurora TV x.y.z" bullet, headline = what follows
// the version.  The website's: every release, minus the TV bullets.
const notesFrom = (releases, words) => {
  const tv = [];
  const web = [];
  const NOT_NEWS = /^(Checked|Tested)\b/;
  for (const r of releases) {
    const webItems = [];
    let tvOpen = null; // the TV release whose indented points follow
    for (const { text, sub } of r.items) {
      if (sub) {
        if (tvOpen && tvOpen.items.length < 4) tvOpen.items.push(...scrub([headline(text)], words));
        else if (!tvOpen) webItems.push(headline(text));
        continue;
      }
      tvOpen = null;
      const v = tvVersionIn(text);
      if (!v) { webItems.push(headline(text)); continue; }
      if (tv.some((x) => x.version === v)) continue;
      const own = tvHeadline(text);
      tvOpen = { version: v, date: r.date, items: own.length > 6 && !NOT_NEWS.test(own) ? scrub([own], words) : [] };
      tv.push(tvOpen);
    }
    const items = scrub(webItems, words).slice(0, 4);
    if (items.length) web.push({ version: r.version, date: r.date, items });
  }
  // (a TV release with nothing to say still dates its version — facts() below)
  return { tv, web, tvShown: tv.filter((x) => x.items.length) };
};

// ---------- the facts ----------
const facts = () => {
  let releases = [];
  try { releases = parseChangelog(fs.readFileSync(CHANGELOG, "utf8")); } catch {}
  const words = householdWords();
  // Before the library has been read once, its titles are not known and
  // cannot be kept out: no notes until then (and the page is not kept).
  const notes = words.ready ? notesFrom(releases, words) : { tv: [], web: [], tvShown: [] };
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")); } catch {}
  const webRel = releases.find((r) => r.version === pkg.version);
  const web = { version: pkg.version || null, date: (webRel && webRel.date) || null };

  const apk = apkinfo.read(TV_APK, { hash: false });
  let tv = null;
  if (!apk.error) {
    const shipped = notes.tv.find((n) => n.version === apk.versionName);
    tv = { version: apk.versionName, sizeBytes: apk.sizeBytes, date: (shipped && shipped.date) || isoDay(apk.mtimeMs) };
  }

  // The phone app: lights up once its APK is published beside the TV's.
  let phone = null;
  if (fs.existsSync(PHONE_APK)) {
    const info = apkinfo.read(PHONE_APK, { hash: false });
    const json = readJson(PHONE_JSON) || {};
    if (!info.error) {
      phone = { version: info.versionName, sizeBytes: info.sizeBytes, date: json.date || isoDay(info.mtimeMs) };
      // its notes, when phone-version.json was written for this build (as /phone-version.json says them)
      const said = typeof json.notes === "string" && json.notes.trim() && (!json.versionName || json.versionName === info.versionName)
        ? scrub([finish(tidy(json.notes))], words) : [];
      phone.notes = said.length ? [{ version: phone.version, date: phone.date, items: said }] : [];
    }
  }
  return { web, tv, phone, notes, complete: words.ready };
};

// ---------- the page ----------
const mb = (n) => (n ? `${Math.max(1, Math.round(n / (1024 * 1024)))} MB` : "");
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return iso || "";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
};
const versionLine = (v) => (v ? `Version ${esc(v.version)}${v.date ? ` · <time datetime="${esc(v.date)}">${esc(fmtDate(v.date))}</time>` : ""}` : "");

const notesHtml = (list, { max = 3, empty = "Nothing here yet." } = {}) => {
  const shown = list.slice(0, max);
  if (!shown.length) return `<p class="notes-empty">${esc(empty)}</p>`;
  return shown.map((r) =>
    `<article class="release"><h4><span class="release-v">${esc(r.version)}</span>${r.date ? `<time datetime="${esc(r.date)}">${esc(fmtDate(r.date))}</time>` : ""}</h4>` +
    `<ul>${r.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></article>`).join("");
};

const values = (f, req) => {
  // The address to type into Downloader: this site's own, as the browser
  // reached it (the page corrects it from location on load, so a proxy that
  // rewrites Host cannot make it wrong for long).
  const host = String((req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "").split(",")[0].trim().replace(/[^A-Za-z0-9.:\-[\]]/g, "");
  return {
    "web.version": f.web.version || "",
    "web.line": versionLine(f.web),
    "tv.state": f.tv ? "ready" : "none",
    "tv.version": f.tv ? f.tv.version : "",
    "tv.line": f.tv ? versionLine(f.tv) : "Not published on this server yet",
    "tv.size": f.tv ? mb(f.tv.sizeBytes) : "",
    "phone.state": f.phone ? "ready" : "soon",
    "phone.line": f.phone ? versionLine(f.phone) : "Coming soon",
    "phone.short": f.phone ? f.phone.version : "soon",
    "phone.size": f.phone ? mb(f.phone.sizeBytes) : "",
    host: host || "this-server",
    "notes.tv": notesHtml(f.notes.tvShown, { empty: "The TV app's notes appear here with its next release." }),
    "notes.web": notesHtml(f.notes.web),
    "notes.phone": f.phone ? notesHtml(f.phone.notes || [], { empty: "The phone app's notes appear here with its next release." }) : `<p class="notes-empty">The Android phone app is on its way — its notes start here with the first release.</p>`,
    "notes.all.tv": notesHtml(f.notes.tvShown, { max: 1000 }),
    "notes.all.web": notesHtml(f.notes.web, { max: 1000 }),
    year: String(new Date().getFullYear()),
  };
};

// Raw HTML values (built from escaped parts above) — everything else is text.
const RAW = new Set(["web.line", "tv.line", "phone.line", "notes.tv", "notes.web", "notes.phone", "notes.all.tv", "notes.all.web"]);
const render = (name, req) => {
  const assetver = require("./assetver");
  const f = facts();
  const vals = values(f, req);
  const raw = fs.readFileSync(path.join(PUBLIC, name), "utf8");
  // {{x}} for text, {{{x}}} for the HTML values: a template that asks for a
  // raw value as text gets it escaped (safe either way round)
  const html = raw
    .replace(/\{\{\{([\w.]+)\}\}\}/g, (m, k) => (RAW.has(k) && k in vals ? String(vals[k]) : esc(vals[k] || "")))
    .replace(/\{\{([\w.]+)\}\}/g, (m, k) => (k in vals ? (RAW.has(k) ? String(vals[k]) : esc(vals[k])) : ""));
  const out = html.replace(/href="(\/css\/[^"?]+\.css)"/g, (whole, href) => {
    const v = assetver.versionFor(path.join(PUBLIC, href.replace(/^\//, "")));
    return v ? `href="${href}?v=${v}"` : whole;
  });
  return { html: out, complete: f.complete };
};

const kept = new Map(); // name|host -> { at, html }
const send = (name) => (req, res) => {
  const { SHELL_RECHECK_MS } = require("./assetver");
  const key = `${name}|${req.headers["x-forwarded-host"] || req.headers.host || ""}`;
  let hit = kept.get(key);
  if (!hit || Date.now() - hit.at > SHELL_RECHECK_MS) {
    try {
      const r = render(name, req);
      hit = { at: r.complete ? Date.now() : 0, html: r.html };
    } catch {
      kept.delete(key);
      return res.status(404).type("text/plain").send("Not found");
    }
    if (kept.size > 20) kept.clear();
    kept.set(key, hit);
  }
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(hit.html);
};

module.exports = { send, facts, render, _internals: { parseChangelog, headline, tvHeadline, notesFrom, scrub, householdWords, wordRe, fmtDate, tvVersionIn } };
