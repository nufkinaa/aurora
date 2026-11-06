// The server's clock, as this TV reckons it (Play on TV: a command carries
// `at`, the server's time when it was sent — handler.ts expired()). Learned
// from every device_ok (the announce's answer carries `now`), as an offset to
// this box's own clock, so a TV whose clock is set wrong still reads it
// right. Not known yet: nothing expires.
import {onMessage} from '../realtime';

let offset: number | null = null;

/** The server said its time is `now` (ms), just now. */
export const noteServerNow = (now: unknown, localNow = Date.now()) => {
  if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) return;
  offset = now - localNow;
};

/** The server's time now, or null while it is not known. */
export const serverNow = (localNow = Date.now()): number | null => (offset == null ? null : localNow + offset);

onMessage('device_ok', d => noteServerNow(d.now));

/** Test-only. */
export const _resetClock = () => {
  offset = null;
};
