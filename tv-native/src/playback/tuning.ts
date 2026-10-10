// The player's start-up tuning.
//
// Three things about how a film starts can only be judged on the TV itself,
// on real lines — so they are not constants of the build. The app asks the
// server once (GET /api/tv/tuning, the admin's config.json "tvPlayer") and
// uses what it is told; anything not told is the value this build has always
// had. A server that predates the endpoint answers 404 and changes nothing.
//
//   startBufferMs    film ExoPlayer must have buffered before it shows the
//                    first frame (bufferForPlaybackMs). 2000 here. On a line
//                    that carries the file with room to spare the buffer
//                    fills in a blink either way; on a thin one this is
//                    two seconds of film the viewer waits for with a black
//                    screen.
//   rebufferMs       the same after a stall (bufferForPlaybackAfterRebufferMs).
//                    8000 here.
//   resumeAtSource   a library file that plays as itself is OPENED at the
//                    resume point (the source's startPosition) instead of at
//                    0:00 and then sought: one seek, and the bytes of the
//                    film's first seconds, saved on every resume.
//
// docs/qa/ttff/REPORT.md (in the repo) has the device measurement plan.
import {api} from '../api';

export type Tuning = {
  startBufferMs: number;
  rebufferMs: number;
  resumeAtSource: boolean;
};

/** What this build does when the server says nothing. */
export const TUNING_DEFAULTS: Tuning = {
  startBufferMs: 2000,
  rebufferMs: 8000,
  resumeAtSource: false,
};

/** PURE: the server's answer over the defaults; anything odd is ignored. */
export const applyTuning = (raw: unknown, base: Tuning = TUNING_DEFAULTS): Tuning => {
  const out = {...base};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;
  const start = num(r.startBufferMs, 250, 5000);
  const again = num(r.rebufferMs, 1000, 20000);
  if (start != null) out.startBufferMs = start;
  if (again != null) out.rebufferMs = again;
  // never resume on less than a start needs
  if (out.rebufferMs < out.startBufferMs) out.rebufferMs = out.startBufferMs;
  if (typeof r.resumeAtSource === 'boolean') out.resumeAtSource = r.resumeAtSource;
  return out;
};

let current: Tuning = TUNING_DEFAULTS;
let asked = 0;

/** The tuning in force right now (the defaults until the server has answered). */
export const tuning = (): Tuning => current;

/** Ask the server (at most once a minute). Never throws, never blocks a start:
 *  a player that opens before the answer is in simply uses what is known. */
export const refreshTuning = (): void => {
  if (Date.now() - asked < 60000) return;
  asked = Date.now();
  api
    .tvTuning()
    .then(raw => {
      current = applyTuning(raw);
    })
    .catch(() => {
      // an older server (404), or no line: what we have stands
    });
};
