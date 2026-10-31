// [auth-round] The sign-in panel lifts a field clear of the TV's floating
// keyboard (src/authLift.ts), and moves nothing for a field already clear.
import {KEYBOARD_TOP, liftFor} from '../../src/authLift';

test('a field above the keyboard band moves nothing', () => {
  expect(liftFor({top: 150, height: 46, windowHeight: 540})).toBe(0);
  expect(liftFor({top: 540 * KEYBOARD_TOP - 46, height: 46, windowHeight: 540})).toBe(0);
});

test('a field under the band lifts by exactly what it overlaps', () => {
  // bottom at 396 on a 540 window, band starts at 286.2
  expect(liftFor({top: 350, height: 46, windowHeight: 540})).toBe(Math.round(396 - 540 * KEYBOARD_TOP));
});

test('measured while already lifted: the answer is from the resting place', () => {
  const rest = liftFor({top: 350, height: 46, windowHeight: 540});
  expect(liftFor({top: 350 - rest, height: 46, windowHeight: 540, lifted: rest})).toBe(rest);
  // a higher field after a lifted one: the panel comes down to what that one needs
  expect(liftFor({top: 200 - rest, height: 46, windowHeight: 540, lifted: rest})).toBe(0);
});

test('a scaled canvas (a 4K-dp TV) answers in canvas units', () => {
  // window 1080 high, canvas at 2x: the same field, twice the window units
  expect(liftFor({top: 700, height: 92, windowHeight: 1080, scale: 2})).toBe(liftFor({top: 350, height: 46, windowHeight: 540}));
});

test('never lifts a field off the top of the screen', () => {
  expect(liftFor({top: 60, height: 500, windowHeight: 540})).toBe(Math.round(60 - 540 * 0.05));
});
