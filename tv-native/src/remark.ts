// Home's remark for the apps (the website's is public/js/remark.js): Aurora's
// voice comes from the server — GET /api/profiles/:id/remark, src/lib/remarks
// — one bank and one memory of what this person was told, for every app.
// This file keeps the same ten-minute hold on the device (in memory, and in
// AsyncStorage so a restart of the app inside the hold says the same thing),
// sends back the ids it was shown (so a restarted server does not repeat
// itself) and has the website's few local lines for when there is no answer.
//
//   const first = remarkNow(profileId);            // sync: held line or a local one
//   const r = await fetchRemark(profileId);        // the server's (or the same local one)
//
// Every local line is also in the server's bank (test/remarks.test.js checks).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {apiRequest} from './api';
import {registerProfileCache} from './profileScope';

export const REMARK_HOLD_MS = 10 * 60 * 1000;
const SEEN_MAX = 40;

export type Remark = {id: string | null; text: string; kind: string};

// part of the day → the same lines as the website's (5–12, 12–17, 17–23, 23–5)
const LOCAL: Record<'morning' | 'afternoon' | 'evening' | 'night' | 'any', string[]> = {
  morning: [
    "Morning. Most people start the day. You're previewing it.",
    'Before noon and already avoiding something. Impressive.',
    'You checked here before you checked the weather.',
    'Morning. Your taste is no better rested than you are.',
    "The day is a blank page. You've decided to read instead.",
    "Morning. You'll call it background noise. It never is.",
  ],
  afternoon: [
    'Afternoon. The day had potential. Then you opened this.',
    "You said you'd be productive today. I was there.",
    "Afternoon. I'd suggest a walk. You'd suggest a sequel.",
    'Outside is having a lovely day without you.',
    "Just browsing, you'll say. For forty minutes.",
  ],
  evening: [
    'The couch is preheated.',
    'One episode. Sure. “One.”',
    "You'll scroll past six good films tonight. I'll count.",
    "Big screen, small ambitions. Let's begin.",
    'The remote has seen things. Mostly your indecision.',
    "Tonight's feature: twenty minutes of trailers you'll skip.",
  ],
  night: [
    "Bedtime was a suggestion. You've declined.",
    "Tomorrow-you has opinions. Tonight-you doesn't care.",
    'Midnight is close. Your judgment left an hour ago.',
    "It's past eleven. Pick something short. Or lie to me.",
  ],
  any: [
    "I know what you watched. I'm choosing not to bring it up.",
    'No judgment here. Just a detailed, permanent record.',
    'The play button works. I checked. It was never the problem.',
    'Trust the first instinct. Your fourth is always worse.',
    "Your taste is consistent. I'm being polite.",
    "You'll read every synopsis, then pick by the poster.",
  ],
};
export const LOCAL_LINES: string[] = Object.values(LOCAL).flat();

const partOf = (h: number) => (h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 23 ? 'evening' : 'night');

type Kept = {held: (Remark & {at: number}) | null; seen: string[]; local: (Remark & {at: number}) | null; restored: boolean};
const kept = new Map<string, Kept>();
const keptOf = (profileId: string): Kept => {
  let k = kept.get(profileId);
  if (!k) {
    k = {held: null, seen: [], local: null, restored: false};
    kept.set(profileId, k);
  }
  return k;
};
const KEY = (profileId: string) => `aurora.remark.${profileId}`;

// A local line for now: this part of the day or any time, not the last one.
export function localRemark(now: Date = new Date(), rng: () => number = Math.random, last?: string | null): string {
  const pool = [...LOCAL[partOf(now.getHours())], ...LOCAL.any].filter(t => t !== last);
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

// What to show on the first frame: the line held for this profile (server's or
// local) while its ten minutes last, else a new local one, held in its turn.
export function remarkNow(profileId: string, now: number = Date.now(), rng: () => number = Math.random): Remark {
  const k = keptOf(profileId);
  if (k.held && now - k.held.at >= 0 && now - k.held.at < REMARK_HOLD_MS) return {id: k.held.id, text: k.held.text, kind: k.held.kind};
  if (k.local && now - k.local.at >= 0 && now - k.local.at < REMARK_HOLD_MS) return {id: null, text: k.local.text, kind: 'local'};
  const text = localRemark(new Date(now), rng, k.local ? k.local.text : null);
  k.local = {id: null, text, kind: 'local', at: now};
  return {id: null, text, kind: 'local'};
}

// The query the server reads: the device's clock, nothing personal.
export function remarkQuery(now: Date, tz: string | null, seen: string[]): string {
  const parts = [`tzo=${now.getTimezoneOffset()}`];
  if (tz) parts.push(`tz=${encodeURIComponent(tz)}`);
  if (seen.length) parts.push(`seen=${seen.slice(-SEEN_MAX).join(',')}`);
  return parts.join('&');
}

const zone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

async function restore(profileId: string, k: Kept) {
  if (k.restored) return;
  k.restored = true;
  try {
    const raw = await AsyncStorage.getItem(KEY(profileId));
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.seen)) k.seen = [...v.seen.filter((x: unknown) => typeof x === 'string'), ...k.seen].slice(-SEEN_MAX);
    if (!k.held && v && v.held && typeof v.held.text === 'string' && typeof v.held.at === 'number') k.held = v.held;
  } catch {}
}

type Fetcher = (path: string) => Promise<Remark | null>;
const defaultFetcher: Fetcher = path => apiRequest<Remark | null>(path);

// The server's line for this visit (held for ten minutes here as there); on
// any failure, the line remarkNow gave, so the screen never changes for nothing.
export async function fetchRemark(
  profileId: string,
  {now = Date.now(), fetcher = defaultFetcher}: {now?: number; fetcher?: Fetcher} = {},
): Promise<Remark> {
  const k = keptOf(profileId);
  await restore(profileId, k);
  if (k.held && now - k.held.at >= 0 && now - k.held.at < REMARK_HOLD_MS) return {id: k.held.id, text: k.held.text, kind: k.held.kind};
  let r: Remark | null = null;
  try {
    r = await fetcher(`/api/profiles/${encodeURIComponent(profileId)}/remark?${remarkQuery(new Date(now), zone(), k.seen)}`);
  } catch {
    r = null;
  }
  if (!r || typeof r.text !== 'string' || !r.text || !r.id) return remarkNow(profileId, now);
  k.held = {id: r.id, text: r.text, kind: r.kind, at: now};
  k.seen = [...k.seen.filter(x => x !== r!.id), r.id].slice(-SEEN_MAX);
  AsyncStorage.setItem(KEY(profileId), JSON.stringify({held: k.held, seen: k.seen})).catch(() => {});
  return {id: r.id, text: r.text, kind: r.kind};
}

// A profile change drops what was kept in memory (the next profile's own
// hold comes back from AsyncStorage, keyed by its id).
registerProfileCache('remark', () => kept.clear());

// tests only
export const _resetRemarks = () => kept.clear();
