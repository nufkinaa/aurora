// What a home card carries, per client. The TV's shape (`/api/home?slim=1`)
// drops the player-only fields the website's cards drop — and keeps every
// field the TV app reads off a card.
const test = require("node:test");
const assert = require("node:assert");

const { tvStrip, cardStrip } = require("../src/routes/api")._internals;

// A library film as the home composer hands it over (scanner + listEntry).
const LIB = () => ({
  id: "2d8a6f6aa176",
  type: "movie",
  title: "Troy",
  year: 2004,
  cover: "/img/0f571b277cf7",
  backdrop: "/img/still/2d8a6f6aa176",
  genres: ["Action", "Adventure"],
  synopsis: "In year 1250 B.C. two emerging nations begin to clash.",
  rating: 7.2,
  certificate: null,
  imdbId: "tt0332452",
  addedAt: 1760000000000,
  duration: 11762.87,
  container: "mp4",
  width: 1920,
  height: 794,
  sizeBytes: 123456789,
  progress: { position: 600, duration: 11762, finished: false, updatedAt: 1760000001000 },
  // player-only
  videoUrl: "/stream/video/2d8a6f6aa176",
  hlsUrl: "/stream/hls/2d8a6f6aa176/index.m3u8",
  transcodeBase: "/stream/transcode/2d8a6f6aa176",
  downloadUrl: "/stream/download/2d8a6f6aa176",
  transcodeV: "copy",
  url: "/stream/video/2d8a6f6aa176",
  files: [{ name: "Troy.mp4", size: 123456789 }],
  // what slim=1 has always dropped
  seasons: [{ number: 1, episodes: [] }],
  subtitles: [{ label: "English", url: "/sub/1" }],
  audio: { codec: "ac3", compatible: false },
  video: { codec: "h264" },
  extras: [{ id: "x" }],
  audioTracks: [{ index: 0, language: "eng" }],
});

// Every field the TV app reads from a home card: Card.tsx, Home's billboard,
// openItem.ts, the title page's use of the item it is opened with, the peek
// sheet, and the launcher rows (homeScreen.ts KEEP + description).
const TV_READS = [
  "id", "type", "title", "year", "cover", "backdrop", "genres", "synopsis", "rating",
  "imdbId", "addedAt", "progress",
];

test("slim=1 keeps every field the TV reads from a card", () => {
  const out = tvStrip(LIB());
  for (const k of TV_READS) assert.deepEqual(out[k], LIB()[k], k);
});

test("slim=1 keeps the synopsis on EVERY card (the website's cards drop it)", () => {
  assert.equal(tvStrip(LIB()).synopsis, LIB().synopsis);
  assert.equal(cardStrip(LIB()).synopsis, undefined);
  assert.equal(cardStrip(LIB(), { synopsis: true }).synopsis, LIB().synopsis);
});

test("slim=1 drops the player-only fields of a library title", () => {
  const out = tvStrip(LIB());
  for (const k of ["videoUrl", "hlsUrl", "transcodeBase", "downloadUrl", "transcodeV", "url", "files"]) {
    assert.ok(!(k in out), k);
  }
});

test("slim=1 still drops what it always dropped", () => {
  const out = tvStrip(LIB());
  for (const k of ["seasons", "subtitles", "audio", "video", "extras", "audioTracks"]) assert.ok(!(k in out), k);
});

test("the facts about the file stay (only the play addresses go)", () => {
  const out = tvStrip(LIB());
  for (const k of ["duration", "container", "width", "height", "sizeBytes", "certificate"]) assert.ok(k in out, k);
});

test("a torrent resume entry keeps its play addresses — the only copy the player can resume from", () => {
  const T = {
    id: "torrent|abcdef0123456789abcdef0123456789abcdef01|2",
    type: "show",
    title: "Pilot",
    showTitle: "Breaking Bad",
    season: 1,
    episode: 1,
    imdbId: "tt0903747",
    infoHash: "abcdef0123456789abcdef0123456789abcdef01",
    videoUrl: "/stream/torrent/abcdef0123456789abcdef0123456789abcdef01/2",
    transcodeBase: "/stream/torrent/hls/abcdef0123456789abcdef0123456789abcdef01/2",
    transcodeV: "h264",
    quality: "1080p",
    cover: "https://images.metahub.space/poster/small/tt0903747/img",
    progress: { position: 300, duration: 3480 },
    subtitles: [{ label: "English", url: "/x" }],
    audioTracks: [{ index: 0 }],
  };
  const out = tvStrip(T);
  for (const k of ["videoUrl", "transcodeBase", "transcodeV", "infoHash", "quality", "progress", "cover", "season", "episode", "showTitle"]) {
    assert.deepEqual(out[k], T[k], k);
  }
  // …and is slimmed exactly as before
  assert.ok(!("subtitles" in out));
  assert.ok(!("audioTracks" in out));
});

test("a stream (catalogue) card passes through whole", () => {
  const S = {
    type: "movie",
    title: "Unabomber",
    year: 2026,
    poster: "https://images.metahub.space/poster/small/tt6933238/img",
    backdrop: "https://images.metahub.space/background/medium/tt6933238/img",
    synopsis: "A Harvard student…",
    rating: 6.2,
    genres: ["Biography"],
    imdbId: "tt6933238",
    inLibrary: null,
    source: "stream",
  };
  assert.deepEqual(tvStrip(S), S);
});

test("the item handed in is not changed, and a hole in a row stays a hole", () => {
  const item = LIB();
  tvStrip(item);
  assert.deepEqual(item, LIB());
  assert.equal(tvStrip(null), null);
  assert.equal(tvStrip(undefined), undefined);
});

test("an older TV build loses nothing it used: the new shape is the old one minus the play addresses", () => {
  const old = (i) => {
    const { seasons, subtitles, audio, video, extras, audioTracks, ...rest } = i;
    return rest;
  };
  const before = old(LIB());
  const after = tvStrip(LIB());
  const gone = Object.keys(before).filter((k) => !(k in after)).sort();
  assert.deepEqual(gone, ["downloadUrl", "files", "hlsUrl", "transcodeBase", "transcodeV", "url", "videoUrl"]);
  for (const k of Object.keys(after)) assert.deepEqual(after[k], before[k], k);
});
