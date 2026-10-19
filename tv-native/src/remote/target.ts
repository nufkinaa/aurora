// This TV as a TARGET of the phone remote (the protocol: protocol.ts, and the
// server's src/lib/devices.js). Started by SessionWiring when a profile
// session starts, stopped (device_leave) when the profile is left.
//
//   - announces itself on every socket open (realtime.ts onSocketOpen) and
//     whenever its name changes;
//   - reports what it is doing (state.ts has the cadence; `remote_watch` from
//     the server switches the one-second ticks on and off);
//   - answers every `remote_command` exactly once (handler.ts `answer`).
//
// Arrows, OK and Back from the phone are REAL key presses into the activity
// (RemoteModule.kt → MainActivity.injectRemoteKey), so they go through the
// same path as the remote in the hand — the double-press filter, React
// Native's key events to JS, focus.ts's pressMovedFocus — and move exactly
// what a press would. They are paced: two presses never land closer than
// KEY_GAP_MS, however the network bunched them (the activity's filter drops a
// second press of the same key inside 110 ms, as it must for a bouncy remote).
import {AppState, Platform} from 'react-native';
import {getToken} from '../api';
import {isOpen, onMessage, onSocketOpen, send} from '../realtime';
import {currentRouteName} from '../rootNav';
import {registerProfileCache} from '../profileScope';
import {showToast} from '../toast';
import {answer, createPacer, type HandlerCtx} from './handler';
import {buildState, createReporter, type Reporter} from './state';
import {activePlayer, onRemoteChange} from './player';
import {loadDevice, onTvName, setTvName} from './identity';
import {hasNativeRemote, nativeRemote} from './native';
import {goHomeOnTv, playItemOnTv} from './open';
import {KEY_GAP_MS, type Caps, type CommandMsg, type NowState, type RemoteState, type VolumeState} from './protocol';

const VOLUME_IDLE_TICKS = 5; // the volume is read every tick while watched, else every fifth

type Session = {
  profileId: string;
  reporter: Reporter;
  offs: (() => void)[];
  seen: Set<string>;
  volume: VolumeState | null;
  caps: Caps;
  appState: 'active' | 'background';
  changeTimer: ReturnType<typeof setTimeout> | null;
  tick: ReturnType<typeof setInterval> | null;
  ticks: number;
  press: (key: 'up' | 'down' | 'left' | 'right' | 'ok' | 'back') => Promise<boolean>;
};
let session: Session | null = null;

const model = () => {
  const c = (Platform.constants || {}) as {Brand?: string; Manufacturer?: string; Model?: string};
  return [c.Brand || c.Manufacturer || '', c.Model].filter(Boolean).join(' ') || 'Android TV';
};

const nowOf = (): NowState | null => {
  const p = activePlayer();
  if (!p) return null;
  try {
    return p.now();
  } catch {
    return null;
  }
};

const stateOf = (s: Session): RemoteState =>
  buildState({screen: currentRouteName() || null, appState: s.appState, now: nowOf(), volume: s.volume});

const changedSoon = (s: Session, ms = 40) => {
  if (s.changeTimer) return;
  s.changeTimer = setTimeout(() => {
    s.changeTimer = null;
    if (session === s) s.reporter.changed();
  }, ms);
};

const announce = async (s: Session) => {
  const d = await loadDevice();
  if (session !== s || !isOpen()) return;
  const state = stateOf(s);
  const sent = send({
    type: 'device_announce',
    deviceId: d.id,
    name: d.name,
    kind: 'tv',
    form: 'tv',
    model: model(),
    profileId: s.profileId,
    token: getToken() || undefined,
    caps: s.caps,
    state,
  });
  if (sent) s.reporter.sent(state);
};

const readVolume = async (s: Session) => {
  const v = await nativeRemote.volume();
  if (session !== s) return;
  const was = JSON.stringify(s.volume);
  s.volume = v;
  if (JSON.stringify(v) !== was) changedSoon(s);
};

const ctxOf = (s: Session): HandlerCtx => ({
  player: activePlayer,
  appState: () => s.appState,
  press: s.caps.navigate ? s.press : null,
  home: goHomeOnTv,
  volume: s.caps.volume
    ? {
        get: async () => s.volume || (await nativeRemote.volume()),
        set: async level => {
          s.volume = (await nativeRemote.setVolume(level)) || s.volume;
        },
        step: async dir => {
          s.volume = (await nativeRemote.stepVolume(dir)) || s.volume;
        },
        mute: async on => {
          s.volume = (await nativeRemote.setMuted(on)) || s.volume;
        },
      }
    : null,
  playItem: playItemOnTv,
  rename: setTvName,
  toast: (text, glyph) => showToast(text, glyph),
  seen: s.seen,
});

/** A profile session started: this TV is a target for that profile's remotes. */
export const startTarget = (profileId: string) => {
  if (session && session.profileId === profileId) return;
  stopTarget();
  const s: Session = {
    profileId,
    reporter: null as unknown as Reporter,
    offs: [],
    seen: new Set(),
    volume: null,
    caps: {navigate: hasNativeRemote(), volume: false, playItem: true, tracks: true},
    appState: AppState.currentState === 'active' || !AppState.currentState ? 'active' : 'background',
    changeTimer: null,
    tick: null,
    ticks: 0,
    press: createPacer(k => nativeRemote.press(k), KEY_GAP_MS),
  };
  s.reporter = createReporter({
    getState: () => stateOf(s),
    send: state => session === s && send({type: 'device_state', state}),
  });
  session = s;
  s.offs.push(
    onSocketOpen(() => announce(s)),
    onMessage('remote_command', d => {
      answer(d as unknown as CommandMsg, ctxOf(s), ack => send(ack)).then(() => changedSoon(s, 60));
    }),
    onMessage('remote_watch', d => {
      s.reporter.setWatch(d.on === true);
      if (d.on === true) readVolume(s);
    }),
    onMessage('device_error', d => console.log('[remote] the server refused this TV:', String(d.error || ''))),
    onTvName(() => announce(s)),
    onRemoteChange(() => changedSoon(s)),
  );
  const app = AppState.addEventListener('change', st => {
    const next = st === 'active' ? 'active' : 'background';
    if (next === s.appState) return;
    s.appState = next;
    changedSoon(s);
  });
  s.offs.push(() => app.remove());
  s.reporter.start();
  s.tick = setInterval(() => {
    s.ticks += 1;
    if (s.caps.volume && (s.reporter.watching() || s.ticks % VOLUME_IDLE_TICKS === 0)) readVolume(s);
  }, 1000);
  // what the box can do, then who it is
  (async () => {
    const v = await nativeRemote.volume();
    if (session !== s) return;
    s.volume = v;
    s.caps = {...s.caps, volume: !!(v && v.supported)};
    announce(s);
  })();
};

/** The profile is left (or the app signs out): this TV stops being a target. */
export function stopTarget() {
  const s = session;
  if (!s) return;
  session = null;
  if (isOpen()) send({type: 'device_leave'});
  for (const off of s.offs) {
    try {
      off();
    } catch {}
  }
  s.reporter.stop();
  if (s.tick) clearInterval(s.tick);
  if (s.changeTimer) clearTimeout(s.changeTimer);
}
registerProfileCache('remote/target', stopTarget);

/** Test-only. */
export const _targetSession = () => session;
