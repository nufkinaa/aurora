// The phone app's remote, its words and rules — PURE, tested (__tests__/logic/phone-remote-rules.test.ts).
// Every line is the website's (public/js/screens/remote.js, public/js/remote.js): the same
// device picker, banner, clock, idle row, touchpad steps, subtitle timing and volume words.
import type {NowState, RemoteState} from '../../remote/protocol';
import type {HeroItem, HomeRow} from '../../api';
import {PLAY_ON} from '../../remote/playOnWords';

/** The device as the remote screen reads it (controller.ts Device, the fields used here). */
export type RDevice = {
  deviceId: string;
  name: string;
  kind?: string;
  form?: string;
  mine?: boolean;
  wall?: boolean;
  profile?: {id: string; name: string} | null;
  caps?: {navigate?: boolean; volume?: boolean; playItem?: boolean; tracks?: boolean};
  state?: RemoteState | null;
};

/** 0:07, 12:37, 1:02:05 — the site's fmtClock. */
export const fmtClock = (seconds: number) => {
  const a = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  return (h > 0 ? `${h}:` : '') + (h > 0 ? String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
};

/** Where the clock is NOW: the last report moved on by the time since it came (not while paused,
 *  loading or being dragged), never past the end. */
export const livePos = (v: {position: number; at: number; paused: boolean; buffering?: boolean; duration: number}, now: number) => {
  if (v.paused || v.buffering) return v.position;
  const p = v.position + Math.max(0, now - v.at) / 1000;
  return v.duration ? Math.min(v.duration, p) : p;
};

/** A skip of `by` seconds from `pos`, inside the title. */
export const skipTo = (pos: number, by: number, duration: number) => Math.max(0, Math.min(duration || Infinity, pos + by));

/** The device to show: the one asked for while it is on; else the last one used, else the one
 *  playing, else the first (the site's autoPick). `keep`: an asked-for device that is gone while
 *  nothing is on stays picked (a restart: it may come back), and so does one asked for by name. */
export function autoPick(list: RDevice[], current: string | null, last: string | null, asked = false): string | null {
  const has = (id: string | null) => !!id && list.some(d => d.deviceId === id);
  if (current && has(current)) return current;
  if (current && !list.length) return current;
  // asked for by name (Play on TV, a link): it stays, and the banner says it is gone
  if (current && asked) return current;
  const d = (last && list.find(x => x.deviceId === last)) || list.find(x => x.state && x.state.now) || list[0];
  return d ? d.deviceId : current;
}

/** A short line about what a device is doing ("Playing · Arrival", "On Home"). */
export function deviceLine(d: RDevice | null): string {
  if (d && d.wall) return PLAY_ON.onWall;
  const s = (d && d.state) || null;
  if (s && s.appState === 'background') return 'Aurora is in the background';
  const n = s ? s.now : null;
  if (n) {
    const what = n.showTitle ? `${n.showTitle}${n.season != null && n.episode != null ? ` · S${n.season} E${n.episode}` : ''}` : n.title;
    return `${n.paused ? 'Paused' : 'Playing'} · ${what}`;
  }
  return s && s.screen === 'home' ? 'On Home' : 'Ready';
}

/** The picker sheet's second line: whose (when not this profile's) and what it does. */
export const pickerSub = (d: RDevice) => `${d.mine !== false || d.wall ? '' : `${d.profile && d.profile.name ? d.profile.name : 'Someone'} · `}${deviceLine(d)}`;

/** The device's icon: a TV, a tablet or a computer. */
export const deviceKind = (d: RDevice | null): 'tv' | 'tablet' | 'computer' => (d && d.kind === 'tv' ? 'tv' : d && d.form === 'tablet' ? 'tablet' : 'computer');

/** The line under the top: the server's line, the device, its app — or nothing. */
export function bannerLine(online: boolean, wanted: string | null, dev: RDevice | null, anyOn: boolean): string {
  if (!online) return 'Reconnecting to the server…';
  if (wanted && !dev && anyOn) return "That device isn't on any more — pick another above";
  if (dev && dev.state && dev.state.appState === 'background') return `Aurora is in the background on ${dev.name} — open it there`;
  return '';
}

/** The light by the device's name: red with no server, green with a device, amber looking. */
export const dotOf = (online: boolean, dev: RDevice | null): 'off' | 'live' | 'idle' => (!online ? 'off' : dev ? 'live' : 'idle');

/** What the screen shows: no device on, nothing playing, or what plays. */
export const stateOf = (anyOn: boolean, now: NowState | null): 'empty' | 'idle' | 'playing' => (!anyOn ? 'empty' : now ? 'playing' : 'idle');

/** No device on: what to do about it. */
export function emptyLine(heard: boolean, online: boolean, name: string, household: boolean): string {
  if (!heard && online) return 'Looking for your TVs…';
  return `Open Aurora on your TV — signed in as ${name || 'you'} — and it shows up here.${household ? ' TVs of the rest of the household show up too.' : ''}`;
}

/** "Playing on Living room TV" / "Paused on …" over the title. */
export const eyebrowOf = (n: NowState, dev: RDevice) => `${n.paused ? 'Paused on' : 'Playing on'} ${dev.name}`;

/** "S1 E2 · The name" under the title (an episode), or the film's own name when it differs. */
export function subOf(n: NowState): string {
  const se = n.season != null && n.episode != null ? `S${n.season} E${n.episode}` : '';
  const name = n.epTitle || (n.showTitle && n.title && n.title !== n.showTitle ? n.title : '');
  return [se, name].filter(Boolean).join(' · ');
}

/** The idle view's second line: what the device is doing, and whose (another profile's). */
export const idleSub = (d: RDevice) => `${deviceLine(d)}${d.mine !== false || d.wall ? '' : ` · ${d.profile ? d.profile.name : ''}`}`;

/** Continue Watching for the idle view: the profile's row, torrents left out, twelve at most. */
export function idleItems(rows: HomeRow[] | null | undefined): HeroItem[] {
  const cw = (rows || []).find(r => r.id === 'continue');
  return (cw && cw.items ? cw.items : []).filter(it => it && it.id && !String(it.id).startsWith('torrent|')).slice(0, 12);
}
/** A Continue Watching card's label. */
export const cwLabel = (it: HeroItem) => (it.showId ? `${it.showTitle || ''} · S${it.season} E${it.episode}` : it.title);
/** Where a Continue Watching card starts on the TV (seconds). */
export const cwPos = (it: HeroItem) => (it.progress && !it.progress.finished ? it.progress.position || 0 : 0);

/** The subtitle timing as the sheet shows it: "+0.5 s", "0.0 s", "−1.0 s" (the site's: a plain minus). */
export const delayText = (v: number) => `${v > 0 ? '+' : ''}${(v || 0).toFixed(1)} s`;
/** The timing after a nudge, to a tenth. */
export const nudged = (cur: number, by: number) => Math.round(((cur || 0) + by) * 10) / 10;

/** The volume's title: the TV's own, or the player's. */
export const volumeScope = (scope: string | null | undefined) => (scope === 'system' ? "The TV's volume" : "This player's volume");
/** Whether the volume keys are there. */
export const volumeOk = (d: RDevice | null) => !!(d && d.state && d.state.volume && d.state.volume.supported) && !!(d && d.caps && d.caps.volume);

/** How it works (More). */
export const howItWorks = (household: boolean) =>
  household
    ? 'This remote controls your own devices and, as the admin allows, the household\'s TVs'
    : 'This remote controls the TVs and computers signed in to your profile — open Aurora on one and it shows up';

// ---------------------------------------------------------------- the touchpad
// A swipe is an arrow (a drag past 28 dp; along the way every further 70 dp is another), a tap
// is OK (no move, let go within 600 ms). Pure: the screen feeds it the finger and does what it
// returns.
export const SWIPE_START = 28;
export const SWIPE_STEP = 70;
export const TAP_MS = 600;
export type Dir = 'up' | 'down' | 'left' | 'right';
export type Swipe = {x: number; y: number; t: number; moved: boolean; dir: Dir | null; ox: number; oy: number};

export const swipeStart = (x: number, y: number, t: number): Swipe => ({x, y, t, moved: false, dir: null, ox: x, oy: y});

/** The finger moved to (x, y): the arrow to press now, or null. */
export function swipeMove(s: Swipe, x: number, y: number): Dir | null {
  const dx = x - s.x;
  const dy = y - s.y;
  if (!s.moved) {
    if (Math.hypot(dx, dy) < SWIPE_START) return null;
    s.moved = true;
    s.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    s.ox = x;
    s.oy = y;
    return s.dir;
  }
  const ax = x - s.ox;
  const ay = y - s.oy;
  const along = s.dir === 'left' ? -ax : s.dir === 'right' ? ax : s.dir === 'up' ? -ay : ay;
  if (along >= SWIPE_STEP) {
    s.ox = x;
    s.oy = y;
    return s.dir;
  }
  return null;
}

/** The finger let go: OK when it was a tap. */
export const swipeEnd = (s: Swipe, t: number): 'ok' | null => (!s.moved && t - s.t < TAP_MS ? 'ok' : null);

// ---------------------------------------------------------------- the scrub bar
/** The position under a finger at `x` on a bar `w` wide. */
export const scrubAt = (x: number, w: number, duration: number) => (w > 0 && duration > 0 ? Math.max(0, Math.min(1, x / w)) * duration : 0);
/** The share of the bar filled. */
export const share = (a: number, b: number) => (b > 0 ? Math.max(0, Math.min(1, a / b)) : 0);
