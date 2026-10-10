// The start of a film as arithmetic (public/js/playstart.js): which rendition
// of a quality ladder the player begins on, when a slow first segment is
// given up for a lighter one, which segment holds the second it starts at.
const test = require("node:test");
const assert = require("node:assert");

const load = () => import("../public/js/playstart.js");

// A ladder as the server writes it (media/ladder.js masterText): the file's
// own video first, the 720p and 480p encodes under it.
const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  '#EXT-X-STREAM-INF:BANDWIDTH=9460800,AVERAGE-BANDWIDTH=9100000,RESOLUTION=1920x1080,FRAME-RATE=23.976,CODECS="avc1.640028,mp4a.40.2"',
  "index.m3u8?v=copy",
  '#EXT-X-STREAM-INF:BANDWIDTH=3551147,AVERAGE-BANDWIDTH=2700480,RESOLUTION=1280x720,FRAME-RATE=23.976,CODECS="avc1.64001f,mp4a.40.2"',
  "index.m3u8?v=h264-720",
  '#EXT-X-STREAM-INF:BANDWIDTH=1658027,AVERAGE-BANDWIDTH=1271360,RESOLUTION=854x480,FRAME-RATE=23.976,CODECS="avc1.64001e,mp4a.40.2"',
  "index.m3u8?v=h264-480",
  "",
].join("\n");
const URL0 = "https://tv.example/stream/transcode/abc123/jit/master.m3u8?a=1";

test("masterVariants: the renditions in the master's order, each with its address, its BANDWIDTH and its name", async () => {
  const { masterVariants } = await load();
  const vs = masterVariants(MASTER, URL0);
  assert.deepEqual(vs.map((v) => v.v), ["copy", "h264-720", "h264-480"]);
  assert.deepEqual(vs.map((v) => v.bandwidth), [9460800, 3551147, 1658027]);
  assert.equal(vs[0].uri, "https://tv.example/stream/transcode/abc123/jit/index.m3u8?v=copy");
  assert.equal(vs[2].uri, "https://tv.example/stream/transcode/abc123/jit/index.m3u8?v=h264-480");
  // CRLF line ends, and a master with nothing in it
  assert.equal(masterVariants(MASTER.replace(/\n/g, "\r\n"), URL0).length, 3);
  assert.deepEqual(masterVariants("", URL0), []);
  assert.deepEqual(masterVariants(null, URL0), []);
  // AVERAGE-BANDWIDTH is not mistaken for BANDWIDTH when it comes first
  const odd = '#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=111,BANDWIDTH=222\nindex.m3u8?v=copy\n';
  assert.equal(masterVariants(odd, URL0)[0].bandwidth, 222);
});

test("startRung: nothing known about the line — the top rung, as always", async () => {
  const { startRung, masterVariants } = await load();
  const rungs = masterVariants(MASTER, URL0);
  assert.equal(startRung(rungs, 0), 0);
  assert.equal(startRung(rungs, null), 0);
  assert.equal(startRung(rungs, NaN), 0);
  assert.equal(startRung([], 5000), -1);
  assert.equal(startRung(null, 5000), -1);
});

test("startRung: the highest rung that fits in 80% of what the line carried", async () => {
  const { startRung, masterVariants, START_HEADROOM } = await load();
  assert.equal(START_HEADROOM, 0.8);
  const rungs = masterVariants(MASTER, URL0);
  // a fast line: the file itself (9.46 Mbit/s needs 11.8)
  assert.equal(startRung(rungs, 50000), 0);
  assert.equal(startRung(rungs, 11826), 0);
  assert.equal(startRung(rungs, 11800), 1, "just under: 720p");
  // 3 Mbit/s: 720p declares 3.55 at its peak — 480p
  assert.equal(startRung(rungs, 5000), 1);
  assert.equal(startRung(rungs, 4400), 2);
  assert.equal(startRung(rungs, 3000), 2);
  // thinner than anything: the lowest there is, never nothing
  assert.equal(startRung(rungs, 800), 2);
  // a one-rung "ladder" has one answer
  assert.equal(startRung([{ bandwidth: 9e6 }], 500), 0);
});

test("startRung: a lean file whose own video fits is not traded for an encode", async () => {
  const { startRung } = await load();
  // a 2.5 Mbit/s film (peak 3.3) on a 5 Mbit/s line
  assert.equal(startRung([{ bandwidth: 3300000 }, { bandwidth: 1658027 }], 5000), 0);
  // …and on a 3 Mbit/s line it is
  assert.equal(startRung([{ bandwidth: 3300000 }, { bandwidth: 1658027 }], 3000), 1);
});

test("startStepDown: a first segment that will be here soon is left alone", async () => {
  const { startStepDown } = await load();
  const lower = [{ bandwidth: 3551147 }, { bandwidth: 1658027 }];
  assert.equal(startStepDown({ eta: 1, rate: 50e6, dur: 10, lower }), -1);
  assert.equal(startStepDown({ eta: 3, rate: 5e6, dur: 10, lower }), -1, "three seconds more is not worth a restart");
  // nothing to step down to, or nothing measured
  assert.equal(startStepDown({ eta: 30, rate: 3e6, dur: 10, lower: [] }), -1);
  assert.equal(startStepDown({ eta: 30, rate: 0, dur: 10, lower }), -1);
  assert.equal(startStepDown({ eta: 30, rate: 3e6, dur: 0, lower }), -1);
  assert.equal(startStepDown({ eta: NaN, rate: 3e6, dur: 10, lower }), -1);
});

test("startStepDown: an 8 Mbit/s film on a thin line goes to the best rung the line can also carry", async () => {
  const { startStepDown, START_MAKE_SEC } = await load();
  assert.equal(START_MAKE_SEC, 1.5);
  const lower = [{ bandwidth: 3551147 }, { bandwidth: 1658027 }];
  // 10.7 MB of which 0.5 MB has arrived at 3 Mbit/s: 27 s to go. 720p would be
  // quicker (13.3 s) — but it declares 3.55 Mbit/s, and 3 Mbit/s does not carry
  // it: it would be given up a segment later. 480p (1.66 ≤ 2.4): that one.
  assert.equal(startStepDown({ eta: 27.2, rate: 3e6, dur: 10, lower }), 1);
  // on a 5 Mbit/s line 720p is carried (3.55 ≤ 4.0) and quicker (7.1 + 1.5 < 16 × 0.6): 720p
  assert.equal(startStepDown({ eta: 16, rate: 5e6, dur: 10, lower }), 0);
  // at 1.5 Mbit/s nothing is carried (480p wants 2.07): the lightest, since it is quicker (11 + 1.5 < 54 × 0.6)
  assert.equal(startStepDown({ eta: 54, rate: 1.5e6, dur: 10, lower }), 1);
  // the rest of the segment is 12 s away at 3 Mbit/s: 480p (5.5 + 1.5 = 7.0 < 7.2) just wins
  assert.equal(startStepDown({ eta: 12, rate: 3e6, dur: 10, lower }), 1);
  // …and with 10 s to go nothing wins clearly: stay
  assert.equal(startStepDown({ eta: 10, rate: 3e6, dur: 10, lower }), -1);
  // one rung below, not carried and not quicker: stay
  assert.equal(startStepDown({ eta: 8, rate: 1e6, dur: 10, lower: [{ bandwidth: 1658027 }] }), -1);
});

test("startStepDown: a far server's line that has opened up is not mistaken for a thin one", async () => {
  const { startStepDown } = await load();
  // 50 Mbit/s measured over the last stretch, 2 MB still to come: 0.3 s
  assert.equal(startStepDown({ eta: 0.3, rate: 50e6, dur: 10, lower: [{ bandwidth: 1658027 }] }), -1);
});

const PLAYLIST = [
  "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:11", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS",
  "#EXTINF:10.010000,", "seg00000.ts?v=copy",
  "#EXTINF:10.010000,", "seg00001.ts?v=copy",
  "#EXTINF:6.500000,", "seg00002.ts?v=copy",
  "#EXTINF:10.010000,", "seg00003.ts?v=copy",
  "#EXT-X-ENDLIST", "",
].join("\n");

test("segmentAt: the segment that holds a second of the film", async () => {
  const { segmentAt } = await load();
  assert.equal(segmentAt(PLAYLIST, 0), "seg00000.ts?v=copy");
  assert.equal(segmentAt(PLAYLIST, 10), "seg00000.ts?v=copy");
  assert.equal(segmentAt(PLAYLIST, 10.02), "seg00001.ts?v=copy");
  assert.equal(segmentAt(PLAYLIST, 20.03), "seg00002.ts?v=copy");
  assert.equal(segmentAt(PLAYLIST, 26.6), "seg00003.ts?v=copy");
  // past the end: the last one (a resume point at the very end of a film)
  assert.equal(segmentAt(PLAYLIST, 9999), "seg00003.ts?v=copy");
  // fMP4: the init segment's line (#EXT-X-MAP) is not a segment
  const fmp4 = PLAYLIST.replace("#EXT-X-INDEPENDENT-SEGMENTS", '#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="init.mp4?v=copy&seg=fmp4"').replace(/\.ts/g, ".m4s");
  assert.equal(segmentAt(fmp4, 0), "seg00000.m4s?v=copy");
  assert.equal(segmentAt(fmp4.replace(/\n/g, "\r\n"), 12), "seg00001.m4s?v=copy");
  assert.equal(segmentAt("", 5), null);
  assert.equal(segmentAt(null, 5), null);
});

test("streamSaves: nothing is claimed when the line, the index or the film's bitrate is unknown", async () => {
  const { streamSaves } = await load();
  assert.equal(streamSaves({ indexBytes: 5e6, kbps: 0, fileKbps: 2500, progressive: true }), 0);
  assert.equal(streamSaves({ indexBytes: 0, kbps: 8000, fileKbps: 2500, progressive: true }), 0);
  assert.equal(streamSaves({ indexBytes: 5e6, kbps: 8000, fileKbps: 0, progressive: true }), 0);
  assert.equal(streamSaves({}), 0);
  assert.equal(streamSaves(), 0);
});

test("streamSaves: a film's index on a 5 Mbit/s line is seconds a stream does not spend", async () => {
  const { streamSaves, STREAM_WORTH_SEC } = await load();
  assert.equal(STREAM_WORTH_SEC, 1.5);
  // an hour of film: a 2.5 MB index — 4 s of the line; the stream's own overhead is 0.6 s
  const hour = streamSaves({ indexBytes: 2.5e6, kbps: 5000, fileKbps: 2500, progressive: true });
  assert.ok(hour > 3.2 && hour < 3.6, `an hour: ${hour.toFixed(2)} s saved`);
  // a long film: 9.3 MB — fifteen seconds
  const long = streamSaves({ indexBytes: 9.3e6, kbps: 5000, fileKbps: 2500, progressive: true });
  assert.ok(long > 13.5 && long < 15, `a long film: ${long.toFixed(1)} s saved`);
  assert.ok(hour > STREAM_WORTH_SEC && long > STREAM_WORTH_SEC);
});

test("streamSaves: a line the film only just fits keeps the file — its stream weighs a little more and would starve", async () => {
  const { streamSaves, STREAM_HEADROOM } = await load();
  assert.equal(STREAM_HEADROOM, 1.3);
  // 2.5 Mbit/s film on a 3 Mbit/s line: however long the index takes
  assert.equal(streamSaves({ indexBytes: 9.3e6, kbps: 3000, fileKbps: 2500, progressive: true }), 0);
  assert.equal(streamSaves({ indexBytes: 9.3e6, kbps: 3249, fileKbps: 2500, progressive: true }), 0);
  // …and with the room the player asks for, the stream
  assert.ok(streamSaves({ indexBytes: 9.3e6, kbps: 3250, fileKbps: 2500, progressive: true }) > 20);
});

test("streamSaves: on a line that carries the index in a moment the file stays the file", async () => {
  const { streamSaves, STREAM_WORTH_SEC } = await load();
  // a home network: 100 Mbit/s
  assert.ok(streamSaves({ indexBytes: 9.3e6, kbps: 100000, fileKbps: 2500, progressive: true }) < STREAM_WORTH_SEC);
  assert.ok(streamSaves({ indexBytes: 2.5e6, kbps: 100000, fileKbps: 2500, progressive: true }) < 0.01);
  // 20 Mbit/s and an ordinary film: one second — not worth a server process
  assert.ok(streamSaves({ indexBytes: 4.5e6, kbps: 20000, fileKbps: 2500, progressive: true }) < STREAM_WORTH_SEC);
  // an episode's index is small on any line
  assert.ok(streamSaves({ indexBytes: 105000, kbps: 5000, fileKbps: 2500, progressive: true }) < STREAM_WORTH_SEC);
});

test("streamSaves: a player that needs a whole first segment gains only where the index is bigger than that segment", async () => {
  const { streamSaves, STREAM_WORTH_SEC } = await load();
  // 2.5 Mbit/s film: 8 s of it is 2.5 MB — the same as an hour's index: nothing gained
  assert.ok(streamSaves({ indexBytes: 2.5e6, kbps: 5000, fileKbps: 2500, progressive: false }) < STREAM_WORTH_SEC);
  // …but a long film's 9.3 MB index is still most of the wait
  assert.ok(streamSaves({ indexBytes: 9.3e6, kbps: 5000, fileKbps: 2500, progressive: false }) > 8);
  // an 8 Mbit/s film: its first segment (8 MB) outweighs a 4.5 MB index — the file is quicker
  assert.equal(streamSaves({ indexBytes: 4.5e6, kbps: 12000, fileKbps: 8000, progressive: false }), 0);
});

test("startStepUp: an encoded rung the server has not begun to send is waited for three seconds, then the film's own video is taken", async () => {
  const { startStepUp, START_ENCODE_PATIENCE_MS } = await load();
  assert.equal(START_ENCODE_PATIENCE_MS, 3000);
  assert.equal(startStepUp({ waited: 500, encoded: true, copyTop: true }), false);
  assert.equal(startStepUp({ waited: 2999, encoded: true, copyTop: true }), false);
  assert.equal(startStepUp({ waited: 3000, encoded: true, copyTop: true }), true);
  // the file's own video is a copy: it is never "slow to encode"
  assert.equal(startStepUp({ waited: 60000, encoded: false, copyTop: true }), false);
  // nothing to go up to (the top is itself an encode, or this IS the top): wait on
  assert.equal(startStepUp({ waited: 60000, encoded: true, copyTop: false }), false);
});
