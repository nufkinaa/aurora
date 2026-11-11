// Is the Aurora server in reach right now? The socket says so: open = yes. Closed for a few
// seconds in a row = out of reach — and the phone's own network says which words fit (the
// website's ws.js): "No connection" (this phone has no line at all) or "Can't reach Aurora"
// (the line is there, the server is not). A moment's reconnect never flashes it.
import {useEffect, useState} from 'react';
import {NativeModules} from 'react-native';
import {isOpen} from '../../realtime';

export const NO_LINK_AFTER_MS = 4000;
export type Away = 'line' | 'server' | null;

/** Pure: given when the socket was last seen open (or when we started looking) and now — out of reach? */
export const noLink = (lastOpenAt: number, startedAt: number, now: number, open: boolean) =>
  !open && now - Math.max(lastOpenAt, startedAt) >= NO_LINK_AFTER_MS;
/** The words of the calm line. */
export const awayWords = (why: Away) => (why === 'line' ? 'No connection' : "Can't reach Aurora");

const N = (NativeModules as {AuroraOffline?: {network(): Promise<string>}}).AuroraOffline;

export function useAway(): Away {
  const [away, setAway] = useState<Away>(null);
  useEffect(() => {
    const started = Date.now();
    let lastOpen = isOpen() ? started : 0;
    let alive = true;
    const look = async () => {
      const open = isOpen();
      const now = Date.now();
      if (open) lastOpen = now;
      if (!noLink(lastOpen, started, now, open)) return alive && setAway(null);
      const net = N ? await N.network().catch(() => 'other') : 'other';
      if (alive) setAway(net === 'none' ? 'line' : 'server');
    };
    look();
    const iv = setInterval(look, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);
  return away;
}
export const useNoConnection = () => useAway() !== null;

// ---- the line is on screen: a toast stands above it, never under it (the website's rule) ----
/** How far toasts rise while the line shows: its height (44) and the gap between (8). */
export const PILL_LIFT = 52;
let pillShown = false;
const pillSubs = new Set<(on: boolean) => void>();
export const setPillShown = (on: boolean) => {
  if (on === pillShown) return;
  pillShown = on;
  for (const fn of [...pillSubs]) fn(on);
};
export function usePillShown(): boolean {
  const [on, setOn] = useState(pillShown);
  useEffect(() => {
    pillSubs.add(setOn);
    setOn(pillShown);
    return () => {
      pillSubs.delete(setOn);
    };
  }, []);
  return on;
}
