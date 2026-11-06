// This TV on its PROFILE WALL as a target of "Play on TV" (the rules:
// handoff.ts; the protocol: protocol.ts and the server's src/lib/devices.js).
// Started by the TV's ProfileGate while it is on screen, stopped when it goes
// (into a profile, or to the sign-in screen).
//
//   - announces itself `wall: true`, with no profile, on every socket open
//     (the wall opens its own socket: nobody is signed in to say hello as);
//   - takes `play_item` only — the server refuses everything else for a TV
//     on its wall — and answers it at once (handler.ts `answer`, which also
//     refuses one that came too late);
//   - the title is played once the profile is in (target.ts takes it).
//
// The phone app never starts this (its wall is phone/screens/Gate.tsx).
import {AppState, Platform} from 'react-native';
import {isOpen, onMessage, onSocketOpen, send} from '../realtime';
import {showToast} from '../toast';
import {serverNow} from './clock';
import {answer, whoFrom, type HandlerCtx} from './handler';
import {playFromWall, type WallDeps} from './handoff';
import {loadDevice, onTvName} from './identity';
import {bringAuroraForward} from './open';
import type {CommandMsg, PlayItemArgs} from './protocol';

type Wall = {offs: (() => void)[]; seen: Set<string>};
let wall: Wall | null = null;

const model = () => {
  const c = (Platform.constants || {}) as {Brand?: string; Manufacturer?: string; Model?: string};
  return [c.Brand || c.Manufacturer || '', c.Model].filter(Boolean).join(' ') || 'Android TV';
};

const announce = async (w: Wall) => {
  const d = await loadDevice();
  if (wall !== w || !isOpen()) return;
  send({
    type: 'device_announce',
    wall: true,
    deviceId: d.id,
    name: d.name,
    kind: 'tv',
    form: 'tv',
    model: model(),
    caps: {navigate: false, volume: false, playItem: true, tracks: false},
    state: {screen: 'profiles', appState: AppState.currentState === 'background' ? 'background' : 'active', now: null, volume: null},
  });
};

/** The wall is on screen: `open` opens a profile the way its tile would. */
export const startWallTarget = (open: WallDeps['open']) => {
  stopWallTarget();
  const w: Wall = {offs: [], seen: new Set()};
  wall = w;
  const ctxFor = (msg: CommandMsg): HandlerCtx => ({
    player: () => null,
    appState: () => (AppState.currentState === 'background' ? 'background' : 'active'),
    press: null,
    home: () => false,
    volume: null,
    playItem: (args: PlayItemArgs) => playFromWall(args, msg.from, {open, forward: bringAuroraForward, who: whoFrom}),
    rename: () => {},
    toast: (text, glyph) => showToast(text, glyph),
    seen: w.seen,
    serverNow: () => serverNow(),
  });
  w.offs.push(
    onSocketOpen(() => announce(w)),
    onMessage('remote_command', d => {
      if (wall !== w) return;
      const msg = d as unknown as CommandMsg;
      // (the ack must leave before the socket does: entering the profile
      // closes this one — the answer is sent in the same turn as the door opens)
      answer(msg, ctxFor(msg), ack => send(ack));
    }),
    onMessage('device_error', d => console.log('[remote] the server refused this TV on its wall:', String(d.error || ''))),
    onTvName(() => announce(w)),
  );
  if (isOpen()) announce(w);
};

export function stopWallTarget() {
  const w = wall;
  if (!w) return;
  wall = null;
  if (isOpen()) send({type: 'device_leave'});
  for (const off of w.offs) {
    try {
      off();
    } catch {}
  }
}

/** Test-only. */
export const _wallOn = () => !!wall;
