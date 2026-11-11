// Home's remark on the phone — the line under the greeting, in Aurora's voice: the server
// picks it (GET /api/profiles/:id/remark, src/lib/remarks), ../remark.ts holds it for ten
// minutes on the phone and has the website's few local lines for the first frame. The same
// steps as the website's greeting block (public/js/screens/home.js):
//   - a line at once (the one held for this profile, else a local one);
//   - the server's takes its place as soon as it comes: a plain swap when it comes within
//     120 ms or motion is reduced, else a short cross-fade (out 180 ms, in 180 ms);
//   - under the billboard it is only taken when it needs no more lines than the one it
//     replaces (the caller measures and says so with take(false)), so the page never moves.
// Kids profiles: the server's warm lines only — the local lines tease, so a kids profile shows
// no line until the server's comes (and none when it cannot be had).
// A new visit (Home coming back on screen, the app coming back) asks again: inside the hold
// that is the same line, from memory, with no request.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, AppState} from 'react-native';
import {fetchRemark, remarkNow, Remark} from '../remark';

export const SWAP_QUICK_MS = 120;
export const SWAP_FADE_MS = 180;

/** What the first frame says: the held or a local line; for a kids profile only a held server line. */
export function firstLine(profileId: string, kids: boolean, now: number = Date.now()): string {
  const r = remarkNow(profileId, now);
  return kids && r.kind === 'local' ? '' : r.text;
}

/** Whether the server's answer may replace what is on screen. */
export function wanted(r: Remark | null, shown: string, kids: boolean): r is Remark {
  if (!r || !r.text || r.text === shown) return false;
  return !(kids && (r.kind === 'local' || !r.id));
}

export type RemarkState = {
  text: string;
  opacity: Animated.Value;
  /** the server's line waiting for the caller's yes (under the billboard: does it fit?) */
  offer: string | null;
  take: (ok: boolean) => void;
};

export function useRemark(profileId: string, kids: boolean | null, visible: boolean): RemarkState {
  const known = kids !== null;
  const [text, setText] = useState(() => (known ? firstLine(profileId, !!kids) : ''));
  const [offer, setOffer] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(1)).current;
  const shown = useRef(text);
  shown.current = text;
  const askedAt = useRef(0);
  const calm = useRef(false);
  useEffect(() => {
    AccessibilityInfo?.isReduceMotionEnabled?.()
      ?.then(v => (calm.current = !!v))
      .catch(() => {});
    const sub = AccessibilityInfo?.addEventListener?.('reduceMotionChanged', v => (calm.current = !!v));
    return () => sub?.remove?.();
  }, []);

  // a profile change (or the profile's kind coming in): its own first line
  useEffect(() => {
    if (!known) return;
    setOffer(null);
    opacity.setValue(1);
    setText(firstLine(profileId, !!kids));
  }, [profileId, known, kids, opacity]);

  const ask = useCallback(() => {
    if (!known) return;
    const asked = Date.now();
    askedAt.current = asked;
    fetchRemark(profileId).then(
      r => {
        if (askedAt.current !== asked) return; // a newer ask (or a profile change) owns the line
        if (wanted(r, shown.current, !!kids)) setOffer(r.text);
      },
      () => {},
    );
  }, [profileId, known, kids]);

  // a visit: Home on screen, and again when the app comes back to the front
  useEffect(() => {
    if (visible) ask();
  }, [visible, ask]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active' && visible) ask();
    });
    return () => sub.remove();
  }, [visible, ask]);

  const take = useCallback(
    (ok: boolean) => {
      const next = offer;
      setOffer(null);
      if (!ok || next == null) return;
      if (Date.now() - askedAt.current < SWAP_QUICK_MS || calm.current) {
        setText(next);
        return;
      }
      Animated.timing(opacity, {toValue: 0, duration: SWAP_FADE_MS, useNativeDriver: true}).start(() => {
        setText(next);
        Animated.timing(opacity, {toValue: 1, duration: SWAP_FADE_MS, useNativeDriver: true}).start();
      });
    },
    [offer, opacity],
  );

  return useMemo(() => ({text, opacity, offer, take}), [text, opacity, offer, take]);
}
