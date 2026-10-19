// Voice search with the remote's microphone: one listening, start to end.
//
// voiceLogic.ts has the rules (shared with the website: the language, each
// moment, the words); AuroraVoice (android VoiceModule.kt) does the hearing;
// this file runs one listening between the two:
//
//   start(lang)  what the TV has (availability) → the microphone permission
//                (asked once, through Android's own dialog) → listening.
//                Two ways to hear: the recognition SERVICE, which sends the
//                words as they are said, or — on a TV whose service will not
//                serve another app, or that has none but has the system's
//                voice overlay — that overlay, with one final answer.
//   stop()       the mic pressed again: what has been heard is the answer
//   cancel()     Back: nothing is searched
//   done()       the answer was searched for; back to rest
//
// Nothing here touches React or the screen: Search.tsx shows the state, and
// the logic tests drive this with a fake recogniser (voice.test.ts).
import {NativeEventEmitter, NativeModules, PermissionsAndroid} from 'react-native';
import {bcp47, VoiceEvent, VoiceLang, voiceActive, voiceReduce, VoiceState, VOICE_IDLE} from './voiceLogic';

export type Availability = {
  recognizer: boolean;
  intent: boolean;
  services?: string[];
  permission?: boolean;
  locale?: string;
  onDevice?: boolean;
};
export type NativeVoiceEvent = {
  session: number;
  type: 'ready' | 'begin' | 'level' | 'partial' | 'final' | 'error' | 'end';
  text?: string;
  code?: string | number;
  level?: number;
};
export type VoiceNative = {
  availability(): Promise<Availability>;
  start(lang: string, session: number): void;
  startIntent(lang: string, session: number): void;
  stop(): void;
  cancel(): void;
  captureKeys?(on: boolean): void;
};
export type PermissionAnswer = 'granted' | 'denied' | 'never_ask_again';
export type VoiceDeps = {
  native: VoiceNative | null;
  /** is RECORD_AUDIO already granted? */
  check: () => Promise<boolean>;
  /** Android's permission dialog */
  ask: () => Promise<PermissionAnswer>;
  subscribe: (fn: (e: NativeVoiceEvent) => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};
export type VoiceController = {
  start: (lang: VoiceLang) => Promise<void>;
  stop: () => void;
  cancel: () => void;
  done: () => void;
  state: () => VoiceState;
  /** how loud, 0..1, while listening (the dot pulses with it) */
  level: () => number;
  /** the overlay, not the service, is what hears on this TV */
  viaOverlay: () => boolean;
  dispose: () => void;
};

// A listening that has gone this long without an answer is asked to finish
// with what it has; a service that never answers is let go after a grace.
export const LISTEN_MAX_MS = 20000;
export const GRACE_MS = 4000;
// Service errors before it was ever ready that mean "this service will not
// serve us" (ERROR_CLIENT, ERROR_SERVER_DISCONNECTED, or no service at all):
// the system's overlay is tried instead, once.
const REFUSED = new Set(['5', '11', 'unavailable']);

export const createVoice = (deps: VoiceDeps, onChange: (s: VoiceState, level: number) => void): VoiceController => {
  const setT = deps.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimer || ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let vs: VoiceState = VOICE_IDLE;
  let lvl = 0;
  let session = 0;
  let mode: 'service' | 'intent' = 'service';
  let fellBack = false;
  let avail: Availability | null = null;
  let guard: unknown = null;
  let lang: VoiceLang = 'en';

  const clearGuard = () => {
    if (guard != null) clearT(guard);
    guard = null;
  };
  const dispatch = (ev: VoiceEvent) => {
    const was = vs;
    vs = voiceReduce(vs, ev);
    if (!voiceActive(vs)) {
      clearGuard();
      lvl = 0;
    }
    if (vs !== was) onChange(vs, lvl);
  };
  const armGuard = (mine: number) => {
    clearGuard();
    guard = setT(() => {
      if (mine !== session || !voiceActive(vs)) return;
      if (vs.interim) return finishWith(vs.interim);
      try {
        deps.native?.stop();
      } catch {}
      guard = setT(() => {
        if (mine !== session || !voiceActive(vs)) return;
        try {
          deps.native?.cancel();
        } catch {}
        session++;
        dispatch({type: 'end'});
      }, GRACE_MS);
    }, LISTEN_MAX_MS);
  };
  const finishWith = (text: string) => {
    const n = deps.native;
    session++; // whatever the recogniser still says is not news
    try {
      if (mode === 'service') n?.cancel();
    } catch {}
    dispatch({type: 'final', text});
  };

  const unsubscribe = deps.subscribe((e: NativeVoiceEvent) => {
    if (!e || e.session !== session) return;
    switch (e.type) {
      case 'ready':
        dispatch({type: 'ready'});
        return;
      case 'begin':
        return;
      case 'level':
        lvl = typeof e.level === 'number' ? Math.max(0, Math.min(1, e.level)) : 0;
        if (voiceActive(vs)) onChange(vs, lvl);
        return;
      case 'partial':
        dispatch({type: 'partial', text: e.text || ''});
        return;
      case 'final':
        dispatch({type: 'final', text: e.text || ''});
        return;
      case 'end':
        dispatch({type: 'end'});
        return;
      case 'error': {
        const code = String(e.code);
        // the service would not serve us: the system's overlay, once
        if (mode === 'service' && vs.phase === 'starting' && REFUSED.has(code) && avail?.intent && !fellBack && deps.native) {
          fellBack = true;
          mode = 'intent';
          try {
            deps.native.startIntent(bcp47(lang), session);
          } catch {
            dispatch({type: 'error', code: e.code ?? 'failed'});
          }
          return;
        }
        dispatch({type: 'error', code: e.code ?? 'failed'});
        return;
      }
    }
  });

  const start = async (want: VoiceLang) => {
    const n = deps.native;
    if (voiceActive(vs)) {
      try {
        if (mode === 'service') n?.cancel();
      } catch {}
    }
    const mine = ++session;
    lang = want;
    fellBack = false;
    dispatch({type: 'start', lang: want});
    if (!n) return dispatch({type: 'unavailable'});
    try {
      avail = await n.availability();
    } catch {
      avail = null;
    }
    if (mine !== session) return;
    if (!avail || (!avail.recognizer && !avail.intent)) return dispatch({type: 'unavailable'});
    if (avail.recognizer) {
      let granted = false;
      try {
        granted = await deps.check();
      } catch {}
      if (!granted && mine === session) {
        let answer: PermissionAnswer = 'denied';
        try {
          answer = await deps.ask();
        } catch {}
        if (mine !== session) return;
        granted = answer === 'granted';
        if (!granted) return dispatch({type: 'permission', granted: false, never: answer === 'never_ask_again'});
      }
      if (mine !== session) return;
      dispatch({type: 'permission', granted: true});
      mode = 'service';
      armGuard(mine);
      try {
        n.start(bcp47(want), mine);
      } catch {
        dispatch({type: 'error', code: 'failed'});
      }
      return;
    }
    mode = 'intent';
    armGuard(mine);
    try {
      n.startIntent(bcp47(want), mine);
    } catch {
      dispatch({type: 'error', code: 'failed'});
    }
  };

  return {
    start,
    stop: () => {
      if (!voiceActive(vs)) return;
      if (vs.interim) return finishWith(vs.interim);
      try {
        if (mode === 'service') deps.native?.stop();
      } catch {}
    },
    cancel: () => {
      if (!voiceActive(vs) && vs.phase !== 'error') return;
      const wasActive = voiceActive(vs);
      session++;
      if (wasActive) {
        try {
          if (mode === 'service') deps.native?.cancel();
        } catch {}
      }
      dispatch({type: 'cancel'});
    },
    done: () => dispatch({type: 'done'}),
    state: () => vs,
    level: () => lvl,
    viaOverlay: () => mode === 'intent',
    dispose: () => {
      clearGuard();
      if (voiceActive(vs)) {
        try {
          if (mode === 'service') deps.native?.cancel();
        } catch {}
      }
      session++;
      unsubscribe();
    },
  };
};

// ---- the real thing ----
const nativeModule = (NativeModules as {AuroraVoice?: VoiceNative}).AuroraVoice;
let emitter: NativeEventEmitter | null = null;
const eventsOf = () => {
  if (!emitter && nativeModule) emitter = new NativeEventEmitter(nativeModule as never);
  return emitter;
};

/** The TV's own recogniser, its events and Android's permission dialog. */
export const nativeVoiceDeps = (): VoiceDeps => ({
  native: nativeModule || null,
  check: async () => {
    try {
      return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    } catch {
      return false;
    }
  },
  ask: async () => {
    try {
      const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'never_ask_again' : 'denied';
    } catch {
      return 'denied';
    }
  },
  subscribe: fn => {
    const em = eventsOf();
    if (!em) return () => {};
    const sub = em.addListener('AuroraVoice', fn as never);
    return () => sub.remove();
  },
});

// ---- the remote's own search / voice key ----
// MainActivity hands KEYCODE_SEARCH / KEYCODE_VOICE_ASSIST over while asked
// to (captureKeys). One listener at a time: the navigator's (navigation.tsx →
// useVoiceKey), which opens Search listening — or tells an open Search to
// start (searchVoiceKey below).
type KeyFn = () => void;
let onSearchKey: KeyFn | null = null;
/** Search.tsx, while it is the screen on show: the key starts listening here. */
export const setSearchVoiceKey = (fn: KeyFn | null) => {
  onSearchKey = fn;
};
export const searchVoiceKey = () => onSearchKey;

/** `aurora://search?q=<words>` (the TV's own search, MainActivity) → the words; null for any other link. */
export const searchLinkQuery = (url: string | null | undefined): string | null => {
  if (!url || !url.startsWith('aurora://search')) return null;
  const m = /[?&]q=([^&]*)/.exec(url);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim().slice(0, 80);
  } catch {
    return '';
  }
};

/** What the key does on `route` (voiceKey.ts wires it to the navigator). */
export const onVoiceKey = (route: string, here: (() => void) | null, open: () => void) => {
  if (route === 'Player') return 'ignored';
  if (route === 'Search' && here) {
    here();
    return 'started';
  }
  open();
  return 'opened';
};

/** Ask for the remote's key; `fn` runs on each press. → stop asking */
export const captureVoiceKey = (fn: () => void): (() => void) => {
  const em = eventsOf();
  if (!nativeModule || !em) return () => {};
  try {
    nativeModule.captureKeys?.(true);
  } catch {}
  const sub = em.addListener('AuroraVoiceKey', fn as never);
  return () => {
    sub.remove();
    try {
      nativeModule.captureKeys?.(false);
    } catch {}
  };
};

/** Is there any way to hear on this TV? (null until asked; cached) */
let availCache: Promise<Availability | null> | null = null;
export const voiceAvailability = (): Promise<Availability | null> => {
  if (!nativeModule) return Promise.resolve(null);
  if (!availCache) availCache = nativeModule.availability().catch(() => null);
  return availCache;
};
