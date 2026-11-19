// Where a copy saved on the phone begins (phone/offline/rules.ts resumeFrom,
// cw-fix 2026-11-19): its own spot, or the server's when that is clearly newer.
import {resumeFrom, CLOCKS_APART_MS} from '../../src/phone/offline/rules';

const T = 1_800_000_000_000;

test('the server spot wins only when it is clearly newer than the copy’s', () => {
  const copy = {position: 300, positionAt: T};
  expect(resumeFrom(copy, {position: 900, updatedAt: T + CLOCKS_APART_MS + 1000})).toBe(900);
  expect(resumeFrom(copy, {position: 900, updatedAt: T + 30 * 1000})).toBe(300); // within the two clocks' slack
  expect(resumeFrom(copy, {position: 900, updatedAt: T - 60 * 60 * 1000})).toBe(300); // older
});

test('a copy saved by an older build (no time kept) keeps its own spot', () => {
  expect(resumeFrom({position: 300}, {position: 900, updatedAt: T})).toBe(300);
});

test('a finished or barely-started server row, or none, never moves the start', () => {
  const copy = {position: 300, positionAt: T};
  expect(resumeFrom(copy, {position: 900, finished: true, updatedAt: T + 10 * CLOCKS_APART_MS})).toBe(300);
  expect(resumeFrom(copy, {position: 8, updatedAt: T + 10 * CLOCKS_APART_MS})).toBe(300);
  expect(resumeFrom(copy, null)).toBe(300);
  expect(resumeFrom({}, null)).toBe(0);
});
