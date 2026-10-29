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
//   the Download    lib/releases.js, the one list of every release (its
//   tiles           file, version, size, date and SHA-256), drawn here with
//                   lib/platform-icons.js; the ones not made yet go on a
//                   quiet "Coming later" line
//
// The page is public/install.html with {{tokens}}: {{x}} is escaped text,
// {{{x}}} is HTML built here from escaped parts. Rendered at most once every
// two seconds (lib/assetver.js SHELL_RECHECK_MS) — an edit to the notes or a
// new APK shows on the next load.
const fs = require("fs");
const path = require("path");
const apps = require("./releases"); // (the one list of releases)
const { icon } = require("./platform-icons");

const ROOT = path.join(__dirname, "..", "..");
const PUBLIC = path.join(ROOT, "public");
const PHONE_JSON = path.join(PUBLIC, "phone-version.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

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

  // The apps with a file (lib/releases.js — the one list): read once, for
  // the Download tiles and the cards below them alike.
  const dateFor = (entry, version) =>
    entry.dated === "changelog" ? ((notes.tv.find((n) => n.version === version) || {}).date || null)
      : entry.kind === "web" || entry.kind === "webapp" ? web.date : null;
  const downloads = apps.list({ dateFor });
  const byId = (id) => downloads.find((r) => r.id === id && r.state === "available");

  const t = byId("tv");
  const tv = t ? { version: t.version, sizeBytes: t.sizeBytes, date: t.date } : null;

  // The phone app: lights up once its APK is published beside the TV's.
  let phone = null;
  const ph = byId("phone");
  if (ph) {
    const json = readJson(PHONE_JSON) || {};
    phone = { version: ph.version, sizeBytes: ph.sizeBytes, date: ph.date };
    // its notes, when phone-version.json was written for this build (as /phone-version.json says them)
    const said = typeof json.notes === "string" && json.notes.trim() && (!json.versionName || json.versionName === ph.version)
      ? scrub([finish(tidy(json.notes))], words) : [];
    phone.notes = said.length ? [{ version: phone.version, date: phone.date, items: said }] : [];
  }
  // (a checksum still being worked out: this page is not kept, the next one has it)
  const hashed = downloads.every((r) => r.kind !== "file" || r.state !== "available" || r.sha256);
  return { web, tv, phone, notes, downloads, complete: words.ready && hashed };
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

// ---------- the Download section ----------
// One tile per release that can be had today: the whole upper part is ONE
// link — a file downloads at once (its own name, from /download/<id>/latest),
// the website opens, the iPhone's goes to its steps. Under it, small: how to
// install, the release notes, and for a file its SHA-256 ("Verify"). The
// visitor's own device is moved first by the page (data-for, install.html).
const NOTES_TAB = { tv: "tab-tv", phone: "tab-phone", web: "tab-web" };
const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
const OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h13M13 7l5 5-5 5"/></svg>';
// (the link's type hint, by the file's kind; one not listed gets none)
const FILE_TYPES = { apk: "application/vnd.android.package-archive", exe: "application/vnd.microsoft.portable-executable", msi: "application/x-msi", dmg: "application/x-apple-diskimage", AppImage: "application/x-executable", deb: "application/vnd.debian.binary-package" };
const twoWay = (long, short) => `<span class="l">${esc(long)}</span><span class="s">${esc(short)}</span>`;
const tileHtml = (r) => {
  const isFile = r.kind === "file";
  const bits = isFile ? [r.version, mb(r.sizeBytes)] : [r.version ? `Version ${r.version}` : ""];
  const meta = bits.filter(Boolean).map(esc).join(" · ");
  const type = isFile && FILE_TYPES[(/\.(\w+)$/.exec(r.filename || "") || [])[1]];
  const label = isFile
    ? `Download Aurora for ${r.name}, version ${r.version}${r.sizeBytes ? `, ${mb(r.sizeBytes)}` : ""}`
    : r.kind === "web" ? `Open Aurora in the browser, version ${r.version || ""}`.trim() : `Aurora on ${r.name}: ${r.action}`;
  const hit =
    `<a class="dl-hit" href="${esc(r.href)}"${isFile ? ` download="${esc(r.filename)}"${type ? ` type="${type}"` : ""}` : ""} aria-label="${esc(label)}">` +
      `<span class="dl-top"><span class="dl-icon">${icon(r.icon)}</span><span class="dl-here">This device</span></span>` +
      `<span class="dl-name">${esc(r.name)}</span>` +
      (r.detail ? `<span class="dl-detail">${esc(r.detail)}</span>` : "") +
      `<span class="dl-meta">${meta}${r.date ? ` <time datetime="${esc(r.date)}">${esc(fmtDate(r.date))}</time>` : ""}</span>` +
      `<span class="dl-go">${isFile ? DOWN : OPEN}${r.short ? twoWay(r.action, r.short) : `<span>${esc(r.action)}</span>`}</span>` +
    `</a>`;
  const more = [];
  if (r.steps && r.kind !== "webapp") more.push(`<a href="${esc(r.steps)}">${twoWay("How to install", "Steps")}</a>`);
  if (r.notes && NOTES_TAB[r.notes]) more.push(`<a href="#new" data-notes="${NOTES_TAB[r.notes]}">${twoWay("Release notes", "Notes")}</a>`);
  if (r.installable) more.push(`<button class="install-pwa" type="button" hidden>${twoWay("Install app", "Install")}</button>`);
  if (isFile && r.sha256) {
    more.push(
      `<details class="dl-verify"><summary>Verify</summary>` +
        `<div class="dl-sum" role="group" aria-label="Checksum of ${esc(r.filename)}">` +
          `<span class="dl-file">${esc(r.filename)}</span>` +
          `<span class="dl-alg">SHA-256</span>` +
          `<code id="sha-${esc(r.id)}">${esc(r.sha256)}</code>` +
          `<button class="copy" type="button" data-copy="sha-${esc(r.id)}" aria-label="Copy the SHA-256 of ${esc(r.filename)}">Copy</button>` +
        `</div></details>`);
  }
  return `<li class="dl" data-id="${esc(r.id)}" data-family="${esc(r.family)}" data-for="${esc(r.for.join(" "))}">${hit}` +
    (more.length ? `<div class="dl-more">${more.join("")}</div>` : "") + `</li>`;
};
const laterHtml = (list) => {
  if (!list.length) return "";
  return `<div class="dl-later"><p class="dl-later-t" id="dl-later-t">Coming later</p><ul aria-labelledby="dl-later-t">` +
    list.map((r) => `<li data-id="${esc(r.id)}">${icon(r.icon)}<span>${esc(r.name)}</span></li>`).join("") + `</ul></div>`;
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
    "downloads": f.downloads.filter((r) => r.state === "available").map(tileHtml).join(""),
    // (a file not published yet joins the planned ones, quietly)
    "downloads.later": laterHtml(f.downloads.filter((r) => r.state !== "available")),
    year: String(new Date().getFullYear()),
  };
};

// Raw HTML values (built from escaped parts above) — everything else is text.
const RAW = new Set(["downloads", "downloads.later", "web.line", "tv.line", "phone.line", "notes.tv", "notes.web", "notes.phone", "notes.all.tv", "notes.all.web"]);
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

const kept = new Map(); // name|host -> { at, html, files }
// What the published files are right now (each one's size and time): a page drawn for other
// files is drawn again, even inside its two seconds — a build published or taken away shows at
// once (and a checksum already known for a copy with the same size and time can no longer
// keep a page that names a file that is gone).
const filesNow = () => apps.RELEASES.filter((e) => e.kind === "file" && !e.planned).map((e) => {
  try { const st = fs.statSync(path.join(ROOT, e.file)); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return "-"; }
}).join("|");
const send = (name) => (req, res) => {
  const { SHELL_RECHECK_MS } = require("./assetver");
  const key = `${name}|${req.headers["x-forwarded-host"] || req.headers.host || ""}`;
  let hit = kept.get(key);
  const files = filesNow();
  if (!hit || Date.now() - hit.at > SHELL_RECHECK_MS || hit.files !== files) {
    try {
      const r = render(name, req);
      hit = { at: r.complete ? Date.now() : 0, html: r.html, files };
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

module.exports = { send, facts, render, _internals: { tileHtml, laterHtml, parseChangelog, headline, tvHeadline, notesFrom, scrub, householdWords, wordRe, fmtDate, tvVersionIn } };
