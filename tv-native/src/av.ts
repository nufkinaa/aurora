// Picture and sound on this TV (TV round 2026-10-19) — the native calls
// (AvModule.kt, "AuroraAv") and what is kept around them. The rules are in
// avCaps.ts (pure, tested); this file only does things:
//
//   reportCaps()        once per launch per server: what this box can play
//                       (getCapabilities → buildReport) → POST /api/caps → the
//                       id the title reads carry (?caps=, api.ts capsQuery)
//   matchFrameRate(fps) the screen to the film's frame rate before the film
//                       starts (a non-seamless mode switch: the HDMI blink),
//                       resolved once the screen has settled
//   restoreFrameRate()  the screen's own mode again on leaving the player
//                       (a moment later, so a next episode at the same rate
//                       does not blink twice)
//   setPassthrough(on)  ExoPlayer's audio sink with the TV's / soundbar's
//                       passthrough, or plain stereo PCM ("Surround sound:
//                       Stereo only") — read when the player is built
//   noteLie(lie)        a capability that turned out false: kept, and the
//                       report sent again without it
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules} from 'react-native';
import {buildReport, FRAME_RATE_SETTLE_MS, FRAME_RATE_WAIT_MS, Lies, mergeLies, NativeAv} from './avCaps';

type AvNative = {
  getCapabilities: () => Promise<NativeAv>;
  matchFrameRate: (fps: number, waitMs: number, settleMs: number) => Promise<FrameRateResult>;
  restoreFrameRate: (delayMs: number) => void;
  setPassthrough: (on: boolean) => void;
};
export type FrameRateResult = {switched: boolean; reason?: string; fromHz?: number; toHz?: number; ms?: number; timedOut?: boolean};

const native = (): AvNative | null => (NativeModules as {AuroraAv?: AvNative}).AuroraAv || null;

const LIES_KEY = 'aurora.av.lies';
const CAPS_KEY = 'aurora.av.capsId';

// ---------------------------------------------------------------- the report
let capsId: string | null = null;
let reportedFor: string | null = null; // the server the report went to this launch
let reporting: Promise<string | null> | null = null;
let lastPost: ((r: unknown) => Promise<{id?: string}>) | null = null;

/** The id of this box's report, for the reads that ask how a title plays
 *  (null until known — then the server answers without a decision). */
export const currentCapsId = (): string | null => capsId;

// The id the last launch was given: the same box says the same thing, so it
// is the right id at once, before this launch's report has been answered.
AsyncStorage.getItem(CAPS_KEY)
  .then(v => {
    if (!capsId && v && /^[0-9a-f]{16}$/.test(v)) capsId = v;
  })
  .catch(() => {});

// A lie is remembered for a month: a firmware update, a new soundbar, a
// cable swapped can make it true after all, and then the box says so again.
const LIES_KEEP_MS = 30 * 24 * 3600 * 1000;
const loadLies = async (): Promise<Lies> => {
  try {
    const raw = await AsyncStorage.getItem(LIES_KEY);
    const kept = raw ? (JSON.parse(raw) as {at?: number; lies?: Lies}) : null;
    return kept && kept.lies && Date.now() - (kept.at || 0) < LIES_KEEP_MS ? kept.lies : {};
  } catch {
    return {};
  }
};

/** Say what this box can play, to the server at `serverKey` (once per launch
 *  per server; `force` sends it again — after a lie). */
export const reportCaps = (post: (r: unknown) => Promise<{id?: string}>, serverKey: string, force = false): Promise<string | null> => {
  const n = native();
  if (!n) return Promise.resolve(null);
  lastPost = post;
  if (!force && reportedFor === serverKey && reporting) return reporting;
  reportedFor = serverKey;
  reporting = (async () => {
    try {
      const [caps, lies] = await Promise.all([n.getCapabilities(), loadLies()]);
      const report = buildReport(caps, lies);
      const res = await post(report);
      if (res && typeof res.id === 'string' && /^[0-9a-f]{16}$/.test(res.id)) {
        capsId = res.id;
        AsyncStorage.setItem(CAPS_KEY, res.id).catch(() => {});
        console.log(`[av] capabilities reported: ${res.id} (${Object.keys(report.video).join(' ')} · pass ${report.audio.passthrough.join(' ') || '-'} · hdr ${report.hdr.join(' ') || '-'})`);
      }
      return capsId;
    } catch (e) {
      console.log('[av] capabilities not reported:', (e as Error)?.message || e);
      reportedFor = null; // asked again next time
      return capsId;
    }
  })();
  return reporting;
};

/** A capability this box claimed and could not deliver: kept on the box, and
 *  the report sent again without it (the next title already plays by it). */
export const noteLie = async (lie: Lies | null) => {
  if (!lie) return;
  try {
    const next = mergeLies(await loadLies(), lie);
    await AsyncStorage.setItem(LIES_KEY, JSON.stringify({at: Date.now(), lies: next}));
    console.log('[av] a capability did not hold:', JSON.stringify(lie));
  } catch {}
  if (lastPost && reportedFor) reportCaps(lastPost, reportedFor, true);
};

// ---------------------------------------------------------------- the screen
/** The screen to the film's frame rate. Never throws: an answer of "not
 *  switched" (no matching mode, already right, no native side) is as good as
 *  any for the caller, which starts the film either way. */
export const matchFrameRate = async (fps: number): Promise<FrameRateResult> => {
  const n = native();
  if (!n || typeof n.matchFrameRate !== 'function') return {switched: false, reason: 'no native side'};
  try {
    // (a native side that never answers must not hold the film: the native
    // wait is bounded already, this bounds the bridge as well)
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<FrameRateResult>(resolve => {
      timer = setTimeout(() => resolve({switched: false, reason: 'no answer'}), FRAME_RATE_WAIT_MS + FRAME_RATE_SETTLE_MS + 2000);
    });
    const r = await Promise.race([n.matchFrameRate(fps, FRAME_RATE_WAIT_MS, FRAME_RATE_SETTLE_MS), late]);
    if (timer) clearTimeout(timer);
    return r;
  } catch (e) {
    return {switched: false, reason: String((e as Error)?.message || e)};
  }
};

/** The screen's own mode again (after `delayMs`; a match asked meanwhile cancels it). */
export const restoreFrameRate = (delayMs = 1500) => {
  try {
    native()?.restoreFrameRate(delayMs);
  } catch {}
};

// ---------------------------------------------------------------- the sound
export const setPassthrough = (on: boolean) => {
  try {
    native()?.setPassthrough(on);
  } catch {}
};
