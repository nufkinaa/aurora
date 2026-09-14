// A small ring of the last client errors, so a problem report carries what
// went wrong even when the viewer only saw "it didn't work" (the site's
// report.js does the same). Also feeds the usage stats' error count.
import {trackError} from './usage';

const ring: string[] = [];
const remember = (msg: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${String(msg).slice(0, 300)}`;
  ring.push(line);
  if (ring.length > 20) ring.shift();
};
export const recentErrors = () => ring.slice();

// What the player is showing, for the report's context.
let playing: {id: string; title: string} | null = null;
export const setPlayingContext = (ctx: {id: string; title: string} | null) => {
  playing = ctx;
};
export const playingContext = () => playing;

type ErrorUtilsShape = {
  getGlobalHandler: () => (e: Error, fatal?: boolean) => void;
  setGlobalHandler: (h: (e: Error, fatal?: boolean) => void) => void;
};
const eu = (globalThis as unknown as {ErrorUtils?: ErrorUtilsShape}).ErrorUtils;
if (eu && typeof eu.setGlobalHandler === 'function') {
  const prev = eu.getGlobalHandler();
  eu.setGlobalHandler((e, fatal) => {
    remember(`${fatal ? 'fatal: ' : ''}${(e && e.message) || String(e)}`);
    trackError((e && e.message) || String(e));
    prev(e, fatal);
  });
}
// console.error is where most "handled" failures end up.
{
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      remember(
        args
          .map(a => (a && (a as Error).stack) || (typeof a === 'object' ? JSON.stringify(a).slice(0, 200) : String(a)))
          .join(' '),
      );
    } catch {}
    orig(...args);
  };
}
