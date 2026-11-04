// What the TV and phone players count as watched (src/watchClock.ts) — the
// same rules as the website's public/js/watchclock.js (test/watch-clock-web.test.js).
import {createWatchClock, playStateOf} from '../../src/watchClock';

const run = (steps: [number, number, boolean, number?][]) => {
  let t = 0;
  const c = createWatchClock(() => t);
  for (const [dt, pos, playing, rate] of steps) {
    t += dt * 1000;
    c.tick(pos, {playing, rate: rate || 1});
  }
  return c;
};

test('steady playback at 1 Hz counts its seconds', () => {
  const steps: [number, number, boolean][] = [];
  for (let i = 0; i <= 60; i++) steps.push([1, i, true]);
  const c = run(steps);
  expect(Math.round(c.total)).toBe(60);
  expect(c.take()).toBe(60);
  expect(c.take()).toBe(0);
});

test('paused, a stall, a seek and a sleep count nothing', () => {
  const c = run([
    [1, 0, true], [1, 1, true], [1, 2, true], // 2 s
    [1, 2, false], [600, 2, false], // paused 10 min
    [1, 2, true], [1, 3, true], // 1 s
    [8, 4, true], // a stall: 8 s without progress, then one second on
    [1, 600, true], // a seek forward
    [1, 601, true], // 1 s
    [3600, 605, true], // asleep an hour (the film moved 4 s)
  ]);
  expect(Math.round(c.total)).toBe(4);
});

test('2x speed: a minute of film in 30 s is 30 s of someone’s time', () => {
  const steps: [number, number, boolean, number][] = [];
  for (let i = 0; i <= 30; i++) steps.push([1, i * 2, true, 2]);
  expect(Math.round(run(steps).total)).toBe(30);
});

test('the state the server is told', () => {
  const base = {paused: false, buffering: false, progressAgeMs: 500, foreground: true};
  expect(playStateOf(base)).toBe('playing');
  expect(playStateOf({...base, paused: true})).toBe('paused');
  expect(playStateOf({...base, buffering: true})).toBe('buffering');
  expect(playStateOf({...base, progressAgeMs: 10000})).toBe('buffering');
  expect(playStateOf({...base, progressAgeMs: 10000, foreground: false})).toBe('paused');
  expect(playStateOf({...base, ended: true})).toBe('ended');
});
