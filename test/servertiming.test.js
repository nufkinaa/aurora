// Server-Timing (src/lib/servertiming.js): the header every /api and /stream
// answer carries, so a slow start can be put down to the server or the line.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const st = require("../src/lib/servertiming");

test("the header: name;dur=ms, one decimal, in the order the steps were noted", () => {
  assert.equal(st.headerFor([{ name: "app", ms: 12.34 }, { name: "probe", ms: 96 }]), "app;dur=12.3, probe;dur=96.0");
});

test("a description is quoted and stripped of anything that could break the header", () => {
  assert.equal(st.headerFor([{ name: "seg", ms: 310.26, desc: 'ma"de,\r\n x' }]), 'seg;dur=310.3;desc="made x"');
});

test("names are tokens: anything else is dropped from them, and a nameless step is left out", () => {
  assert.equal(st.headerFor([{ name: "a b;c=d", ms: 1 }, { name: "", ms: 5 }, { name: "ok", ms: -3 }]), "abcd;dur=1.0, ok;dur=0.0");
});

test("parse reads back what headerFor wrote", () => {
  const h = st.headerFor([{ name: "app", ms: 412.3 }, { name: "seg", ms: 310.2, desc: "made" }]);
  assert.deepEqual(st.parse(h), { app: { ms: 412.3, desc: null }, seg: { ms: 310.2, desc: "made" } });
  assert.deepEqual(st.parse(""), {});
  assert.deepEqual(st.parse(null), {});
});

const serve = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });

test("the middleware: every answer says how long the server took, with the steps a route named", async () => {
  const app = express();
  app.use(st.middleware);
  app.get("/quick", (req, res) => res.json({ ok: true }));
  app.get("/slow", async (req, res) => {
    const v = await st.timed(res, "probe", () => new Promise((r) => setTimeout(() => r(7), 60)));
    await st.timed(res, "seg", () => Promise.resolve(), () => "ready");
    res.send(String(v));
  });
  app.get("/throws", async (req, res) => {
    try { await st.timed(res, "probe", () => Promise.reject(new Error("no"))); } catch {}
    res.status(500).send("x");
  });
  app.get("/stream", (req, res) => { res.writeHead(206, { "Content-Type": "video/mp4" }); res.end("abc"); });
  const { server, url } = await serve(app);
  try {
    let r = await fetch(`${url}/quick`);
    let t = st.parse(r.headers.get("server-timing"));
    assert.ok(t.app && t.app.ms >= 0 && t.app.ms < 1000, "app is there");
    assert.deepEqual(Object.keys(t), ["app"]);

    r = await fetch(`${url}/slow`);
    assert.equal(await r.text(), "7", "timed() hands the step's value through");
    t = st.parse(r.headers.get("server-timing"));
    assert.ok(t.probe.ms >= 50 && t.probe.ms < 1000, `probe took about 60 ms (${t.probe.ms})`);
    assert.ok(t.app.ms >= t.probe.ms, "app covers the steps");
    assert.equal(t.seg.desc, "ready", "a description can be decided when the step ends");

    r = await fetch(`${url}/throws`);
    assert.equal(r.status, 500);
    assert.ok(st.parse(r.headers.get("server-timing")).probe, "a step that failed is still timed");

    r = await fetch(`${url}/stream`);
    assert.equal(r.status, 206);
    assert.ok(st.parse(r.headers.get("server-timing")).app, "a response written with writeHead carries it too");
  } finally {
    server.close();
  }
});

test("a route that sets its own Server-Timing keeps it; no more than 8 steps are kept", async () => {
  const app = express();
  app.use(st.middleware);
  app.get("/own", (req, res) => { res.setHeader("Server-Timing", "mine;dur=1"); res.send("x"); });
  app.get("/many", (req, res) => { for (let i = 0; i < 20; i++) res.timing(`s${i}`, i); res.send("x"); });
  const { server, url } = await serve(app);
  try {
    assert.equal((await fetch(`${url}/own`)).headers.get("server-timing"), "mine;dur=1");
    const t = st.parse((await fetch(`${url}/many`)).headers.get("server-timing"));
    assert.equal(Object.keys(t).length, 9, "app + 8 steps");
  } finally {
    server.close();
  }
});
