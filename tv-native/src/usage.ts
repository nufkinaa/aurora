// Usage stats — the TV's copy of public/js/usage.js. Which screens, features
// and play paths get used and how long they took, batched every 20s (or when
// the app goes to the background) to THIS server's /api/usage, where the
// admin's Analytics tab reads them. Never anything typed, never an id. Off per
// device under Settings → Privacy (prefs.usageStats === false).
import {AppState} from 'react-native';
import {api} from './api';

type Ev = {n: string; t: number; p: Record<string, string | number | boolean>};
const queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let profile: string | null = null;
let enabledFlag = true;
let errors = 0;
const sid = Math.random().toString(16).slice(2, 10);
const FLUSH_MS = 20000;
const MAX_BATCH = 25;

export const setUsageProfile = (id: string | null) => {
  if (profile && profile !== id) flush();
  profile = id;
};
export const setUsageEnabled = (on: boolean) => {
  enabledFlag = on;
  if (!on) queue.length = 0;
};

const flush = () => {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length || !profile) return;
  const events = queue.splice(0, queue.length);
  api.usage({profile, sid, device: 'tv', look: 'legacy', events}).catch(() => {});
};

// track('feat', {f: 'party_start'}) — props are short strings, numbers, booleans.
export const track = (name: string, props: Record<string, string | number | boolean> = {}) => {
  if (!enabledFlag || !profile) return;
  queue.push({n: name, t: Date.now(), p: props});
  if (queue.length >= MAX_BATCH) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
};

// The message only, five per run at most.
export const trackError = (message: string) => {
  if (errors++ >= 5) return;
  track('error', {m: String(message || '').slice(0, 120)});
};

AppState.addEventListener('change', s => {
  if (s !== 'active') flush();
});
