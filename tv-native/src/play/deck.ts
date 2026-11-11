// Aurora Play — the card deck's feel (pure), shared by Taste and Pick
// together. From public/js/play/deck.js.
export const SLAM_MS = 170;

// How many cards the deck still shows: the one on top, the next, two plates.
export const depthOf = (left: number) => Math.max(0, Math.min(4, Math.floor(Number(left) || 0)));

// How many plates lie under the two real cards: fewer than 4 cards left = one
// plate, fewer than 3 = none. The deck visibly runs out.
export const platesOf = (left: number) => Math.max(0, depthOf(left) - 2);

// Where the cards under the top one lie: the next card, then the two plates.
// On the website a card is scaled about its bottom edge, so `peek` is simply
// how far it shows under the one above. A View here is scaled about its
// centre, so the same resting place is a shift of peek + the half it lost.
export const LAYERS = [
  {peek: 8, scale: 0.95}, // the next card
  {peek: 15, scale: 0.9}, // a plate
  {peek: 22, scale: 0.85}, // the last plate
] as const;
export const PEEK = 22; // what the whole deck shows under its top card (dp)
export const layerAt = (k: number, height: number) => {
  const l = LAYERS[Math.max(0, Math.min(LAYERS.length - 1, k))];
  return {translateY: +(l.peek + ((1 - l.scale) * height) / 2).toFixed(1), scale: l.scale};
};

// The answer given with a key, as ONE run 0 -> 1 on the native driver: the
// stamp is slammed onto the card (big to its size, a hair under, then its
// size), the card takes the hit (a nudge to the answer's side), then it is
// thrown. These are the stops of that run; `slam` and `fly` are the two parts'
// times in ms.
export const answerRun = (slam: number = SLAM_MS, fly = 300) => {
  const total = slam + fly;
  const s = slam / total; // where the throw begins
  return {
    total,
    slamEnd: s,
    // the stamp
    stampIn: {inputRange: [0, s * 0.35, 1], outputRange: [0, 1, 1]},
    stampScale: {inputRange: [0, s * 0.75, s, 1], outputRange: [2.2, 0.94, 1, 1]},
    // the card: 0 = at rest, a few hundredths = pushed by the stamp, 1 = gone
    // (thrown = slow to start, then gone: two stops stand in for an ease-in)
    travel: {
      inputRange: [0, s * 0.75, s, s + (1 - s) / 3, s + ((1 - s) * 2) / 3, 1],
      outputRange: [0, 0.035, 0.025, 0.13, 0.46, 1],
    },
    fade: {inputRange: [0, s + (1 - s) * 0.35, 1], outputRange: [1, 1, 0]},
  };
};
