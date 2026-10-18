// realtime.js — WebSocket hygiene: a message over the size cap closes its
// socket (1009); a peer that stops answering pings is ended at the next beat;
// a slow reader's broadcasts are skipped and a hopeless one ended (memory
// stays bounded); a flood of messages is dropped and the socket closed (1008);
// too many sockets from one address are refused in "enforce" mode and only
// counted in "log" mode. A real server on a free port; nothing leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const WebSocket = require("ws");

const config = require("../src/config");
const realtime = require("../src/realtime");
const { hygiene, heartbeat, send } = realtime._internals;

let server;
let port;
test.before(async () => {
  config.WS = { maxMessageKb: 4, maxPerAddress: 2 };
  server = http.createServer((q, r) => r.end("x"));
  realtime.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(() => { config.WS = {}; try { realtime.closeAll(null); } catch {} server.closeAllConnections?.(); server.close(); });

const open = (headers = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const msgs = [];
  ws.on("message", (m) => msgs.push(String(m)));
  ws.once("open", () => resolve({ ws, msgs }));
  ws.once("error", reject);
});
const closed = (ws) => new Promise((r) => ws.once("close", (code) => r(code)));

test("a message over the size cap closes the socket (1009)", async () => {
  const { ws } = await open({ "x-forwarded-for": "203.0.113.10" });
  const before = hygiene.oversize;
  const done = closed(ws);
  ws.send("x".repeat(5 * 1024));
  assert.equal(await done, 1009);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hygiene.oversize, before + 1);
});

test("a peer that stops answering pings is ended at the next beat", async () => {
  // a raw upgrade that then never reads or answers anything
  const key = crypto.randomBytes(16).toString("base64");
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: 203.0.113.11\r\n\r\n`);
  await new Promise((r) => sock.once("data", r)); // 101
  sock.pause(); // never reads (and so never answers a ping)
  const before = hygiene.deadPeers;
  // a well-behaved client next to it answers its pings and stays
  const { ws: good } = await open({ "x-forwarded-for": "203.0.113.12" });
  const openBefore = realtime.wsStatus().open;
  heartbeat(); // ping everyone
  await new Promise((r) => setTimeout(r, 100)); // the good one's pong arrives
  heartbeat(); // the silent one has not answered: ended
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hygiene.deadPeers, before + 1);
  assert.equal(realtime.wsStatus().open, openBefore - 1, "the server let go of it");
  sock.destroy();
  assert.equal(good.readyState, WebSocket.OPEN, "a socket that answers is never ended");
  good.close();
});

test("a slow reader: broadcasts are skipped above 1 MB waiting, the socket ended above 8 MB", () => {
  const sent = [];
  let ended = false;
  const fake = (bufferedAmount) => ({ readyState: WebSocket.OPEN, bufferedAmount, send: (m) => sent.push(m), terminate: () => { ended = true; } });
  assert.equal(send(fake(0), "a", true), true);
  const skipped = hygiene.skippedSends;
  assert.equal(send(fake(2 * 1024 * 1024), "b", true), false);
  assert.equal(hygiene.skippedSends, skipped + 1);
  assert.equal(send(fake(2 * 1024 * 1024), "c", false), true, "a direct answer still goes");
  assert.equal(send(fake(9 * 1024 * 1024), "d", false), false);
  assert.equal(ended, true);
  assert.deepEqual(sent, ["a", "c"]);
});

test("a flood of messages is dropped, then the socket is closed (1008)", async () => {
  const { ws } = await open({ "x-forwarded-for": "203.0.113.13" });
  const before = hygiene.droppedMessages;
  const done = closed(ws);
  for (let i = 0; i < 2600; i++) ws.send('{"type":"activity","action":"Browsing"}');
  assert.equal(await done, 1008);
  assert.ok(hygiene.droppedMessages - before >= 1000);
});

test("sockets from one address: counted in log mode, refused in enforce mode", async () => {
  config.WS = { maxMessageKb: 4, maxPerAddress: 2, mode: "log" };
  const h = { "x-forwarded-for": "203.0.113.20" };
  const a = await open(h);
  const b = await open(h);
  const over = hygiene.overAddressLimit;
  const c = await open(h); // log mode: let in, counted
  assert.equal(hygiene.overAddressLimit, over + 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
  await closed(c.ws);
  config.WS = { maxMessageKb: 4, maxPerAddress: 2, mode: "enforce" };
  const d = await open(h);
  assert.equal(await closed(d.ws), 1013);
  // another address is not affected
  const e = await open({ "x-forwarded-for": "203.0.113.21" });
  assert.equal(e.ws.readyState, WebSocket.OPEN);
  for (const x of [a, b, e]) x.ws.close();
  config.WS = { maxMessageKb: 4, maxPerAddress: 2 };
});

test("wsStatus reports the sockets and what the rules did", () => {
  const s = realtime.wsStatus();
  for (const k of ["open", "buffered", "maxBuffered", "deadPeers", "skippedSends", "closedSlow", "oversize", "droppedMessages", "closedChatty", "overAddressLimit"]) assert.ok(k in s, k);
  assert.equal(s.limits.maxMessageBytes, 4 * 1024);
});
