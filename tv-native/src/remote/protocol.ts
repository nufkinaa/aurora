// "Your TVs": the phone as a remote, and "Play on TV" — the TV app's side.
//
// THE PROTOCOL is the server's (src/lib/devices.js, its header comment has it
// in full; src/realtime.js routes the messages). Over the app's one
// WebSocket (realtime.ts) this TV is a TARGET:
//
//   TV → server  device_announce  on every socket open, and whenever the name,
//                                 the profile or the caps change
//                device_state     on every change that matters, every second
//                                 while a remote screen watches this TV,
//                                 otherwise at most every few seconds
//                device_leave     the profile is left
//                remote_ack       the answer to EVERY command, exactly once
//   server → TV  remote_command   {ref, cmd, args, from, first}
//                remote_watch     {on}: a remote screen opened / closed on it
//
// This file is the shapes only (no imports): the pure parts (handler.ts,
// state.ts, playItem.ts) and the glue (target.ts) share them.

export const KEYS = ['up', 'down', 'left', 'right', 'ok', 'back', 'home'] as const;
/** Two phone presses never land closer than this (target.ts paces them): more
 *  than MainActivity's double-press window (110 ms) and focus.ts's "this very
 *  press moved focus" window (120 ms), so each is read as a press of its own. */
export const KEY_GAP_MS = 130;
export type RemoteKey = (typeof KEYS)[number];

export type RemoteTrack = {id: string; label: string; lang: string | null};

/** What is playing, as the remote draws it (server cleanState `now`). */
export type NowState = {
  id: string;
  title: string;
  showTitle: string | null;
  epTitle: string | null;
  season: number | null;
  episode: number | null;
  poster: string | null; // a server path (/img/…, /api/…) or an http(s) URL
  backdrop: string | null;
  duration: number;
  position: number;
  paused: boolean;
  buffering: boolean;
  canSeek: boolean;
  hasNext: boolean;
  nextLabel: string | null;
  subs: RemoteTrack[];
  sub: string | null;
  audios: RemoteTrack[];
  audio: string | null;
  subDelay: number;
};

/** The TV's own volume (AudioManager STREAM_MUSIC) — "system", never the player's. */
export type VolumeState = {supported: boolean; level: number | null; muted: boolean; scope: 'system'};

export type RemoteState = {
  screen: string | null;
  appState: 'active' | 'background';
  now: NowState | null;
  volume: VolumeState | null;
};

export type Caps = {navigate: boolean; volume: boolean; playItem: boolean; tracks: boolean};

/** The item of a play_item, as the server cleaned it (devices.js cleanItem). */
export type WireItem = {
  id: string;
  title: string;
  showTitle: string | null;
  epTitle: string | null;
  season: number | null;
  episode: number | null;
  type: 'movie' | 'show' | null;
  imdbId: string | null;
  poster: string | null;
  duration: number | null;
};
export type PlayItemArgs = {
  item: WireItem;
  position: number | null;
  restart: boolean;
  // 'off' | a language code | null (= the TV's own default)
  subLang: string | null;
  audioLang: string | null;
};

export type From = {label?: string | null; profileName?: string | null};
export type CommandMsg = {
  type: 'remote_command';
  ref: string;
  cmd: string;
  args?: Record<string, unknown> | null;
  from?: From | null;
  first?: boolean;
};

/** The answer: `message` is short, viewer-facing English (the phone shows it). */
export type Ack = {type: 'remote_ack'; ref: string; ok: boolean; error?: string; message?: string};
export type Outcome = {ok: boolean; error?: string; message?: string};

// The words the TV answers with — the website's (public/js/remote.js) where
// both say the same thing, so the phone reads the same either way.
export const MSG = {
  nothingPlaying: 'Nothing is playing on the TV',
  notReady: 'The TV is still starting that — try again in a moment',
  noNext: 'There is no next episode',
  noSubs: 'Turn a subtitle track on first',
  noTrack: "That track isn't there any more",
  cannotSeek: "This can't be scrubbed yet",
  noVolume: "The TV's volume can't be changed from Aurora — use the TV's own remote",
  noKeys: "This TV's Aurora can't be steered with arrows — update it",
  background: 'Aurora is in the background on the TV — open it there',
  opening: 'Opening',
  openingApp: 'Opening Aurora on the TV',
  failed: "That didn't work on the TV",
  badCommand: "That command isn't known",
} as const;
