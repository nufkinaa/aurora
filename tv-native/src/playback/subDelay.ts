// The subtitle delay (the CC menu's −5 / −0.5 / +0.5 / +5 / Reset row),
// remembered on THIS BOX per title and per track.
//
// Per track on purpose — the website's `trackOffsets` rule: external
// subtitle files are timed for whichever release their uploader had
// (measured across eight tracks of one film, the first cue landed anywhere
// from 0.0 s to 357.0 s), so a delay that fixes one track is wrong for the
// next. Per title because the same track file is only ever offered for one
// title's file anyway, and the title is what makes the key readable.
//
// Stored as one AsyncStorage entry, `aurora.subDelay`:
//   {"<itemId>|<track url>": seconds, ...}
// in the order last written (JSON objects keep insertion order for string
// keys), capped to the latest MAX_ENTRIES. A delay of 0 (Reset) is no entry.
//
// The rules are pure; the two functions at the bottom do the storage.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const SUB_DELAY_KEY = 'aurora.subDelay';
export const MAX_ENTRIES = 300;
/** A nudge never goes past this either way (the five-second button pressed a
 *  hundred times is a remote resting on the sofa, not a real track). */
export const MAX_DELAY_SEC = 600;

export type DelayMap = Record<string, number>;

export const delayKey = (itemId: string, trackUrl: string) => `${itemId}|${trackUrl}`;

/** One tenth of a second is the step the menu shows; floating sums of 0.5
 *  must not drift into −0.30000000000000004. */
export const roundDelay = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 10) / 10;
  const c = Math.max(-MAX_DELAY_SEC, Math.min(MAX_DELAY_SEC, r));
  return Object.is(c, -0) ? 0 : c;
};

/** A stored blob, read defensively: only finite, non-zero numbers under
 *  string keys survive, and only the latest MAX_ENTRIES. */
export const readDelays = (raw: unknown): DelayMap => {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const entries = Object.entries(obj as Record<string, unknown>).filter(
    ([k, v]) => k.includes('|') && typeof v === 'number' && Number.isFinite(v) && roundDelay(v) !== 0,
  ) as [string, number][];
  return Object.fromEntries(entries.slice(-MAX_ENTRIES).map(([k, v]) => [k, roundDelay(v)]));
};

/** The map after setting `key` to `seconds`: moved to the end (the latest),
 *  removed when it is 0, the oldest dropped past MAX_ENTRIES. */
export const withDelay = (map: DelayMap, key: string, seconds: number): DelayMap => {
  const v = roundDelay(seconds);
  const out: DelayMap = {};
  for (const [k, old] of Object.entries(map)) if (k !== key) out[k] = old;
  if (v !== 0) out[key] = v;
  const keys = Object.keys(out);
  if (keys.length <= MAX_ENTRIES) return out;
  const keep: DelayMap = {};
  for (const k of keys.slice(-MAX_ENTRIES)) keep[k] = out[k];
  return keep;
};

/** This title's delays, by track url. */
export const delaysForItem = (map: DelayMap, itemId: string): Record<string, number> => {
  const prefix = `${itemId}|`;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
};

// ---------------------------------------------------------------- storage
// Writes are chained so two quick nudges can never land out of order (the
// second read-modify-write starting before the first one finished).
let chain: Promise<unknown> = Promise.resolve();

export const loadDelays = async (): Promise<DelayMap> => {
  try {
    return readDelays(await AsyncStorage.getItem(SUB_DELAY_KEY));
  } catch {
    return {};
  }
};

export const saveDelay = (itemId: string, trackUrl: string, seconds: number): Promise<void> => {
  const next = chain.then(async () => {
    try {
      const map = await loadDelays();
      await AsyncStorage.setItem(SUB_DELAY_KEY, JSON.stringify(withDelay(map, delayKey(itemId, trackUrl), seconds)));
    } catch {}
  });
  chain = next;
  return next;
};
