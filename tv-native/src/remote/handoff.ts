// "Play on TV" to a TV on its profile wall — the rules, PURE over what they
// are handed (__tests__/logic/play-on-tv.test.ts). The glue is wall.ts.
//
//   1. the title waits here (setPendingPlay) for the profile it was sent by;
//   2. the TV is brought forward (the screensaver woken) and the wall opens
//      that profile THE WAY ITS OWN TILE WOULD (profileWall.ts onTile): straight
//      in when the profile has no password and no PIN is wanted; else it asks —
//      the password, the household PIN, the kids lock's PIN. Never past them;
//   3. the phone is answered at once: "playing", or "needs-pin" /
//      "needs-password" (the TV shows "Enter your PIN to play Arrival");
//   4. once the profile is in, remote/target.ts takes the title
//      (takePendingPlay) and plays it at the second it was sent with.
//
// A title waits PENDING_MS at most (somebody walks to the TV to type the
// PIN); a press on another tile, or Back off the prompt, drops it.
import {MSG, type From, type Outcome, type PlayItemArgs, type WireItem} from './protocol';

export const PENDING_MS = 2 * 60 * 1000;

export type PendingPlay = {profileId: string; args: PlayItemArgs; at: number};
let pending: PendingPlay | null = null;

export const setPendingPlay = (p: PendingPlay) => {
  pending = p;
};
export const clearPendingPlay = () => {
  pending = null;
};
/** The title waiting for `profileId` (still in time), taken — or null. Any
 *  other profile coming in drops what waited: it was not theirs to play. */
export const takePendingPlay = (profileId: string, now = Date.now()): PlayItemArgs | null => {
  const p = pending;
  pending = null;
  if (!p || p.profileId !== profileId || now - p.at > PENDING_MS) return null;
  return p.args;
};
/** Test-only. */
export const _pending = () => pending;

/** "Arrival", "Silo · S1 E3" — what the TV's prompt names. */
export const titleOf = (it: Pick<WireItem, 'title' | 'showTitle' | 'season' | 'episode'>): string =>
  it.showTitle && it.season != null && it.episode != null ? `${it.showTitle} · S${it.season} E${it.episode}` : it.title || it.showTitle || '';

/** The wall's answer for a profile (what WallOpener resolves). */
export type WallDoor = 'in' | 'pin' | 'password' | 'locked' | 'missing' | 'error';

export const wallOutcome = (door: WallDoor): Outcome => {
  switch (door) {
    case 'in':
      return {ok: true, status: 'playing', message: MSG.opening};
    case 'pin':
      return {ok: true, status: 'needs-pin'};
    case 'password':
      return {ok: true, status: 'needs-password'};
    case 'locked':
      return {ok: false, error: 'locked', message: MSG.profileLocked};
    case 'missing':
      return {ok: false, error: 'no-profile', message: MSG.noProfile};
    default:
      return {ok: false, error: 'failed', message: MSG.wallFailed};
  }
};

export type WallDeps = {
  /** opens the profile on the wall the way its tile would; `ask` is what the prompt says */
  open: (profileId: string, ask: {title: string; who: string}) => Promise<WallDoor>;
  /** Aurora in front (the screensaver woken) — false: Android would not let it */
  forward: () => Promise<unknown>;
  who: (from: From | null | undefined) => string;
  now?: () => number;
};

export async function playFromWall(args: PlayItemArgs, from: From | null | undefined, deps: WallDeps): Promise<Outcome> {
  const profileId = from && typeof from.profileId === 'string' ? from.profileId : '';
  if (!profileId) return {ok: false, error: 'bad-command', message: MSG.badCommand};
  setPendingPlay({profileId, args, at: (deps.now || Date.now)()});
  if (!(await deps.forward())) {
    clearPendingPlay();
    return {ok: false, error: 'background', message: MSG.background};
  }
  let door: WallDoor = 'error';
  try {
    door = await deps.open(profileId, {title: titleOf(args.item), who: deps.who(from)});
  } catch {
    door = 'error';
  }
  if (door !== 'in' && door !== 'pin' && door !== 'password') clearPendingPlay();
  return wallOutcome(door);
}
