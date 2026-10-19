// The player, as the phone remote sees it: Player.tsx registers a controller
// while it is mounted ([phone-remote] block) and says when something the
// remote shows has changed. The newest one answers (a player pushed over
// another — X-Ray → a title → Play — is the one on screen); when it goes, the
// one under it answers again.
import type {RemotePlayer} from './handler';

const players: RemotePlayer[] = [];
const changeFns = new Set<() => void>();

/** Returns the unregister. */
export const registerRemotePlayer = (p: RemotePlayer) => {
  players.push(p);
  notifyRemote();
  return () => {
    const i = players.lastIndexOf(p);
    if (i >= 0) players.splice(i, 1);
    notifyRemote();
  };
};

export const activePlayer = (): RemotePlayer | null => (players.length ? players[players.length - 1] : null);

/** Something the remote shows changed (paused, a track, the title…). */
export const notifyRemote = () => {
  for (const fn of [...changeFns]) {
    try {
      fn();
    } catch {}
  }
};
export const onRemoteChange = (fn: () => void) => {
  changeFns.add(fn);
  return () => {
    changeFns.delete(fn);
  };
};
