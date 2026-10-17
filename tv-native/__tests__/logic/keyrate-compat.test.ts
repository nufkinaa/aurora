// The `keyrate` switch (android/.../ui/input/KeyRepeatGate.kt; docs/qa/native-deep/DEVICE-PLAN.md)
// against the JS that reads held keys: the shelf window's "a held key leads further" rule
// (rowWindow.ts nextRun / runMargins, tv-next) must still see ONE run while the gate paces a
// hold, and the gate's pace must never be slower than that rule's gap.
import {HELD_EXTRA, HELD_GAP_MS, MARGINS, nextRun, Run, runMargins, SETTLE_MS} from '../../src/rowWindow';

declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const kotlin = fs.readFileSync(
  path.join(__dirname, '..', '..', 'android/app/src/main/java/com/auroratv/ui/input/KeyRepeatGate.kt'),
  'utf8',
);
const constant = (name: string) => {
  const m = new RegExp(`const val ${name} = (\\d+)L`).exec(kotlin);
  if (!m) throw new Error(`no ${name} in KeyRepeatGate.kt`);
  return Number(m[1]);
};
const INTERVAL = constant('INTERVAL_MS');
const SLACK = constant('SLACK_MS');
const LOST = constant('LOST_MS');
const MAX = constant('MAX_INTERVAL_MS');

// The first frame at or after `interval - slack` — the gate's real pace at a refresh rate.
const pace = (hz: number, interval = INTERVAL) => {
  const v = 1000 / hz;
  return Math.ceil((interval - SLACK) / v - 1e-9) * v;
};

test('the gate paces a hold well inside the held-run gap at every refresh rate', () => {
  for (const hz of [60, 59.94, 50, 30, 24]) {
    expect(pace(hz)).toBeLessThan(HELD_GAP_MS);
  }
  // even the slowest interval the QA override accepts keeps a hold one run
  expect(pace(24, MAX)).toBeLessThanOrEqual(HELD_GAP_MS + 1000 / 24);
  expect(MAX).toBeLessThanOrEqual(HELD_GAP_MS);
  // and a hold the gate stops pacing (no repeat for LOST ms) is still shorter than the
  // shelf's settle time: the window is not cut back under a key that is still down
  expect(LOST).toBeLessThan(SETTLE_MS);
});

test('a paced hold grows the lead to its maximum, as a raw 20/s hold does', () => {
  const walk = (gap: number, presses: number) => {
    let run: Run | null = null;
    let t = 0;
    for (let i = 0; i < presses; i++) {
      run = nextRun(run, 1, t);
      t += gap;
    }
    return run!;
  };
  const paced = walk(pace(59.94), 12);
  const raw = walk(50, 12);
  expect(paced.n).toBe(12);
  expect(runMargins(MARGINS, paced.n)).toEqual(runMargins(MARGINS, raw.n));
  expect(runMargins(MARGINS, paced.n).lead).toBe(MARGINS.lead + HELD_EXTRA);
});

test('the built-in pace is 15 moves a second at 59.94 Hz', () => {
  expect(INTERVAL).toBe(66);
  expect(SLACK).toBe(6);
  expect(1000 / pace(59.94)).toBeCloseTo(14.985, 2);
  expect(1000 / pace(50)).toBeCloseTo(16.667, 2);
});
