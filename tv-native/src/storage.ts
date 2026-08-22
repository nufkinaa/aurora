// Thin AsyncStorage wrapper for the few things the TV app must remember across
// launches: which server to talk to, and which profile (+ its unlock token)
// was last used. Tokens live in server RAM only, so a stale one just means the
// profile gate re-appears — never a hard error.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  serverUrl: 'aurora.serverUrl',
  profileId: 'aurora.profileId',
  token: 'aurora.token',
  recentProfiles: 'aurora.recentProfiles',
} as const;

// Which profiles THIS TV has actually been used with, most recent first. A
// household can have 50+ profiles and a remote can only step one tile at a time,
// so the gate puts this device's own profiles first (same fix as the web app).
const RECENT_MAX = 8;

export async function loadRecentProfiles(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.recentProfiles);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
  } catch {
    return []; // a corrupt entry must never block the picker
  }
}

export async function pushRecentProfile(profileId: string) {
  try {
    const list = await loadRecentProfiles();
    const next = [profileId, ...list.filter(id => id !== profileId)].slice(0, RECENT_MAX);
    await AsyncStorage.setItem(KEYS.recentProfiles, JSON.stringify(next));
  } catch {
    // Ordering is a convenience; never fail a profile switch over it.
  }
}

export type Session = {
  serverUrl: string | null;
  profileId: string | null;
  token: string | null;
};

export async function loadSession(): Promise<Session> {
  const [serverUrl, profileId, token] = await Promise.all([
    AsyncStorage.getItem(KEYS.serverUrl),
    AsyncStorage.getItem(KEYS.profileId),
    AsyncStorage.getItem(KEYS.token),
  ]);
  return {serverUrl, profileId, token};
}

export const saveServerUrl = (url: string) =>
  AsyncStorage.setItem(KEYS.serverUrl, url);

export async function saveProfile(profileId: string, token: string | null) {
  await Promise.all([
    AsyncStorage.setItem(KEYS.profileId, profileId),
    AsyncStorage.setItem(KEYS.token, token || ''),
  ]);
}

// Forget the chosen profile (e.g. "switch profile") but keep the server URL.
export async function clearProfile() {
  await Promise.all([
    AsyncStorage.removeItem(KEYS.profileId),
    AsyncStorage.removeItem(KEYS.token),
  ]);
}

// ---------------------------------------------------------------- preferences
// The site keeps these in localStorage via `playerPrefs`; here they go through
// AsyncStorage. Same keys and same defaults so the two clients agree on what
// "on" means, and so the Settings screen can be a straight port.
export type Prefs = {
  autoplayNext: boolean;
  subsDefault: boolean;
  subLang: 'any' | 'he' | 'en';
  cueSize: 'S' | 'M' | 'L';
  // The site's `cueBackground` — the dark plate behind a cue. It only became
  // meaningful here once the player started drawing its own cues (Player.tsx
  // rule 2); ExoPlayer's subtitleStyle has no equivalent property.
  cueBackground: boolean;
  // The subtitle track the viewer last picked BY HAND, remembered so the next
  // episode comes up the same way. Not a setting anyone edits — it is written by
  // the player's subtitle menu and read by its auto-pick.
  //
  // Two fields because a track has to be matched across files that do not share
  // ids: `lastSubLang` is the language code, which is what actually carries over
  // ("Hebrew" on episode 1 should find the Hebrew track on episode 2 even though
  // it is a different upload), and `lastSubLabel` is the fallback for tracks
  // whose lang is empty, which is common on side-loaded files.
  //
  // `null` means "off": someone who turns subtitles off for an episode means it
  // for the next one too, and that has to be distinguishable from "never chose".
  lastSubLang: string | null;
  lastSubLabel: string | null;
  // Whether lastSub* has ever been written. Without this, `null` for "the viewer
  // chose off" is indistinguishable from `null` for "fresh install", and a fresh
  // install would come up with subtitles off — the opposite of subsDefault.
  lastSubSet: boolean;
};

export const PREFS_DEFAULTS: Prefs = {
  autoplayNext: true,
  subsDefault: true,
  subLang: 'any',
  cueSize: 'M',
  cueBackground: true,
  lastSubLang: null,
  lastSubLabel: null,
  lastSubSet: false,
};

const PREFS_KEY = 'aurora.prefs';

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    // Spread over the defaults so a stored blob written by an older build (or a
    // partially-written one) can never leave a field undefined.
    return raw ? {...PREFS_DEFAULTS, ...JSON.parse(raw)} : {...PREFS_DEFAULTS};
  } catch {
    return {...PREFS_DEFAULTS};
  }
}

export async function savePrefs(p: Prefs) {
  try {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {}
}
