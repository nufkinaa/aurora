// Admin → "Add your own file" (media/uploads.js): names that cannot leave the
// library folder, every Google Drive link form and its confirm page, a chunked
// upload assembled across a wrong offset and a broken-off chunk, the disk-full
// refusal, placement + rescan, and link downloads against a local fake server
// (Drive's virus-scan page, a dropped connection resumed with Range, a web
// page where a video was expected, a Drive file that isn't shared).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");

const config = require("../src/config");
const disk = require("../src/lib/disk");
const uploads = require("../src/media/uploads");
const { cleanName, parseLink, readHtmlAnswer, subSuffix, destinationFor, hosts, NOT_SHARED } = uploads._internals;
const DRIVE = hosts.driveDownload; // (the fake server below takes its place for the download tests)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-uploads-test-"));
const MOVIES = path.join(TMP, "movies");
const SHOWS = path.join(TMP, "shows");
const saved = { movies: config.LIBRARIES.movies.slice(), shows: config.LIBRARIES.shows.slice(), space: disk.space, ff: config.ffmpegAvailable };
before(() => {
  fs.mkdirSync(MOVIES, { recursive: true });
  fs.mkdirSync(SHOWS, { recursive: true });
  config.LIBRARIES.movies.splice(0, Infinity, MOVIES);
  config.LIBRARIES.shows.splice(0, Infinity, SHOWS);
  config.ffmpegAvailable = false; // (the test bytes are not a real video: no poster frame)
  disk.space = async () => ({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3, freePct: 50 });
});
after(() => {
  config.LIBRARIES.movies.splice(0, Infinity, ...saved.movies);
  config.LIBRARIES.shows.splice(0, Infinity, ...saved.shows);
  config.ffmpegAvailable = saved.ff;
  disk.space = saved.space;
  uploads._internals.store.data = uploads._internals.jobs().filter((j) => !String(j.title).startsWith("UT "));
  fs.rmSync(TMP, { recursive: true, force: true });
});

const waitFor = async (id, statuses, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const j = uploads.get(id);
    if (j && statuses.includes(j.status)) return j;
    if (Date.now() - t0 > ms) throw new Error(`still ${j && j.status} (${j && j.error})`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const fakeReq = (buf, { len = buf.length, breakAfter = null } = {}) => {
  let sent = false;
  const r = new Readable({
    read() {
      if (sent) return;
      sent = true;
      if (breakAfter != null) { this.push(buf.subarray(0, breakAfter)); setTimeout(() => this.destroy(new Error("aborted")), 150); }
      else { this.push(buf); this.push(null); }
    },
  });
  r.headers = { "content-length": String(len) };
  return r;
};

// ---------- names ----------
test("names: separators, dots and reserved names never make a path", () => {
  assert.equal(cleanName("../../etc/passwd"), "etc passwd");
  assert.equal(cleanName("..\\..\\Windows"), "Windows");
  assert.equal(cleanName("...."), "");
  assert.equal(cleanName(".hidden"), "hidden");
  assert.equal(cleanName("CON"), "CON (file)");
  assert.equal(cleanName('My "Film": part 1?'), "My Film part 1");
  assert.equal(cleanName("Trailing. . "), "Trailing");
  assert.equal(subSuffix("My.Film.en.srt", "My.Film.mp4"), ".en");
  assert.equal(subSuffix("other.Hebrew.srt", "My.Film.mp4"), ".Hebrew");
  assert.equal(subSuffix("My.Film.srt", "My.Film.mp4"), "");
  assert.equal(subSuffix("My.Film.en/../../x.srt", "My.Film.mp4"), "", "only the file's own name counts");
  assert.equal(subSuffix("My.Film.e n?*.srt", "My.Film.mp4"), ".e.n");
});

test("a title that tries to climb out lands inside the library folder", async () => {
  const d = await destinationFor({ type: "movie", rootIdx: 0, title: "../../../evil", year: 2020 });
  assert.equal(d.dir, path.join(MOVIES, "evil (2020)"));
  assert.equal(d.base, "evil (2020)");
  const e = await destinationFor({ type: "show", rootIdx: 0, title: "..\\Show", year: null, season: 2, episode: 5 });
  assert.equal(e.dir, path.join(SHOWS, "Show", "Season 02"));
  assert.equal(e.base, "Show S02E05");
});

// ---------- links ----------
test("Google Drive: every share-link form becomes the direct download with confirm=t", () => {
  const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  assert.equal(DRIVE, "https://drive.usercontent.google.com/download");
  const want = `${hosts.driveDownload}?id=${ID}&export=download&confirm=t`;
  for (const link of [
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view`,
    `https://drive.google.com/file/d/${ID}`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?id=${ID}&export=download`,
    `https://docs.google.com/uc?export=download&id=${ID}`,
    `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
    `  https://drive.google.com/file/d/${ID}/view?usp=drive_link  `,
  ]) {
    const r = parseLink(link);
    assert.equal(r.kind, "drive", link);
    assert.equal(r.url, want, link);
  }
  assert.match(parseLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp").error, /folder/);
  assert.match(parseLink("https://drive.google.com/file/d/").error, /no file/);
});

test("Dropbox gets dl=1; a direct link stays; anything else is refused", () => {
  const d = parseLink("https://www.dropbox.com/scl/fi/abc/My%20Film.mp4?rlkey=xyz&dl=0");
  assert.equal(d.kind, "dropbox");
  assert.equal(new URL(d.url).searchParams.get("dl"), "1");
  assert.equal(new URL(d.url).searchParams.get("rlkey"), "xyz");
  assert.equal(parseLink("https://example.com/films/a.mkv").kind, "web");
  assert.match(parseLink("ftp://example.com/a.mkv").error, /http/);
  assert.match(parseLink("file:///C:/Windows/win.ini").error, /http/);
  assert.match(parseLink("not a link").error, /web address/);
  assert.match(parseLink("").error, /Paste/);
});

test("Drive's web pages: the virus-scan form is followed, the others say why", () => {
  const confirm = `<html><body><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    <input type="submit" value="Download anyway"/><input type="hidden" name="id" value="FILEID123456"><input type="hidden" name="export" value="download">
    <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-u-i-d"></form></body></html>`;
  const n = new URL(readHtmlAnswer(confirm, "drive", "https://drive.usercontent.google.com/download?id=FILEID123456").next);
  assert.equal(n.searchParams.get("uuid"), "u-u-i-d");
  assert.equal(n.searchParams.get("confirm"), "t");
  assert.equal(n.searchParams.get("id"), "FILEID123456");
  const old = `<a id="uc-download-link" href="/uc?export=download&amp;confirm=AbC1&amp;id=FILEID123456">Download anyway</a>`;
  assert.equal(readHtmlAnswer(old, "drive", "https://drive.google.com/uc?id=FILEID123456").next, "https://drive.google.com/uc?export=download&confirm=AbC1&id=FILEID123456");
  assert.equal(readHtmlAnswer(`<title>Sign in - Google Accounts</title><a href="https://accounts.google.com/ServiceLogin">`, "drive", "https://x/").error, NOT_SHARED);
  assert.match(readHtmlAnswer("Too many users have viewed or downloaded this file recently.", "drive", "https://x/").error, /too many times/);
  assert.match(readHtmlAnswer("<html>hello</html>", "web", "https://x/").error, /web page, not a video/);
});

// ---------- uploads ----------
const PLACE = { root: 0, lookup: true };
test("refused: a file that is not a video or subtitle, no video, an empty file", async () => {
  assert.equal((await uploads.createUpload({ ...PLACE, title: "UT x", files: [{ name: "setup.exe", size: 10 }] })).status, 400);
  assert.equal((await uploads.createUpload({ ...PLACE, title: "UT x", files: [{ name: "a.srt", size: 10 }] })).status, 400);
  assert.equal((await uploads.createUpload({ ...PLACE, title: "UT x", files: [{ name: "a.mp4", size: 0 }] })).status, 400);
  assert.equal((await uploads.createUpload({ ...PLACE, title: "  ", files: [{ name: "a.mp4", size: 5 }] })).status, 400);
  assert.equal((await uploads.createUpload({ ...PLACE, title: "UT x", year: "20x4", files: [{ name: "a.mp4", size: 5 }] })).status, 400);
  assert.equal((await uploads.createUpload({ ...PLACE, root: 7, title: "UT x", files: [{ name: "a.mp4", size: 5 }] })).status, 400);
});

test("refused when the disk would be nearly full", async () => {
  const real = disk.space;
  disk.space = async () => ({ free: 3 * 1024 ** 3, total: 100 * 1024 ** 3, freePct: 3 });
  try {
    const r = await uploads.createUpload({ ...PLACE, title: "UT Big", files: [{ name: "big.mkv", size: 2 * 1024 ** 3 }] });
    assert.equal(r.status, 507);
    assert.match(r.error, /Not enough room: 3\.0 GB free .* this needs 2\.0 GB .* keep 2\.0 GB free/);
  } finally { disk.space = real; }
});

test("a chunked upload: a wrong offset is told the right one, a broken chunk keeps what arrived, then it lands and is scanned", async () => {
  const video = Buffer.alloc(300 * 1024 + 17);
  for (let i = 0; i < video.length; i++) video[i] = (i * 7 + 3) & 255;
  const sub = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nhello\n");
  const c = await uploads.createUpload({ ...PLACE, title: "UT My Clip", year: "2024", files: [{ name: "my.clip.mp4", size: video.length }, { name: "my.clip.en.srt", size: sub.length }] });
  assert.equal(c.status, 200, c.error);
  const id = c.job.id;
  assert.deepEqual(c.job.parts.map((p) => [p.role, p.received]), [["video", 0], ["subtitle", 0]]);
  // first 100 KB
  let r = await uploads.writeChunk(id, 0, 0, fakeReq(video.subarray(0, 100 * 1024)));
  assert.equal(r.status, 200);
  assert.equal(r.offset, 100 * 1024);
  // a page that thinks it is somewhere else: refused, told where to go on from
  r = await uploads.writeChunk(id, 0, 50 * 1024, fakeReq(video.subarray(50 * 1024, 60 * 1024)));
  assert.equal(r.status, 409);
  assert.equal(r.offset, 100 * 1024);
  // a chunk that breaks off half way: what arrived is kept and counted
  r = await uploads.writeChunk(id, 0, 100 * 1024, fakeReq(video.subarray(100 * 1024, 200 * 1024), { breakAfter: 30 * 1024 }));
  assert.equal(r.status, 400);
  assert.equal(r.offset, 130 * 1024);
  assert.equal(uploads.get(id).parts[0].received, 130 * 1024);
  // too many bytes for the file: refused
  assert.equal((await uploads.writeChunk(id, 0, 130 * 1024, fakeReq(Buffer.alloc(video.length)))).status, 400);
  // the rest, then the subtitle
  r = await uploads.writeChunk(id, 0, 130 * 1024, fakeReq(video.subarray(130 * 1024)));
  assert.equal(r.offset, video.length);
  assert.equal(r.job.status, "uploading");
  r = await uploads.writeChunk(id, 1, 0, fakeReq(sub));
  assert.equal(r.status, 200);
  const done = await waitFor(id, ["done", "error"]);
  assert.equal(done.status, "done", done.error);
  const dest = path.join(MOVIES, "UT My Clip (2024)", "UT My Clip (2024).mp4");
  assert.ok(Buffer.compare(fs.readFileSync(dest), video) === 0, "the bytes are the file's, in order");
  assert.equal(fs.readFileSync(path.join(MOVIES, "UT My Clip (2024)", "UT My Clip (2024).en.srt"), "utf8"), sub.toString());
  assert.equal(done.dest, path.join("UT My Clip (2024)", "UT My Clip (2024).mp4"));
  assert.ok(!fs.existsSync(path.join(MOVIES, ".aurora-uploads", id)), "the temp folder is gone");
  // the rescan indexed it
  const scanner = require("../src/media/scanner");
  assert.ok(done.libId, "the job carries the library id");
  const m = scanner.index.movies.find((x) => x.id === done.libId);
  assert.equal(m && m.title, "UT My Clip");
  assert.equal(m.year, 2024);
  // chunks after the end are refused
  assert.equal((await uploads.writeChunk(id, 0, 0, fakeReq(Buffer.alloc(5)))).status, 409);
});

test("a second upload of the same title is a copy beside it, never over it", async () => {
  const a = await uploads.createUpload({ ...PLACE, title: "UT My Clip", year: "2024", files: [{ name: "again.mkv", size: 4 }] });
  await uploads.writeChunk(a.job.id, 0, 0, fakeReq(Buffer.from("abcd")));
  const done = await waitFor(a.job.id, ["done", "error"]);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.dest, path.join("UT My Clip (2024)", "UT My Clip (2024) (2).mkv"));
  assert.equal(fs.readFileSync(path.join(MOVIES, "UT My Clip (2024)", "UT My Clip (2024) (2).mkv"), "utf8"), "abcd");
});

test("an episode lands in the show's folder under Season NN", async () => {
  fs.mkdirSync(path.join(SHOWS, "UT Home Show"), { recursive: true });
  const a = await uploads.createUpload({ ...PLACE, title: "UT Home Show", year: "2023", episode: { season: "1", episode: "3" }, files: [{ name: "ep.mp4", size: 3 }] });
  assert.equal(a.status, 200, a.error);
  await uploads.writeChunk(a.job.id, 0, 0, fakeReq(Buffer.from("xyz")));
  const done = await waitFor(a.job.id, ["done", "error"]);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.dest, path.join("UT Home Show", "Season 01", "UT Home Show S01E03.mp4"), "joined the folder that was there (no year)");
  assert.ok(done.showId, "the show's id for the Open button");
});

test("cancel throws the bytes away; the job can be removed once it is over", async () => {
  const a = await uploads.createUpload({ ...PLACE, title: "UT Cancel Me", files: [{ name: "c.mp4", size: 10 }] });
  await uploads.writeChunk(a.job.id, 0, 0, fakeReq(Buffer.from("12345")));
  assert.equal((await uploads.dismiss(a.job.id)).status, 409, "not while it runs");
  const r = await uploads.cancel(a.job.id);
  assert.equal(r.job.status, "canceled");
  assert.equal((await uploads.writeChunk(a.job.id, 0, 5, fakeReq(Buffer.from("67890")))).status, 409);
  await new Promise((res) => setTimeout(res, 1700));
  assert.ok(!fs.existsSync(path.join(MOVIES, ".aurora-uploads", a.job.id)));
  assert.equal((await uploads.dismiss(a.job.id)).status, 200);
  assert.equal(uploads.get(a.job.id), null);
});

// ---------- links, against a local fake server ----------
let srv;
let base;
const FILM = Buffer.alloc(512 * 1024);
for (let i = 0; i < FILM.length; i++) FILM[i] = (i * 13 + 1) & 255;
const seen = [];
let breakNext = false;
before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), range: req.headers.range || null });
    // a fake Drive: no uuid yet → the virus-scan page
    if (u.pathname === "/download") {
      const id = u.searchParams.get("id");
      if (id === "PRIVATEFILE1234") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<title>Sign in</title> ServiceLogin"); }
      if (id === "GONEFILE123456") { res.writeHead(404); return res.end(); }
      if (!u.searchParams.get("uuid")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<form id="download-form" action="${base}/download" method="get"><input type="hidden" name="id" value="${id}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="fresh-uuid"></form>`);
      }
      return sendFilm(req, res, 'attachment; filename="Holiday Movie.MKV"');
    }
    if (u.pathname === "/page") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>not a film</html>"); }
    if (u.pathname === "/notes.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("hello"); }
    if (u.pathname === "/film.mp4") return sendFilm(req, res, null);
    res.writeHead(404); res.end();
  });
  const sendFilm = (req, res, cd) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0;
    const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": String(FILM.length - start) };
    if (cd) headers["Content-Disposition"] = cd;
    if (m) headers["Content-Range"] = `bytes ${start}-${FILM.length - 1}/${FILM.length}`;
    res.writeHead(m ? 206 : 200, headers);
    if (breakNext) { breakNext = false; res.write(FILM.subarray(start, start + 200 * 1024)); setTimeout(() => res.socket.destroy(), 50); return; }
    res.end(FILM.subarray(start));
  };
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  hosts.driveDownload = `${base}/download`;
});
after(() => srv && srv.close());

test("a Drive link: the confirm page is followed, a dropped connection resumes with Range, the file lands with the Drive file's extension", async () => {
  seen.length = 0;
  breakNext = true;
  const r = await uploads.createLink({ ...PLACE, url: "https://drive.google.com/file/d/FILEID1234567/view?usp=sharing", title: "UT Holiday", year: 2025 });
  assert.equal(r.status, 200, r.error);
  assert.equal(r.job.source, "drive");
  const done = await waitFor(r.job.id, ["done", "error"], 30000);
  assert.equal(done.status, "done", done.error);
  const dest = path.join(MOVIES, "UT Holiday (2025)", "UT Holiday (2025).mkv");
  assert.ok(Buffer.compare(fs.readFileSync(dest), FILM) === 0, "the whole film, in order");
  assert.equal(seen[0].q.confirm, "t");
  assert.ok(seen.some((s) => s.q.uuid === "fresh-uuid"), "followed the virus-scan form");
  assert.ok(seen.some((s) => s.range === `bytes=${200 * 1024}-`), `resumed where it broke off: ${JSON.stringify(seen)}`);
});

test("a direct link: progress to the end, named by its address", async () => {
  const r = await uploads.createLink({ ...PLACE, url: `${base}/film.mp4`, title: "UT Direct", year: "" });
  const done = await waitFor(r.job.id, ["done", "error"]);
  assert.equal(done.status, "done", done.error);
  assert.equal(done.size, FILM.length);
  assert.equal(done.received, FILM.length);
  assert.ok(fs.existsSync(path.join(MOVIES, "UT Direct", "UT Direct.mp4")));
});

test("a web page or a text file where a video was expected, a Drive file that isn't public: clear errors, nothing placed", async () => {
  const page = await uploads.createLink({ ...PLACE, url: `${base}/page`, title: "UT Page" });
  assert.match((await waitFor(page.job.id, ["done", "error"])).error, /web page, not a video file/);
  const txt = await uploads.createLink({ ...PLACE, url: `${base}/notes.txt`, title: "UT Text" });
  assert.match((await waitFor(txt.job.id, ["done", "error"])).error, /isn't a video file/);
  const priv = await uploads.createLink({ ...PLACE, url: "https://drive.google.com/open?id=PRIVATEFILE1234", title: "UT Private" });
  assert.equal((await waitFor(priv.job.id, ["done", "error"])).error, NOT_SHARED);
  const gone = await uploads.createLink({ ...PLACE, url: "https://drive.google.com/uc?id=GONEFILE123456", title: "UT Gone" });
  assert.equal((await waitFor(gone.job.id, ["done", "error"])).error, NOT_SHARED);
  for (const t of ["UT Page", "UT Text", "UT Private", "UT Gone"]) assert.ok(!fs.existsSync(path.join(MOVIES, t)), t);
  // retry starts it again (and fails the same way here)
  const again = await uploads.retry(page.job.id);
  assert.ok(["queued", "downloading"].includes(again.job.status), again.job.status);
  assert.equal((await waitFor(page.job.id, ["error"])).status, "error");
});
