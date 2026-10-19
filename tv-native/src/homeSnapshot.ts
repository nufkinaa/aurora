// Home's last answer, kept on the box, so the next launch paints Home at once.
//
// elia, 2026-10-19: a faster first screen, "but not a whole change of
// everything when the user is seeing this". Boot still finds the server and
// checks the profile as it always did (App.tsx); what no longer waits is
// Home itself: the moment the profile is confirmed, Home is drawn from the
// answer the server gave last time — and its pictures, which are still in
// Fresco's disk cache under the same addresses — while the new answer is
// asked for. The new answer is merged in by homeMerge.ts's rule (nothing on
// screen moves).
//
// WHAT IS KEPT, per profile: the answer's text as the server sent it (its
// blur-up placeholders included), when it came, from which server, and whom
// it was filtered for (`audience`: "all", or "kids:<age>" — the server says
// so on every answer it filters, X-Aurora-Kids; api.ts audienceOf).
//
// WHEN IT IS PAINTED — all of these, or the screen waits for the server as
// it did before (`usable`):
//   - it is THIS profile's (the key and the record both say so) and from
//     THIS server;
//   - it is at most a day old (a box switched on after a weekend starts
//     from the skeleton: two-day-old shelves are not "the last session");
//   - its audience is the one this profile has NOW. What the server said
//     this run decides (the profile's first answers at boot carry the
//     header); with nothing said yet, the kids lock on the box does
//     (storage.ts): locked to this profile → only its kids answer; locked to
//     another → nothing; no lock → only an unfiltered one. And when the new
//     answer arrives filtered differently from what was painted, Home takes
//     it whole, merge or no merge (Home.tsx). A kids profile is never shown
//     a grown-up's shelves from here.
//
// At most four profiles are kept (the oldest goes); a profile change empties
// the copy held in memory (profileScope.ts), never the box's.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {takeBlur} from './blur';
import {registerProfileCache} from './profileScope';
import {loadKidsLock} from './storage';

export const SNAPSHOT_MAX_AGE_MS = 24 * 3600 * 1000;
// /api/home?slim=1 is ~240 KB for a household profile (2026-10-19); one entry
// in Android's AsyncStorage is safe well past that, and a bigger answer is
// simply not kept.
export const SNAPSHOT_MAX_CHARS = 1500 * 1024;
export const SNAPSHOT_MAX_KEPT = 4;

const META = (profileId: string) => `aurora.homeSnap.${profileId}`;
const TEXT = (profileId: string) => `aurora.homeSnapText.${profileId}`;
const INDEX = 'aurora.homeSnaps';

export type SnapshotMeta = {v: 1; at: number; server: string; profileId: string; audience: string; chars: number};
export type Snapshot = SnapshotMeta & {text: string};
export type KidsLockLike = {id: string; maxAge: number} | null;

/** The audience a profile must have been filtered for: what the server said
 *  this run, else what the box's kids lock implies (null: none may be shown). */
export function expectedAudience(profileId: string, said: string | null | undefined, lock: KidsLockLike): string | null {
  if (said) return said;
  if (lock && lock.id === profileId) return `kids:${lock.maxAge}`;
  if (lock) return null;
  return 'all';
}

/** May this record be painted for this server, profile and audience, now? Pure. */
export function usable(
  rec: Snapshot | null | undefined,
  want: {server: string | null; profileId: string | null; audience: string | null; now: number},
): boolean {
  if (!rec || rec.v !== 1 || typeof rec.text !== 'string' || !rec.text) return false;
  if (!want.profileId || rec.profileId !== want.profileId) return false;
  if (!want.server || rec.server !== want.server) return false;
  if (!want.audience || rec.audience !== want.audience) return false;
  const age = want.now - rec.at;
  return age >= 0 && age <= SNAPSHOT_MAX_AGE_MS;
}

/** The record's answer, ready to draw (the placeholders filed, as a fresh read files them). */
export function snapshotHome<T>(rec: Snapshot): T | null {
  try {
    const body = JSON.parse(rec.text);
    if (!body || !Array.isArray(body.rows) || !Array.isArray(body.hero)) return null;
    return takeBlur(body) as T;
  } catch {
    return null;
  }
}

const readMeta = (raw: string | null): SnapshotMeta | null => {
  try {
    const m = raw ? JSON.parse(raw) : null;
    return m && m.v === 1 && typeof m.at === 'number' && typeof m.profileId === 'string' && typeof m.server === 'string' && typeof m.audience === 'string'
      ? m
      : null;
  } catch {
    return null;
  }
};

/** The box's record for this profile, or null. Never throws. */
export async function loadSnapshot(profileId: string): Promise<Snapshot | null> {
  try {
    const [rawMeta, text] = await Promise.all([AsyncStorage.getItem(META(profileId)), AsyncStorage.getItem(TEXT(profileId))]);
    const meta = readMeta(rawMeta);
    if (!meta || meta.profileId !== profileId || typeof text !== 'string' || !text) return null;
    if (meta.chars && meta.chars !== text.length) return null; // half written
    return {...meta, text};
  } catch {
    return null;
  }
}

/** Keep this answer for the next launch. Quietly does nothing when it is too big. */
export async function saveSnapshot(rec: Snapshot): Promise<boolean> {
  if (!rec.profileId || !rec.server || !rec.text || rec.text.length > SNAPSHOT_MAX_CHARS) return false;
  try {
    const meta: SnapshotMeta = {v: 1, at: rec.at, server: rec.server, profileId: rec.profileId, audience: rec.audience, chars: rec.text.length};
    // the text first: a record is only ever read through its meta
    await AsyncStorage.setItem(TEXT(rec.profileId), rec.text);
    await AsyncStorage.setItem(META(rec.profileId), JSON.stringify(meta));
    let list: string[] = [];
    try {
      const raw = await AsyncStorage.getItem(INDEX);
      const v = raw ? JSON.parse(raw) : [];
      if (Array.isArray(v)) list = v.filter(x => typeof x === 'string');
    } catch {}
    const next = [rec.profileId, ...list.filter(id => id !== rec.profileId)];
    for (const old of next.slice(SNAPSHOT_MAX_KEPT)) await dropSnapshot(old, false);
    await AsyncStorage.setItem(INDEX, JSON.stringify(next.slice(0, SNAPSHOT_MAX_KEPT)));
    return true;
  } catch {
    return false;
  }
}

export async function dropSnapshot(profileId: string, fromIndex = true): Promise<void> {
  try {
    await AsyncStorage.removeItem(META(profileId));
    await AsyncStorage.removeItem(TEXT(profileId));
    if (fromIndex) {
      const raw = await AsyncStorage.getItem(INDEX);
      const v = raw ? JSON.parse(raw) : [];
      if (Array.isArray(v)) await AsyncStorage.setItem(INDEX, JSON.stringify(v.filter(x => x !== profileId)));
    }
  } catch {}
}

// ---- read ahead, during boot ------------------------------------------------
// App.tsx starts the read the moment it knows which profile this box was in —
// in parallel with finding the server — so it is in memory by the time Home
// mounts, and Home's FIRST render can draw it.
export type Primed = {rec: Snapshot | null; lock: KidsLockLike};
let primed: {profileId: string; p: Promise<Primed>; got: Primed | undefined} | null = null;

export function primeSnapshot(profileId: string | null): void {
  if (!profileId) return;
  if (primed && primed.profileId === profileId) return;
  const p: Promise<Primed> = Promise.all([loadSnapshot(profileId), loadKidsLock().catch(() => null)]).then(([rec, lock]) => ({rec, lock}));
  const slot: NonNullable<typeof primed> = {profileId, p, got: undefined};
  primed = slot;
  p.then(got => {
    slot.got = got;
  });
}

/** The read-ahead: the record (null: none) and the box's kids lock — or
 *  undefined while it is still being read (or nobody asked). */
export const primedSnapshot = (profileId: string): Primed | undefined =>
  primed && primed.profileId === profileId ? primed.got : undefined;

/** The same, waited for (read now when nobody read ahead). */
export const whenSnapshot = (profileId: string): Promise<Primed> => {
  primeSnapshot(profileId);
  return primed!.p;
};

registerProfileCache('homeSnapshot', () => {
  primed = null;
});

// ---- the launch, in marks ---------------------------------------------------
// `adb logcat -s ReactNativeJS | grep faststart`: when each step of the way
// to a usable Home happened, in ms since the bundle began to run (the device
// checks in docs/qa/fast-start/REPORT.md read these).
const T0 = Date.now();
const marked = new Set<string>();
export const sinceStart = () => Date.now() - T0;
export function markLaunch(phase: string, extra = ''): void {
  if (marked.has(phase)) return;
  marked.add(phase);
  console.log(`[faststart] ${phase} t=${sinceStart()}ms${extra ? ' ' + extra : ''}`);
}
