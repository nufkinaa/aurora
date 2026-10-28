// A film that stops mid-play comes back BY ITSELF, at the same spot — and
// when it cannot, the viewer is told, with Try again from that spot. Never a
// still picture for minutes, never a restart at 0:00.
//
// The website's rule since 1.13.7 (public/js/screens/player.js mseAgain and
// its stall watcher; docs/qa/perf-ttff/REPORT.md cause 9), for ExoPlayer:
//
//  • AN ERROR on a film that has been playing (its codec decoded fine a
//    moment ago, so the codec is not what failed): the same source again at
//    the same spot, 0.3 s and then 2 s later. A third error within three
//    minutes is not tried by itself — the card, and one more quiet try every
//    30 s behind it while it is up. A source this device has not really
//    played (half a minute of it) that keeps failing may be refused by the
//    decoder after all: that one gets the full encode instead, as a copy
//    refused at its very start does (Player.tsx onError's ladder).
//  • A FROZEN PICTURE (the clock stands still while the film should be
//    playing — buffering, an errored player, a decoder that hung): a nudge at
//    6 s, the same source again at 20 s (two of those per five minutes), and
//    at 45 s the card (playerRules.ts stallStep).
//  • A pause the player makes on an error is not the viewer's: only the
//    viewer's pause (the `paused` prop, which ExoPlayer never sets) stops the
//    count.
//
// Pure logic, no React: Player.tsx keeps the refs and calls these.

import {stallStep} from '../playerRules';

/** Reloads of the same source after an error, within AGAIN_WINDOW_MS. */
export const AGAIN_MAX = 2;
export const AGAIN_WINDOW_MS = 3 * 60000;
/** How long after the 1st / 2nd error the source is handed over again. */
export const AGAIN_DELAYS_MS = [300, 2000];
/** While the card is up, one more quiet try this often. */
export const CARD_RETRY_MS = 30000;
/** Less than this much of a path played: a failure may be the device refusing it. */
export const REFUSED_UNDER_S = 30;
/** The frozen-picture watcher's own reloads (20 s into a stall), per budget window. */
export const STALL_MAX_REBUILDS = 2;
export const STALL_BUDGET_MS = 5 * 60000;

// The card's words — the website's, word for word.
export const STOPPED_FILM = "The film stopped and didn't come back by itself. Try again from the same spot, or go back.";
export const STOPPED_STREAM = "The stream stopped and didn't come back by itself. Try again from the same spot, or go back.";
export type StopKind = 'film' | 'stream';
export const stopWords = (k: StopKind) => (k === 'film' ? STOPPED_FILM : STOPPED_STREAM);

const prune = (list: number[], now: number, windowMs: number) => {
  while (list.length && now - list[0] > windowMs) list.shift();
};

export type AgainStep =
  | {kind: 'again'; delayMs: number; n: number}
  | {kind: 'encode'}
  | {kind: 'card'};

/**
 * An error on a film that has been playing. `tries` is the list of earlier
 * reloads (timestamps), kept by the caller and updated here.
 *  played     seconds this device has played of the CURRENT path (direct / copy)
 *  canEncode  a heavier rung (the full encode) is still unused for this film
 */
export const againStep = (tries: number[], now: number, o: {played: number; canEncode: boolean}): AgainStep => {
  prune(tries, now, AGAIN_WINDOW_MS);
  if (tries.length >= AGAIN_MAX) {
    if (o.canEncode && o.played < REFUSED_UNDER_S) return {kind: 'encode'};
    return {kind: 'card'};
  }
  tries.push(now);
  return {kind: 'again', delayMs: AGAIN_DELAYS_MS[tries.length - 1] ?? AGAIN_DELAYS_MS[AGAIN_DELAYS_MS.length - 1], n: tries.length};
};

// ---------------------------------------------------------------- the watcher
export type Watch = {
  lastCt: number;
  since: number;
  nudged: boolean;
  rebuilt: boolean;
  carded: boolean;
  /** A reload of ours is coming back: the clock's jumps (to 0, to the spot)
   *  are not the film moving, and do not end the stall. Forward play does. */
  hold: boolean;
  rebuilds: number[];
};
export const watchNew = (): Watch => ({lastCt: 0, since: 0, nudged: false, rebuilt: false, carded: false, hold: false, rebuilds: []});
const resetStall = (w: Watch) => {
  w.since = 0;
  w.nudged = false;
  w.rebuilt = false;
  w.carded = false;
};
/** Forget the current stall (Try again pressed): the next one is counted from scratch. */
export const watchReset = (w: Watch) => {
  resetStall(w);
  w.rebuilds.length = 0;
};

export type WatchIn = {
  now: number;
  /** content time now */
  ct: number;
  /** the film should be moving: it has shown a picture, the viewer has not
   *  paused it, no seek or switch owns the moment, no card is up */
  countable: boolean;
  /** the current source has loaded (a nudge needs something to seek in) */
  loaded: boolean;
  /** in a watch party: the party waits for this TV — no reload, no card (the website's rule) */
  party: boolean;
};
/** 'moved': the film is playing (a card up for it can go). */
export type WatchOut = 'moved' | 'nudge' | 'rebuild' | 'card' | null;

/** One tick (once a second) of the frozen-picture watcher. */
export const watchTick = (w: Watch, i: WatchIn): WatchOut => {
  const delta = i.ct - w.lastCt;
  w.lastCt = i.ct;
  // playing: a step the size of a second or so
  if (delta > 0.2 && delta <= 4) {
    w.hold = false;
    resetStall(w);
    return 'moved';
  }
  // a jump: the viewer's seek starts the count again; our own reload's is
  // part of the stall it is mending
  if (Math.abs(delta) > 0.2 && !w.hold) {
    resetStall(w);
    return null;
  }
  if (!i.countable) {
    resetStall(w);
    return null;
  }
  if (!w.since) w.since = i.now;
  const step = stallStep(i.now - w.since, w);
  if (step === 'nudge') {
    w.nudged = true;
    return i.loaded ? 'nudge' : null;
  }
  if (step === 'rebuild') {
    w.rebuilt = true;
    if (i.party) return null;
    prune(w.rebuilds, i.now, STALL_BUDGET_MS);
    if (w.rebuilds.length >= STALL_MAX_REBUILDS) {
      // the reloads this film may have are spent and it is still frozen:
      // never a still picture with nothing said
      w.carded = true;
      return 'card';
    }
    w.rebuilds.push(i.now);
    w.hold = true;
    return 'rebuild';
  }
  if (step === 'card') {
    w.carded = true;
    return i.party ? null : 'card';
  }
  return null;
};

/** Where a reload goes back to: a seek or resume still pending, else the
 *  spot our reload is heading for, else where the film stood. Never 0:00
 *  for a film that was further on. */
export const spotOf = (o: {resumeAt: number; held: number; cur: number}) =>
  o.resumeAt > 0 ? o.resumeAt : o.held > 0 ? o.held : Math.max(0, o.cur);
