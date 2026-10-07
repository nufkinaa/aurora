// lib/blurup.js: which picture addresses an answer carries, what the server
// can make a placeholder for, and that a client which did not ask is left alone.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const blur = require("../src/lib/blurup");
const { collect, localUrl, mem } = blur._internals;

test("collect finds cover / poster / backdrop at any depth, once each", () => {
  const out = new Set();
  collect({ rows: [{ items: [{ cover: "/img/a1", backdrop: "https://x.example/b.jpg", title: "T" }, { cover: "/img/a1", poster: "/img/meta/p.jpg" }] }], hero: { backdrop: "" } }, out);
  assert.deepEqual([...out], ["/img/a1", "https://x.example/b.jpg", "/img/meta/p.jpg"]);
});

test("localUrl maps a picture to this server's own image routes", () => {
  assert.equal(localUrl("/img/abc123"), "/img/abc123?w=240");
  assert.equal(localUrl("/img/meta/x.jpg"), "/img/meta/x.jpg?w=240");
  assert.equal(localUrl("/img/still/abc?t=4"), "/img/still/abc?t=4");
  assert.match(localUrl("https://images.metahub.space/poster/small/tt1/img"), /^\/img\/ext\?u=https%3A%2F%2Fimages\.metahub\.space.*&w=240$/);
  assert.equal(localUrl("http://insecure.example/x.jpg"), null);
  assert.equal(localUrl("data:image/png;base64,AAAA"), null);
});

test("annotate returns only what is already known", () => {
  mem.set("/img/known1", "data:image/webp;base64,AAAA");
  const map = blur.annotate({ items: [{ cover: "/img/known1" }, { cover: "data:nope" }] });
  assert.deepEqual(map, { "/img/known1": "data:image/webp;base64,AAAA" });
  assert.equal(blur.annotate({ items: [{ title: "no pictures" }] }), null);
});

test("the middleware leaves a client that did not ask, arrays, and non-GETs alone", () => {
  mem.set("/img/known2", "data:image/webp;base64,BBBB");
  const run = (req, body) => {
    let sent;
    const res = { statusCode: 200, json: (b) => { sent = b; } };
    blur.middleware({ method: "GET", path: "/api/home", get: () => undefined, ...req }, res, () => {});
    res.json(body);
    return sent;
  };
  const body = { items: [{ cover: "/img/known2" }] };
  assert.equal(run({}, body)._blur, undefined);
  assert.deepEqual(run({ get: (h) => (h === "X-Blur" ? "1" : undefined) }, body)._blur, { "/img/known2": "data:image/webp;base64,BBBB" });
  assert.equal(body._blur, undefined, "the route's own object is not mutated");
  assert.equal(run({ method: "POST", get: () => "1" }, body)._blur, undefined);
  assert.equal(run({ path: "/api/admin/people", get: () => "1" }, body)._blur, undefined);
  assert.ok(Array.isArray(run({ get: () => "1" }, [{ cover: "/img/known2" }])));
});
