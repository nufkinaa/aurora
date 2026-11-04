// What the website's player counts as watched (public/js/watchclock.js): the
// same rules as the TV and phone (tv-native/src/watchClock.ts).
const test = require("node:test");
const assert = require("node:assert/strict");

let mod;
test.before(async () => { mod = await import("../public/js/watchclock.js"); });

const run = (steps) => {
  let t = 0;
  const c = mod.createWatchClock({ now: () => t });
  for (const [dt, pos, playing, rate] of steps) { t += dt * 1000; c.tick(pos, { playing, rate: rate || 1 }); }
  return c;
};

test("timeupdates four times a second while playing: a minute is a minute", () => {
  const steps = [];
  for (let i = 0; i <= 240; i++) steps.push([0.25, i * 0.25, true]);
  const c = run(steps);
  assert.equal(Math.round(c.total), 60);
  assert.equal(c.take(), 60);
  assert.equal(c.take(), 0);
});

test("paused, a stall, a seek and a sleeping laptop count nothing", () => {
  const c = run([
    [0.25, 0, true], [1, 1, true], // 1
    [1, 1, false], [3600, 1, false], // paused an hour
    [0.25, 1, true], [1, 2, true], // 1
    [9, 3, true], // stalled 9 s then on
    [0.25, 900, true], // seek
    [1, 901, true], // 1
    [7 * 3600, 902, true], // lid closed 7 hours, on wake the film moved 1 s
  ]);
  assert.equal(Math.round(c.total), 3);
});

test("2x: 30 s of someone's time for a minute of film", () => {
  const steps = [];
  for (let i = 0; i <= 120; i++) steps.push([0.25, i * 0.5, true, 2]);
  assert.equal(Math.round(run(steps).total), 30);
});

test("reset after a seek: the jump is not counted, the play after it is", () => {
  let t = 0;
  const c = mod.createWatchClock({ now: () => t });
  c.tick(10, { playing: true }); t += 1000; c.tick(11, { playing: true });
  c.reset(); t += 250; c.tick(14, { playing: true }); t += 1000; c.tick(15, { playing: true });
  assert.equal(Math.round(c.total), 2);
});
