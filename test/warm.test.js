// The pictures further down the page, asked for before the scroll gets
// there (public/js/warm.js): the queue's rules, with a made-up page.
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../public/js/warm.js");

// an <img> as far as the queue looks at it
const poster = (name, over = {}) => {
  const on = {};
  const im = {
    name,
    isConnected: true,
    loading: "lazy",
    complete: false,
    naturalWidth: 0,
    src: `/img/${name}`,
    getAttribute(k) { return k === "src" ? this.src : null; },
    addEventListener(ev, fn) { (on[ev] = on[ev] || new Set()).add(fn); },
    removeEventListener(ev, fn) { if (on[ev]) on[ev].delete(fn); },
    fire(ev) { for (const fn of [...(on[ev] || [])]) fn(); },
    listeners: () => Object.values(on).reduce((a, s) => a + s.size, 0),
    ...over,
  };
  return im;
};
// a page: `idle` work runs when the test says so, timers never fire by themselves
const page = async (over = {}) => {
  const { makeWarmer } = await load();
  const idle = [];
  const timers = new Map();
  let n = 0;
  const env = { ok: true };
  const w = makeWarmer({
    ok: () => env.ok,
    idle: (fn) => idle.push(fn),
    timer: (fn) => { timers.set(++n, fn); return n; },
    clear: (id) => timers.delete(id),
    ...over,
  });
  const rest = () => { while (idle.length) idle.shift()(); };
  return { w, env, rest, timers, idle };
};
const eager = (imgs) => imgs.filter((im) => im.loading === "eager").map((im) => im.name);

test("nothing is asked for until the pictures on screen are in, and then only when the browser is idle", async () => {
  const { w, rest, idle } = await page();
  const imgs = ["a", "b", "c"].map((n) => poster(n));
  imgs.forEach((im) => w.offer(im));
  rest();
  assert.deepEqual(eager(imgs), [], "the screen's own pictures are still on their way");
  w.go();
  assert.deepEqual(eager(imgs), [], "not in the same task: when the browser is idle");
  assert.equal(idle.length, 1);
  rest();
  assert.deepEqual(eager(imgs), ["a", "b", "c"]);
});

test("a few at a time, in the order the page built them; the next when one arrives or fails", async () => {
  const { w, rest } = await page({ flight: 2 });
  const imgs = ["a", "b", "c", "d", "e"].map((n) => poster(n));
  imgs.forEach((im) => w.offer(im));
  w.go();
  rest();
  assert.deepEqual(eager(imgs), ["a", "b"]);
  imgs[0].fire("load");
  assert.deepEqual(eager(imgs), ["a", "b", "c"]);
  imgs[1].fire("error");
  assert.deepEqual(eager(imgs), ["a", "b", "c", "d"]);
  imgs[2].fire("load");
  imgs[3].fire("load");
  imgs[4].fire("load");
  assert.equal(w.flying, 0);
  assert.equal(imgs.reduce((a, im) => a + im.listeners(), 0), 0, "no listener is left on a poster");
});

test("a poster that needs nothing is passed over: already in, already eager, off the page, without an address", async () => {
  const { w, rest } = await page({ flight: 1 });
  const imgs = [
    poster("in", { complete: true, naturalWidth: 300 }),
    poster("eager", { loading: "eager" }),
    poster("gone", { isConnected: false }),
    poster("held", { src: "" }),
    poster("wanted"),
  ];
  imgs.forEach((im) => w.offer(im));
  w.go();
  rest();
  assert.equal(imgs[4].loading, "eager");
  assert.equal(imgs[2].loading, "lazy");
  assert.equal(imgs[3].loading, "lazy");
  assert.equal(w.asked, 1);
});

test("not while it is not allowed (a slow line, Data Saver, a hidden tab, a film): it carries on when that has passed", async () => {
  const { w, env, rest } = await page();
  const imgs = ["a", "b"].map((n) => poster(n));
  env.ok = false;
  imgs.forEach((im) => w.offer(im));
  w.go();
  rest();
  assert.deepEqual(eager(imgs), []);
  assert.equal(w.size, 2, "they keep their place");
  env.ok = true;
  w.nudge();
  rest();
  assert.deepEqual(eager(imgs), ["a", "b"]);
});

test("fewer at a time while the page is being scrolled; the rest when it has come to rest", async () => {
  let room = 1;
  const { w, rest } = await page({ flight: 3, room: () => room });
  const imgs = ["a", "b", "c", "d"].map((n) => poster(n));
  imgs.forEach((im) => w.offer(im));
  w.go();
  rest();
  assert.deepEqual(eager(imgs), ["a"]);
  room = 3;
  w.nudge();
  rest();
  assert.deepEqual(eager(imgs), ["a", "b", "c"]);
});

test("a nudge does not start what the screen's own pictures still hold back", async () => {
  const { w, rest } = await page();
  const im = poster("a");
  w.offer(im);
  w.nudge();
  rest();
  assert.equal(im.loading, "lazy");
});

test("the shelf being paged goes first", async () => {
  const { w, rest } = await page({ flight: 2 });
  const imgs = ["a", "b", "c", "d"].map((n) => poster(n));
  imgs.forEach((im) => w.offer(im));
  const tail = ["t1", "t2"].map((n) => poster(n));
  w.first([...tail, imgs[3]]);
  w.go();
  rest();
  assert.deepEqual(eager(tail), ["t1", "t2"]);
  assert.deepEqual(eager(imgs), []);
  tail[0].fire("load");
  tail[1].fire("load");
  assert.deepEqual(eager(imgs), ["a", "d"], "then the one it named from the page, then the page from its top");
  assert.equal(w.size, 2, "and one named twice is in the queue once");
});

test("a new screen drops what the last one still wanted, and its late answers change nothing", async () => {
  const { w, rest } = await page({ flight: 1 });
  const old = ["a", "b"].map((n) => poster(n));
  old.forEach((im) => w.offer(im));
  w.go();
  rest();
  assert.deepEqual(eager(old), ["a"]);
  w.reset();
  assert.equal(w.size, 0);
  const next = ["x", "y"].map((n) => poster(n));
  next.forEach((im) => w.offer(im));
  rest();
  assert.deepEqual(eager(next), [], "the new screen's own pictures first");
  w.go();
  rest();
  assert.deepEqual(eager(next), ["x"]);
  old[0].fire("load"); // the old screen's picture arrives now
  assert.deepEqual(eager(next), ["x"], "it frees no place on the new screen");
  assert.equal(w.flying, 1);
  assert.equal(old[1].loading, "lazy");
});

test("no more than a page's worth per screen", async () => {
  const { w, rest } = await page({ flight: 3, max: 5 });
  const imgs = Array.from({ length: 9 }, (_, i) => poster(`p${i}`));
  imgs.forEach((im) => w.offer(im));
  w.go();
  rest();
  for (const im of imgs) if (im.loading === "eager") im.fire("load");
  for (const im of imgs) if (im.loading === "eager") im.fire("load");
  assert.equal(eager(imgs).length, 5);
  assert.equal(w.size, 0);
  w.offer(poster("late"));
  assert.equal(w.size, 0, "and nothing more is taken");
});

test("a picture that never answers gives its place back", async () => {
  const { w, rest, timers } = await page({ flight: 1 });
  const imgs = ["a", "b"].map((n) => poster(n));
  imgs.forEach((im) => w.offer(im));
  w.go();
  rest();
  assert.deepEqual(eager(imgs), ["a"]);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual(eager(imgs), ["a", "b"]);
  assert.equal(imgs[0].listeners(), 0);
});

test("outside a browser nothing is allowed, and the module loads", async () => {
  const { warmAllowed, warmOffer, warmFirst, warmReset, warmGo } = await load();
  assert.equal(warmAllowed(), false);
  warmReset();
  warmOffer(poster("a"));
  warmFirst([poster("b")]);
  warmGo();
});
