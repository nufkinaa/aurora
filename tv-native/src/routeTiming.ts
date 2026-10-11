// The `route` usage event: which screen was opened and how long it took to
// show its content — the website's event of the same name (public/js/
// router.js: from the start of a page's render to the frame after its data
// is drawn; the admin's Analytics tab reads `ms` as "time to painted",
// src/lib/usage.js).
//
// DEFINED HERE AS: from the navigation (the press that asked for the screen —
// navLock's stamp — or, when nothing stamped it, the moment the screen became
// the current route) to the first time that screen says its CONTENT is on:
// its first list has arrived and been committed (useRouteShown.ts, called by
// each screen with its own "ready"). Sent once per visit.
//
// A RETURN to a screen that is still mounted (Back from a title to Home) is
// a visit but not a load: it is counted (`r`, no `ms`), never timed — a few
// milliseconds for a screen that was already drawn would drag every
// percentile toward zero.
//
// Before 5.1.32 the TV sent, under the NEW screen's name, the time that had
// been spent on the PREVIOUS screen (audit X5): the TV rows of that table
// were meaningless.
import {lastNavAt} from './navLock';
import {track} from './usage';
import {navPaint, setScreen} from './telemetry';

type Visit = {r: string; key: string; at: number; sent: boolean};
let cur: Visit | null = null;
// A screen whose content was ready in its first commit reports before the
// navigator has announced the route (a child's effects run first): held here.
let early: {key: string; timed: boolean; at: number} | null = null;
const CAP_MS = 120000; // the aggregator's own ceiling
// A press older than this did not cause the navigation being announced (a
// Back press, an episode that started by itself).
const RECENT_MS = 2500;

const send = (v: Visit, timed: boolean, now: number) => {
  v.sent = true;
  if (timed) {
    const ms = Math.max(0, Math.min(CAP_MS, now - v.at));
    track('route', {r: v.r, ms});
    // the same measurement, to the timings store (docs/analytics.md `nav_paint`:
    // navigation start → first content painted — this file's definition)
    navPaint(ms, v.r);
  } else track('route', {r: v.r});
};

/** The navigator says `key` is now the current route (`r`: its usage name). */
export const routeStarted = (r: string, key: string, now = Date.now()) => {
  if (cur && cur.key === key) return; // the same screen (its params changed)
  // left before it ever said its content was on (or a screen that does not
  // report): a visit all the same, counted without a time
  if (cur && !cur.sent) send(cur, false, now);
  // the press that led here, when it was recent enough to be this navigation
  const pressed = lastNavAt();
  cur = {r, key, at: pressed && now - pressed < RECENT_MS ? pressed : now, sent: false};
  // the reports' idea of "which screen" changes NOW — not when the `route`
  // event is sent, which is when the content is on (or the screen is left)
  setScreen(r);
  if (early && early.key === key) {
    const e = early;
    early = null;
    send(cur, e.timed, e.at);
  } else {
    early = null;
  }
};

/** Screen `key` has its content on. `timed`: this is the first time since it
 *  was mounted (a load); false for a return to a screen already drawn. */
export const routeShown = (key: string, timed: boolean, now = Date.now()) => {
  if (cur && cur.key === key) {
    if (!cur.sent) send(cur, timed, now);
    return;
  }
  early = {key, timed, at: now};
};

/** Test-only. */
export const _routeInternals = {
  reset: () => {
    cur = null;
    early = null;
  },
};
