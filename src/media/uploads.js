// Admin → Downloads → "Add your own file": a video of your own (or a film
// you keep in Google Drive / Dropbox) put into the library by hand.
//
//   * from this device: the page sends the file in chunks (PUT …/chunk with
//     the byte offset it starts at). Each chunk is streamed straight to a
//     temp file — never held in memory — and the server's count of bytes
//     received is the truth: after a dropped connection (or a reload, the
//     file picked again) the page asks how much is there and goes on.
//   * from a link: Google Drive (every share-link form, the virus-scan
//     confirm page of a big file), Dropbox (dl=1), or any direct http(s)
//     URL. Downloaded in the background through lib/upstream.js stream()
//     (breaker, header timeout, stall timeout — not a page's deadline),
//     resumed with Range where the host allows it.
//
// The temp file lives in "<library root>/.aurora-uploads/<job>/" — the same
// disk as its destination (the move in is a rename / hard link, not a copy)
// and a dot-folder no library walk reads. Once complete it is placed as
//   films     <root>/<Title> (<Year>)/<Title> (<Year>).<ext>
//   episodes  <root>/<Show (Year)>/Season NN/<Show> SNNENN.<ext>
// never over an existing file ("(2)" then), the library is rescanned, and the
// job shows the title's library id. "Look it up online" off (the default: a
// video of your own) marks the title so no catalogue match is ever guessed
// for it, and gives it a poster from one of its own frames.
//
// Safety: admin-only routes (routes/uploads.js); only video / subtitle
// extensions; names are cleaned (no separators, no leading dots, no
// reserved Windows names) and the destination is checked to be inside its
// root; a job is refused when the disk would be left with less than
// MIN_FREE; every file operation here is asynchronous.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const disk = require("../lib/disk");

const store = new JsonStore(path.join(config.DATA_DIR, "uploads.json"), []);
const jobs = () => (Array.isArray(store.data) ? store.data : (store.data = []));

const TEMP_DIR = ".aurora-uploads";
const CHUNK_MAX = 64 * 1024 * 1024; // the page sends 8 MB; anything past this is refused
const SUB_MAX = 20 * 1024 * 1024;
const MAX_SUBS = 10;
const KEEP_DONE = 100;
const MAX_LINKS_AT_ONCE = 2;
const LINK_RETRIES = 4; // automatic, on a network error or a stall (Range where possible)
// The disk keeps at least this free after the file lands: 2 GB, or 2 % of the volume.
const floorFor = (total) => Math.max(2 * 1024 ** 3, (total || 0) * 0.02);

const videoExts = () => (config.VIDEO_EXTENSIONS || [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"]).map((e) => e.toLowerCase());
const subExts = () => (config.SUBTITLE_EXTENSIONS || [".srt", ".vtt"]).map((e) => e.toLowerCase());
const extOf = (name) => path.extname(String(name || "")).toLowerCase();

// ---------- names ----------
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// One folder / file name component: no separators or characters Windows
// refuses, no leading or trailing dots and spaces (".." can never come out),
// at most 120 characters. "" when nothing is left.
const cleanName = (s) => {
  let out = String(s == null ? "" : s)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  if (RESERVED.test(out.split(".")[0])) out = `${out} (file)`;
  return out;
};
const cleanYear = (y) => {
  const n = parseInt(y, 10);
  return Number.isInteger(n) && n >= 1880 && n <= 2100 ? n : null;
};
// A subtitle's language tag as it lands beside the video: "film.en.srt" with
// "film.mp4" keeps ".en". Letters, digits, dots, dashes only.
const subSuffix = (subName, videoName) => {
  const sb = path.basename(String(subName || ""), extOf(subName));
  const vb = path.basename(String(videoName || ""), extOf(videoName));
  let rest = sb.toLowerCase().startsWith(vb.toLowerCase()) ? sb.slice(vb.length) : (/[._ -]([A-Za-z]{2,12})$/.exec(sb) || [])[0] || "";
  rest = rest.replace(/[^A-Za-z0-9.\-]/g, ".").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "").slice(0, 30);
  return rest ? `.${rest}` : "";
};

const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (abs, root) => {
  const a = norm(abs);
  const r = norm(root);
  return a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

// ---------- links ----------
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const hosts = { driveDownload: "https://drive.usercontent.google.com/download" }; // (tests point it at a local server)
// → { kind: "drive"|"dropbox"|"web", url, id? } or { error }
const parseLink = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return { error: "Paste a link first." };
  let u;
  try { u = new URL(text); } catch { return { error: "That isn't a web address." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only http and https links can be downloaded." };
  const host = u.hostname.toLowerCase();
  if (/(^|\.)(drive|docs)\.google\.com$/.test(host) || host === "drive.usercontent.google.com") {
    if (/\/folders\//.test(u.pathname)) return { error: "That is a Drive folder — share the video file itself and paste its link." };
    const m = /\/file\/d\/([^/]+)/.exec(u.pathname) || /\/d\/([^/]+)/.exec(u.pathname);
    const id = (m && m[1]) || u.searchParams.get("id");
    if (!id || !DRIVE_ID.test(id)) return { error: "That Google Drive link has no file in it — use the file's Share → Copy link." };
    return { kind: "drive", id, url: `${hosts.driveDownload}?id=${encodeURIComponent(id)}&export=download&confirm=t` };
  }
  if (/(^|\.)dropbox\.com$/.test(host) && host !== "dl.dropboxusercontent.com") {
    u.searchParams.delete("raw");
    u.searchParams.set("dl", "1");
    return { kind: "dropbox", url: u.toString() };
  }
  return { kind: "web", url: u.toString() };
};

const NOT_SHARED = "This Drive file isn't shared with “anyone with the link” — in Drive: Share → General access → Anyone with the link, then try again.";
// A web page where a file was expected. For Drive: the virus-scan confirm
// form (→ { next }), or why it can't be had (→ { error }).
const readHtmlAnswer = (html, kind, baseUrl) => {
  const s = String(html || "");
  if (kind === "drive") {
    const form = /<form[^>]*id=["']download-form["'][^>]*>([\s\S]*?)<\/form>/i.exec(s) || /<form[^>]*action=["'][^"']*\/download[^"']*["'][^>]*>([\s\S]*?)<\/form>/i.exec(s);
    if (form) {
      const action = (/action=["']([^"']+)["']/i.exec(form[0]) || [])[1];
      const next = new URL(action ? action.replace(/&amp;/g, "&") : hosts.driveDownload, baseUrl);
      for (const m of form[1].matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
        const name = (/name=["']([^"']+)["']/i.exec(m[0]) || [])[1];
        const value = (/value=["']([^"']*)["']/i.exec(m[0]) || [])[1];
        if (name) next.searchParams.set(name, (value || "").replace(/&amp;/g, "&"));
      }
      return { next: next.toString() };
    }
    const old = /href=["']([^"']*\/uc\?export=download[^"']*confirm=[^"']+)["']/i.exec(s);
    if (old) return { next: new URL(old[1].replace(/&amp;/g, "&"), baseUrl).toString() };
    if (/Too many users have viewed or downloaded|quota (?:has been )?exceeded/i.test(s)) {
      return { error: "Google Drive says this file was downloaded too many times today. Try again tomorrow, or make a copy of it in your Drive and share that." };
    }
    if (/ServiceLogin|accounts\.google\.com|You need access|Request access|Sign in/i.test(s)) return { error: NOT_SHARED };
    return { error: "Google Drive answered with a web page instead of the file. Check the link is to a video file shared with “anyone with the link”." };
  }
  if (kind === "dropbox") return { error: "Dropbox answered with a web page instead of the file — check the link is a shared file link (not a folder)." };
  return { error: "That link leads to a web page, not a video file. Use a direct link to the file." };
};

const CT_EXT = { "video/mp4": ".mp4", "video/x-matroska": ".mkv", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-msvideo": ".avi", "video/x-m4v": ".m4v" };
const fileNameFrom = (res, url) => {
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch {} }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1].trim();
  try { return decodeURIComponent(path.posix.basename(new URL(res.url || url).pathname)); } catch { return ""; }
};

// ---------- jobs ----------
const live = new Map(); // id -> { ctrl, busyPart } while bytes move
const lastBroadcast = new Map();
const tell = (job, force = false) => {
  const now = Date.now();
  if (!force && now - (lastBroadcast.get(job.id) || 0) < 1000) return;
  lastBroadcast.set(job.id, now);
  try { require("../realtime").broadcastAdmins({ type: "upload_update", job: publicJob(job) }); } catch {}
};
const save = () => store.save();
const find = (id) => jobs().find((j) => j.id === String(id));
const newId = () => crypto.randomBytes(6).toString("hex");

const rootsOf = (type) => ((type === "show" ? config.LIBRARIES.shows : config.LIBRARIES.movies) || []);
const rootFor = (job) => rootsOf(job.type)[job.rootIdx] || null;
const tempDirOf = (job) => path.join(rootFor(job), TEMP_DIR, job.id);
const partPath = (job, i) => path.join(tempDirOf(job), `p${i}.part`);

const publicJob = (j) => ({
  id: j.id, kind: j.kind, status: j.status, type: j.type, title: j.title, year: j.year,
  season: j.season || null, episode: j.episode || null, lookup: !!j.lookup,
  source: j.source || null, url: j.kind === "link" ? j.url : null,
  parts: (j.parts || []).map((p) => ({ name: p.name, size: p.size, received: p.received, role: p.role })),
  size: totalSize(j), received: totalReceived(j), speed: j.speed || 0,
  error: j.error || null, dest: j.dest || null, libId: j.libId || null, showId: j.showId || null,
  createdAt: j.createdAt, updatedAt: j.updatedAt, finishedAt: j.finishedAt || null,
  root: rootFor(j),
});
const totalSize = (j) => (j.parts || []).reduce((n, p) => n + (p.size || 0), 0);
const totalReceived = (j) => (j.parts || []).reduce((n, p) => n + (p.received || 0), 0);
const ACTIVE = new Set(["waiting", "uploading", "queued", "downloading", "placing"]);

// Bytes other unfinished jobs on the same volume will still write.
const committed = (root, exceptId) => jobs().reduce((n, j) => {
  if (j.id === exceptId || !ACTIVE.has(j.status) || rootFor(j) !== root) return n;
  return n + Math.max(0, (totalSize(j) || 0) - totalReceived(j));
}, 0);
const gb = (n) => (n / 1024 ** 3).toFixed(1);
// → null when there is room, else the sentence why not.
const roomFor = async (root, bytes, exceptId) => {
  const s = await disk.space(root);
  if (!s) return `Couldn't read the free space on ${root}.`;
  const need = Math.max(0, bytes || 0) + committed(root, exceptId);
  const floor = floorFor(s.total);
  if (s.free - need >= floor) return null;
  return `Not enough room: ${gb(s.free)} GB free on ${root}, this needs ${gb(need)} GB and the disk must keep ${gb(floor)} GB free.`;
};

// The fields every job shares, checked. → { fields } or { error }
const checkPlace = (body) => {
  const title = cleanName(body.title);
  if (!title) return { error: "Give it a title." };
  const year = cleanYear(body.year);
  if (body.year != null && String(body.year).trim() !== "" && !year) return { error: "The year should be four digits, like 2024." };
  const ep = body.episode && typeof body.episode === "object" ? body.episode : null;
  const type = ep ? "show" : "movie";
  const season = ep ? parseInt(ep.season, 10) : null;
  const episode = ep ? parseInt(ep.episode, 10) : null;
  if (ep && !(season >= 0 && season <= 99 && episode >= 1 && episode <= 999)) return { error: "Season 0–99 and episode 1–999." };
  const roots = rootsOf(type);
  if (!roots.length) return { error: `No ${type === "show" ? "shows" : "movies"} library folder is set up in config.json.` };
  const rootIdx = body.root == null || body.root === "" ? 0 : parseInt(body.root, 10);
  if (!(rootIdx >= 0 && rootIdx < roots.length)) return { error: "Pick one of the library folders." };
  return { fields: { title, year, type, season, episode, rootIdx, lookup: body.lookup === true } };
};

const base = (fields) => ({
  id: newId(), ...fields, createdAt: Date.now(), updatedAt: Date.now(), error: null, speed: 0,
});

const trimDone = () => {
  const list = jobs();
  const done = list.filter((j) => !ACTIVE.has(j.status));
  if (done.length <= KEEP_DONE) return;
  const drop = new Set(done.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).slice(0, done.length - KEEP_DONE).map((j) => j.id));
  store.data = list.filter((j) => !drop.has(j.id));
};

// POST /api/admin/uploads — { title, year, episode?, root, lookup, files: [{ name, size }] }
const createUpload = async (body = {}) => {
  const p = checkPlace(body);
  if (p.error) return { status: 400, error: p.error };
  const files = Array.isArray(body.files) ? body.files : [];
  const parts = [];
  for (const f of files) {
    const name = String((f && f.name) || "").slice(0, 300);
    const size = Number(f && f.size);
    const ext = extOf(name);
    const role = videoExts().includes(ext) ? "video" : subExts().includes(ext) ? "subtitle" : null;
    if (!role) return { status: 400, error: `"${path.basename(name)}" isn't a video or subtitle file (videos: ${videoExts().join(" ")}; subtitles: ${subExts().join(" ")}).` };
    if (!(Number.isSafeInteger(size) && size > 0)) return { status: 400, error: `"${path.basename(name)}" is empty.` };
    if (role === "subtitle" && size > SUB_MAX) return { status: 400, error: `"${path.basename(name)}" is too big for a subtitle file.` };
    parts.push({ name: path.basename(name.replace(/\\/g, "/")), size, received: 0, role, ext });
  }
  const videos = parts.filter((x) => x.role === "video");
  if (videos.length !== 1) return { status: 400, error: "One video file per title." };
  if (parts.length - 1 > MAX_SUBS) return { status: 400, error: `At most ${MAX_SUBS} subtitle files with one video.` };
  parts.sort((a, b) => (a.role === "video" ? -1 : 0) - (b.role === "video" ? -1 : 0));
  const job = { ...base(p.fields), kind: "file", status: "waiting", parts };
  const root = rootFor(job);
  const why = await roomFor(root, totalSize(job));
  if (why) return { status: 507, error: why };
  await fs.promises.mkdir(tempDirOf(job), { recursive: true });
  jobs().push(job);
  trimDone();
  save();
  tell(job, true);
  console.log(`[upload] new upload ${job.id}: "${job.title}"${job.year ? ` (${job.year})` : ""} — ${gb(totalSize(job))} GB`);
  return { status: 200, job: publicJob(job) };
};

// PUT /api/admin/uploads/:id/chunk?part=&offset= — the request body is the bytes.
const writeChunk = async (id, partIdx, offset, req) => {
  const job = find(id);
  if (!job || job.kind !== "file") return { status: 404, error: "No such upload." };
  if (!["waiting", "uploading"].includes(job.status)) return { status: 409, error: `This upload is ${job.status}.`, job: publicJob(job) };
  const part = job.parts[partIdx];
  if (!part) return { status: 400, error: "No such file in this upload." };
  const len = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(len) || len < 0) return { status: 411, error: "Send the chunk with its length." };
  if (len > CHUNK_MAX) return { status: 413, error: "That chunk is too big." };
  if (offset !== part.received) return { status: 409, error: "Out of step — continue from the server's offset.", offset: part.received, job: publicJob(job) };
  if (offset + len > part.size) return { status: 400, error: "More bytes than the file has." };
  const rec = live.get(job.id) || {};
  if (rec.busy) return { status: 409, error: "Another chunk of this upload is still arriving.", offset: part.received };
  rec.busy = true;
  live.set(job.id, rec);
  const file = partPath(job, partIdx);
  const t0 = Date.now();
  let err = null;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // the file is exactly `received` bytes long: write from there on
    const ws = fs.createWriteStream(file, { flags: offset === 0 ? "w" : "r+", start: offset });
    let n = 0;
    const cap = new Transform({
      transform(chunk, _enc, cb) { n += chunk.length; if (n > len) return cb(new Error("more bytes than announced")); cb(null, chunk); },
    });
    job.status = "uploading";
    await pipeline(req, cap, ws);
  } catch (e) {
    err = e;
  } finally {
    rec.busy = false;
    if (live.get(job.id) === rec && !rec.link) live.delete(job.id);
  }
  // what is really on disk is the count (an aborted chunk keeps what arrived)
  let size = 0;
  try { size = (await fs.promises.stat(file)).size; } catch {}
  part.received = Math.min(size, part.size);
  const ms = Math.max(1, Date.now() - t0);
  const bps = (part.received - offset) / (ms / 1000);
  job.speed = job.speed ? job.speed * 0.6 + bps * 0.4 : bps;
  job.updatedAt = Date.now();
  if (find(job.id) !== job || job.status === "canceled") return { status: 409, error: "This upload was canceled." };
  if (err && part.received < offset + len) {
    save();
    tell(job);
    return { status: 400, error: "The chunk did not arrive whole — continue from the server's offset.", offset: part.received, job: publicJob(job) };
  }
  if (job.parts.every((p) => p.received >= p.size)) {
    job.status = "placing";
    job.speed = 0;
    save();
    tell(job, true);
    place(job).catch(() => {});
  } else {
    save();
    tell(job);
  }
  return { status: 200, offset: part.received, job: publicJob(job) };
};

// POST /api/admin/uploads/link — { url, title, year, episode?, root, lookup }
const createLink = async (body = {}) => {
  const link = parseLink(body.url);
  if (link.error) return { status: 400, error: link.error };
  const p = checkPlace(body);
  if (p.error) return { status: 400, error: p.error };
  const job = {
    ...base(p.fields), kind: "link", status: "queued", url: String(body.url).trim().slice(0, 2000), source: link.kind,
    parts: [{ name: "", size: 0, received: 0, role: "video", ext: "" }], attempts: 0,
  };
  const why = await roomFor(rootFor(job), 0);
  if (why) return { status: 507, error: why };
  jobs().push(job);
  trimDone();
  save();
  tell(job, true);
  console.log(`[upload] new link download ${job.id} (${link.kind}): "${job.title}"`);
  pump();
  return { status: 200, job: publicJob(job) };
};

const fail = (job, message) => {
  job.status = "error";
  job.error = String(message || "failed").slice(0, 400);
  job.speed = 0;
  job.updatedAt = Date.now();
  save();
  tell(job, true);
  console.warn(`[upload] ${job.id} "${job.title}" failed: ${job.error}`);
};

const pump = () => {
  let running = [...live.values()].filter((r) => r.link).length;
  for (const job of jobs()) {
    if (running >= MAX_LINKS_AT_ONCE) break;
    if (job.kind === "link" && job.status === "queued" && !live.has(job.id)) {
      running++;
      runLink(job).catch((e) => fail(job, e && e.message));
    }
  }
};

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

const runLink = async (job) => {
  const ctrl = new AbortController();
  const rec = { link: true, ctrl };
  live.set(job.id, rec);
  job.status = "downloading";
  job.error = null;
  job.updatedAt = Date.now();
  save();
  tell(job, true);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await downloadOnce(job, ctrl.signal);
        break;
      } catch (e) {
        if (ctrl.signal.aborted || find(job.id) !== job || job.status === "canceled") return;
        const retryable = e && (e.retry || (e.name === "UpstreamError" && ["network", "timeout"].includes(e.code)));
        if (!retryable || attempt >= LINK_RETRIES) throw e;
        console.warn(`[upload] ${job.id}: ${e.message} — trying again (${attempt + 1}/${LINK_RETRIES})`);
        await sleep(Math.min(30000, 3000 * 2 ** attempt));
        if (ctrl.signal.aborted) return;
      }
    }
  } catch (e) {
    if (!ctrl.signal.aborted && find(job.id) === job) fail(job, e && e.message);
    return;
  } finally {
    live.delete(job.id);
    setImmediate(pump);
  }
  if (find(job.id) !== job || job.status === "canceled") return;
  job.status = "placing";
  job.speed = 0;
  save();
  tell(job, true);
  await place(job);
};

const upstreamLib = () => require("../lib/upstream");
const retryErr = (msg) => Object.assign(new Error(msg), { retry: true });

// One pass: resolve the link (Drive's confirm page), then stream the bytes
// into the temp file from what is already there.
const downloadOnce = async (job, signal) => {
  const link = parseLink(job.url);
  if (link.error) throw new Error(link.error);
  const part = job.parts[0];
  const file = partPath(job, 0);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  let have = 0;
  try { have = (await fs.promises.stat(file)).size; } catch {}
  let url = link.url;
  let opened = null;
  for (let hop = 0; hop < 3; hop++) {
    const headers = { "User-Agent": "Mozilla/5.0 (Aurora personal media server)" };
    if (have > 0) headers.Range = `bytes=${have}-`;
    opened = await upstreamLib().stream(url, { headers, signal, headersTimeoutMs: 30000, idleTimeoutMs: 90000 });
    const { res } = opened;
    let finalHost = "";
    try { finalHost = new URL(res.url || url).hostname; } catch {}
    if (link.kind === "drive" && /^accounts\.google\.com$/i.test(finalHost)) { opened.abort(); throw new Error(NOT_SHARED); }
    if (res.status === 416 && have > 0) { opened.abort(); have = 0; await fs.promises.rm(file, { force: true }); continue; }
    if (!res.ok) {
      opened.abort();
      if (link.kind === "drive" && (res.status === 403 || res.status === 404 || res.status === 401)) throw new Error(NOT_SHARED);
      if (res.status >= 500 || res.status === 429) throw retryErr(`the link answered ${res.status}`);
      throw new Error(res.status === 404 ? "Nothing at that link (404)." : res.status === 403 || res.status === 401 ? `The link refused the download (${res.status}) — is it shared publicly?` : `The link answered ${res.status}.`);
    }
    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (/text\/html|application\/xhtml/.test(ct)) {
      let html = "";
      for await (const c of opened.chunks()) { html += c.toString("utf8"); if (html.length > 2 * 1024 * 1024) break; }
      opened.abort();
      const said = readHtmlAnswer(html, link.kind, res.url || url);
      if (said.next) { url = said.next; continue; }
      throw new Error(said.error);
    }
    break;
  }
  if (!opened) throw new Error("The link could not be opened.");
  const { res } = opened;
  if (res.headers.get("content-type") && /text\/html/i.test(res.headers.get("content-type"))) { opened.abort(); throw new Error(readHtmlAnswer("", link.kind).error); }

  // where the bytes start, and how many there will be
  let start = 0;
  let total = 0;
  if (res.status === 206) {
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers.get("content-range") || "");
    start = m ? Number(m[1]) : 0;
    total = m && m[3] !== "*" ? Number(m[3]) : 0;
    if (start !== have) { opened.abort(); have = 0; await fs.promises.rm(file, { force: true }); throw retryErr("the link resumed from the wrong place"); }
  } else {
    start = 0; // no Range support (or a fresh start): from the top
    total = Number(res.headers.get("content-length") || 0);
  }
  // the name: what the answer says it is, else the address
  if (!part.ext) {
    const name = fileNameFrom(res, url);
    let ext = extOf(name);
    if (!videoExts().includes(ext)) ext = CT_EXT[String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()] || "";
    if (!ext) { opened.abort(); throw new Error(`That isn't a video file${name ? ` ("${path.basename(name).slice(0, 80)}")` : ""} — only ${videoExts().join(" ")} can be added.`); }
    part.name = path.basename(name || `video${ext}`).slice(0, 200);
    part.ext = ext;
  }
  part.size = total || 0;
  part.received = start;
  const root = rootFor(job);
  const why = await roomFor(root, total ? total - start : 0, job.id);
  if (why) { opened.abort(); throw new Error(why); }
  save();
  tell(job, true);

  const ws = fs.createWriteStream(file, { flags: start > 0 ? "r+" : "w", start });
  let lastAt = Date.now();
  let lastBytes = start;
  let sinceCheck = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      part.received += chunk.length;
      sinceCheck += chunk.length;
      const now = Date.now();
      if (now - lastAt >= 1000) {
        const bps = (part.received - lastBytes) / ((now - lastAt) / 1000);
        job.speed = job.speed ? job.speed * 0.7 + bps * 0.3 : bps;
        lastAt = now;
        lastBytes = part.received;
        job.updatedAt = now;
        tell(job);
      }
      // a size we were not told: look at the disk every 256 MB
      if (!total && sinceCheck >= 256 * 1024 * 1024) {
        sinceCheck = 0;
        return roomFor(root, 0, job.id).then((w) => cb(w ? new Error(w) : null, chunk), () => cb(null, chunk));
      }
      cb(null, chunk);
    },
  });
  const { Readable } = require("stream");
  try {
    await pipeline(Readable.from(opened.chunks()), meter, ws);
  } catch (e) {
    let size = 0;
    try { size = (await fs.promises.stat(file)).size; } catch {}
    part.received = size;
    save();
    if (/Not enough room/.test(e && e.message)) throw e;
    throw e && e.name === "UpstreamError" ? e : retryErr((e && e.message) || "the download broke off");
  }
  let size = 0;
  try { size = (await fs.promises.stat(file)).size; } catch {}
  part.received = size;
  if (total && size < total) throw retryErr(`the download stopped at ${gb(size)} of ${gb(total)} GB`);
  if (!total) part.size = size;
  if (size === 0) throw new Error("The link gave an empty file.");
  save();
};

// ---------- into the library ----------
const exists = (p) => fs.promises.access(p).then(() => true, () => false);
const hasVideoIn = async (dir) => {
  try { return (await fs.promises.readdir(dir)).some((f) => videoExts().includes(extOf(f))); } catch { return false; }
};
const nameTaken = async (dir, name, ext) => {
  for (const e of new Set([ext, ...videoExts()])) if (await exists(path.join(dir, `${name}${e}`))) return true;
  return false;
};
// Put `tmp` at `dest` unless something is there: a hard link refuses an
// existing name; a drive without hard links gets the check and a rename.
const placeNoClobber = async (tmp, dest) => {
  try {
    await fs.promises.link(tmp, dest);
  } catch (e) {
    if (e && e.code === "EEXIST") return false;
    if (await exists(dest)) return false;
    await fs.promises.rename(tmp, dest);
    return true;
  }
  await fs.promises.unlink(tmp).catch(() => {});
  return true;
};
const folderKey = (name) => String(name || "").replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const pad2 = (n) => String(n).padStart(2, "0");

// → { dir, base } for the job (names cleaned, inside its root — or a throw).
const destinationFor = async (job) => {
  const root = rootFor(job);
  if (!root) throw new Error("That library folder is no longer configured.");
  const title = cleanName(job.title) || "Untitled";
  const titled = cleanName(title + (job.year ? ` (${job.year})` : "")) || title;
  let dir;
  let baseName;
  if (job.type === "show") {
    // an episode joins the show's folder when there is one ("Show" or "Show (2019)")
    let existing = [];
    try { existing = (await fs.promises.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch {}
    const folder = existing.find((f) => folderKey(f) === folderKey(title)) || titled;
    dir = path.join(root, folder, `Season ${pad2(job.season || 1)}`);
    baseName = `${title} S${pad2(job.season || 1)}E${pad2(job.episode || 1)}`;
  } else {
    dir = path.join(root, titled);
    baseName = titled;
  }
  if (!inside(dir, root)) throw new Error("Refused: that name would land outside the library folder.");
  return { dir, base: baseName, root };
};

const place = async (job) => {
  try {
    const { dir, base: baseName, root } = await destinationFor(job);
    await fs.promises.mkdir(dir, { recursive: true });
    const video = job.parts[0];
    const ext = video.ext || extOf(video.name);
    if (!videoExts().includes(ext)) throw new Error("Not a video file.");
    let finalBase = null;
    let dest = null;
    for (let n = 1; n <= 99 && !dest; n++) {
      const name = n === 1 ? baseName : `${baseName} (${n})`;
      if (await nameTaken(dir, name, ext)) continue;
      if (n === 1 && job.type !== "show" && (await hasVideoIn(dir))) continue; // a film's folder holds one film
      const candidate = path.join(dir, `${name}${ext}`);
      if (!inside(candidate, root)) throw new Error("Refused: outside the library folder.");
      if (await placeNoClobber(partPath(job, 0), candidate)) { dest = candidate; finalBase = name; }
    }
    if (!dest) throw new Error(`Too many copies of "${baseName}" already.`);
    // subtitles beside it, named after it
    for (let i = 1; i < job.parts.length; i++) {
      const p = job.parts[i];
      const sx = subSuffix(p.name, video.name);
      for (let n = 1; n <= 20; n++) {
        const to = path.join(dir, `${finalBase}${sx}${n > 1 ? `.${n}` : ""}${p.ext}`);
        if (!inside(to, root)) break;
        if (await placeNoClobber(partPath(job, i), to)) break;
      }
    }
    await fs.promises.rm(tempDirOf(job), { recursive: true, force: true }).catch(() => {});
    job.dest = path.relative(root, dest);
    console.log(`[upload] ${job.id} placed as ${dest}`);
    if (!job.lookup) await markCustom(job, dest);
    await rescanFor(job, dest);
    job.status = "done";
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    save();
    tell(job, true);
  } catch (e) {
    fail(job, `Couldn't put it in the library: ${(e && e.message) || e}`);
  }
};

// The scanner's title for the folder (what online.js / imdb.js key on).
const scannedTitle = (job) => cleanName(job.title).replace(/\((19|20)\d{2}\)/g, "").replace(/\s+/g, " ").trim();

// Your own video: never matched to a catalogue title by name, and a poster
// made from one of its own frames (when the folder has no picture).
const markCustom = async (job, dest) => {
  try { require("./online").markCustom(job.type, scannedTitle(job)); } catch {}
  try { const imdb = require("./imdb"); imdb.markCustom(scannedTitle(job), job.type, job.year); if (job.year) imdb.markCustom(scannedTitle(job), job.type, null); } catch {}
  if (!config.ffmpegAvailable || !config.FFMPEG) return;
  const folder = job.type === "show" ? path.dirname(path.dirname(dest)) : path.dirname(dest);
  try {
    const names = await fs.promises.readdir(folder);
    if (names.some((n) => (config.IMAGE_EXTENSIONS || [".jpg", ".jpeg", ".png", ".webp"]).includes(extOf(n)))) return;
    let at = 10;
    try { const meta = await require("./metadata").probeAsync(dest); if (meta && meta.duration) at = Math.max(0, Math.floor(meta.duration * (meta.duration > 120 ? 0.2 : 0.4))); } catch {}
    const out = path.join(folder, "poster.jpg");
    const r = await require("../lib/spawner").run(config.FFMPEG, [
      "-v", "error", "-ss", String(at), "-i", dest, "-frames:v", "1",
      "-vf", "scale=600:900:force_original_aspect_ratio=increase,crop=600:900", "-q:v", "3", "-y", out,
    ], { timeoutMs: 60000, maxBuffer: 64 * 1024, name: "poster" });
    if (r && r.code !== 0) await fs.promises.rm(out, { force: true }).catch(() => {});
  } catch {}
};

const rescanFor = async (job, dest) => {
  const scanner = require("./scanner");
  try { await scanner.scanAsync({ force: true }); } catch { try { scanner.scan(); } catch {} }
  const id = scanner.idForPath(dest);
  job.libId = id || null;
  if (id && job.type === "show") {
    const show = scanner.index.shows.find((s) => s.seasons.some((se) => se.episodes.some((e) => e.id === id)));
    job.showId = show ? show.id : null;
  }
  try { require("../realtime").libraryUpdated(); } catch {}
  try { scanner.enrich(); } catch {}
};

// ---------- the admin's buttons ----------
const cancel = async (id) => {
  const job = find(id);
  if (!job) return { status: 404, error: "No such job." };
  if (!ACTIVE.has(job.status) || job.status === "placing") return { status: 409, error: `It is ${job.status}.` };
  job.status = "canceled";
  job.speed = 0;
  job.updatedAt = Date.now();
  const rec = live.get(job.id);
  if (rec && rec.ctrl) rec.ctrl.abort();
  save();
  tell(job, true);
  // (a chunk still arriving finishes its write first; the folder goes after)
  setTimeout(() => { fs.promises.rm(tempDirOf(job), { recursive: true, force: true }).catch(() => {}); }, 1500).unref?.();
  console.log(`[upload] ${job.id} canceled`);
  return { status: 200, job: publicJob(job) };
};

const retry = async (id) => {
  const job = find(id);
  if (!job) return { status: 404, error: "No such job." };
  if (!["error", "canceled"].includes(job.status)) return { status: 409, error: `It is ${job.status}.` };
  const wasCanceled = job.status === "canceled";
  const placingFailed = job.status === "error" && /library/.test(job.error || "");
  job.error = null;
  job.updatedAt = Date.now();
  const complete = job.parts.every((p) => p.size > 0 && p.received >= p.size);
  if (job.kind === "link" && !(complete && placingFailed)) {
    job.status = "queued";
    if (wasCanceled) for (const p of job.parts) { p.received = 0; p.size = 0; p.ext = ""; }
    save();
    tell(job, true);
    pump();
  } else if (complete && (await exists(partPath(job, 0)))) {
    job.status = "placing";
    save();
    place(job).catch(() => {});
  } else {
    // a file upload: the page sends the rest (it asks the offsets)
    for (let i = 0; i < job.parts.length; i++) {
      let size = 0;
      try { size = (await fs.promises.stat(partPath(job, i))).size; } catch {}
      job.parts[i].received = Math.min(size, job.parts[i].size);
    }
    job.status = "waiting";
    save();
    tell(job, true);
  }
  return { status: 200, job: publicJob(job) };
};

const dismiss = (id) => {
  const job = find(id);
  if (!job) return { status: 404, error: "No such job." };
  if (ACTIVE.has(job.status)) return { status: 409, error: "Cancel it first." };
  store.data = jobs().filter((j) => j !== job);
  save();
  try { require("../realtime").broadcastAdmins({ type: "upload_update", removed: job.id }); } catch {}
  return { status: 200, ok: true };
};

const list = () => ({
  jobs: jobs().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(publicJob),
  roots: { movies: rootsOf("movie"), shows: rootsOf("show") },
  chunkMax: CHUNK_MAX,
  videoExts: videoExts(),
  subExts: subExts(),
});
const get = (id) => { const j = find(id); return j ? publicJob(j) : null; };

// After a restart: an upload waits for its page (the bytes on disk are the
// count), a link download goes on from where it was, a placement is redone.
const resume = async () => {
  for (const job of jobs()) {
    if (!ACTIVE.has(job.status)) continue;
    if (!rootFor(job)) { fail(job, "That library folder is no longer configured."); continue; }
    for (let i = 0; i < (job.parts || []).length; i++) {
      let size = 0;
      try { size = (await fs.promises.stat(partPath(job, i))).size; } catch {}
      job.parts[i].received = job.parts[i].size ? Math.min(size, job.parts[i].size) : size;
    }
    if (job.kind === "file" && job.status !== "placing") job.status = "waiting";
    else if (job.kind === "link" && job.status !== "placing") job.status = "queued";
    if (job.status === "placing") place(job).catch(() => {});
  }
  save();
  pump();
};

module.exports = {
  list, get, createUpload, writeChunk, createLink, cancel, retry, dismiss, resume, publicJob,
  _internals: { cleanName, cleanYear, parseLink, readHtmlAnswer, subSuffix, destinationFor, roomFor, floorFor, hosts, store, jobs, live, inside, NOT_SHARED },
};
