// Aurora Play — numbers that arrive (pure). A port of wheelPlan from
// public/js/play/count.js: which wheels a text needs and how far each one
// travels. Each digit is a wheel that rolls up to its value; the units wheel
// spins the most laps, the leading digit the fewest, so the number lands left
// to right like a fruit machine. Anything that is not a digit stands still.
export type Wheel = {char: string} | {digit: number; steps: number};

export const wheelPlan = (text: string | number, laps = 2): Wheel[] => {
  const chars = [...String(text)];
  const digitCount = chars.filter(c => /\d/.test(c)).length;
  let seen = 0;
  return chars.map(c => {
    if (!/\d/.test(c)) return {char: c};
    const fromRight = digitCount - 1 - seen++;
    // the units wheel spins `laps` full turns, each wheel to its left one fewer
    const spins = Math.max(0, laps - fromRight);
    const n = Number(c);
    return {digit: n, steps: spins * 10 + n};
  });
};

// How long wheel k of n takes when the whole number takes `ms`: the leftmost
// lands first, each next a beat later (count.js's `--odo-ms`).
export const wheelMs = (ms: number, k: number, n: number) =>
  Math.round(ms * (0.62 + 0.38 * (n > 1 ? k / (n - 1) : 1)));
