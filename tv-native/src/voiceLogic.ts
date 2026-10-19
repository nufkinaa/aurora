// Voice search: the rules, and nothing else. PURE — no imports.
// public/js/voicelogic.js is this file without the types; the root test
// test/voice-logic.test.js runs both through the same assertions. Change one,
// change both.
//
// The microphone (the browser's Web Speech API on the website, Android's
// speech recognition on the TV — voice.ts / AuroraVoice.kt) hears; what it
// heard goes to the same server search as typing (/api/search?v=2&voice=1 —
// media/spoken.js tidies the sentence). This file says, for both apps:
//   - which language to listen in: the person's choice (profile prefs
//     `voiceLang`: auto | he | en, the same on every device), else the
//     device's own language;
//   - what each moment of a voice search is (voiceReduce), from the events a
//     recogniser sends, whichever recogniser it is;
//   - what to tell the person (voiceMessage), in the same words on both.

export type VoiceLang = 'he' | 'en';
export type VoicePref = 'auto' | VoiceLang;
export type VoiceError =
  | 'denied'
  | 'blocked'
  | 'unavailable'
  | 'no-speech'
  | 'no-match'
  | 'network'
  | 'busy'
  | 'audio'
  | 'language'
  | 'failed'
  | 'cancelled';
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'heard' | 'error';
export type VoiceState = {
  phase: VoicePhase;
  lang: VoiceLang;
  interim: string;
  text: string;
  error: VoiceError | null;
};
export type VoiceEvent =
  | {type: 'start'; lang: VoiceLang}
  | {type: 'permission'; granted: boolean; never?: boolean}
  | {type: 'unavailable'}
  | {type: 'ready'}
  | {type: 'partial'; text: string}
  | {type: 'final'; text: string}
  | {type: 'error'; code: string | number}
  | {type: 'end'}
  | {type: 'cancel'}
  | {type: 'done'};

export const VOICE_PREFS: VoicePref[] = ['auto', 'he', 'en'];
export const LANG_NAME: Record<VoiceLang, string> = {he: 'Hebrew', en: 'English'};
// how a language is named on its own switch (in its own script)
export const LANG_SELF: Record<VoiceLang, string> = {he: 'עברית', en: 'English'};

// The language to listen in. `pref`: the profile's voiceLang; `device`: the
// device's language tag ("he-IL", "iw", "en-US").
export const voiceLangFor = (pref: unknown, device: unknown): VoiceLang => {
  if (pref === 'he' || pref === 'en') return pref;
  const tag = String(device || '').toLowerCase();
  return /^(he|iw)([-_]|$)/.test(tag) ? 'he' : 'en';
};
// the tag a recogniser is asked for
export const bcp47 = (lang: VoiceLang) => (lang === 'he' ? 'he-IL' : 'en-US');
export const otherLang = (lang: VoiceLang): VoiceLang => (lang === 'he' ? 'en' : 'he');

// What went wrong, from any recogniser's own word for it:
//   the Web Speech API's error codes, the TV module's (AuroraVoice.kt), and
//   Android's SpeechRecognizer error numbers.
const ERRORS: Record<string, VoiceError> = {
  // web
  'not-allowed': 'denied',
  'service-not-allowed': 'blocked',
  'no-speech': 'no-speech',
  'audio-capture': 'audio',
  network: 'network',
  'language-not-supported': 'language',
  aborted: 'cancelled',
  'bad-grammar': 'failed',
  // the TV module
  denied: 'denied',
  blocked: 'blocked',
  unavailable: 'unavailable',
  'no-match': 'no-match',
  busy: 'busy',
  audio: 'audio',
  language: 'language',
  client: 'failed',
  server: 'network',
  failed: 'failed',
  cancelled: 'cancelled',
  // android.speech.SpeechRecognizer.ERROR_*
  1: 'network', 2: 'network', 3: 'audio', 4: 'network', 5: 'failed', 6: 'no-speech', 7: 'no-match',
  8: 'busy', 9: 'denied', 10: 'busy', 11: 'network', 12: 'language', 13: 'language',
};
export const voiceError = (code: unknown): VoiceError =>
  Object.prototype.hasOwnProperty.call(ERRORS, String(code)) ? ERRORS[String(code)] : 'failed';

// ---- the moments of one voice search ----
//   idle        nothing is listening
//   starting    asked for the microphone (and, the first time, the person's
//               permission); not hearing yet
//   listening   hearing: `interim` is what it has so far (shown as it comes)
//   heard       done: `text` is what to search for
//   error       `error` says what (voiceMessage says it in words)
export const VOICE_IDLE: VoiceState = {phase: 'idle', lang: 'en', interim: '', text: '', error: null};

const clean = (s: unknown) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const heardOrError = (state: VoiceState, error: VoiceError): VoiceState =>
  state.interim ? {...state, phase: 'heard', text: state.interim, error: null} : {...state, phase: 'error', error};

export const voiceReduce = (state: VoiceState | null | undefined, ev: VoiceEvent | null | undefined): VoiceState => {
  const s = state || VOICE_IDLE;
  const open = s.phase === 'starting' || s.phase === 'listening';
  switch (ev && ev.type) {
    case 'start': {
      const e = ev as {lang: VoiceLang};
      return {phase: 'starting', lang: e.lang === 'he' ? 'he' : 'en', interim: '', text: '', error: null};
    }
    case 'permission': {
      const e = ev as {granted: boolean; never?: boolean};
      if (!open || e.granted) return s;
      return {...s, phase: 'error', error: e.never ? 'blocked' : 'denied', interim: ''};
    }
    case 'unavailable':
      return {...s, phase: 'error', error: 'unavailable', interim: ''};
    case 'ready':
      return open ? {...s, phase: 'listening'} : s;
    case 'partial': {
      if (!open) return s;
      const t = clean((ev as {text: string}).text);
      return {...s, phase: 'listening', interim: t || s.interim};
    }
    case 'final': {
      if (!open) return s;
      const t = clean((ev as {text: string}).text);
      if (t) return {...s, phase: 'heard', text: t, interim: t, error: null};
      return heardOrError(s, 'no-match');
    }
    case 'error': {
      if (!open) return s;
      const e = voiceError((ev as {code: unknown}).code);
      if (e === 'cancelled') return {...VOICE_IDLE, lang: s.lang};
      // the recogniser gave up after showing words: those words are the answer
      if (e === 'no-speech' || e === 'no-match') return heardOrError(s, e);
      return {...s, phase: 'error', error: e, interim: ''};
    }
    case 'end':
      // the recogniser stopped without a final result
      if (!open) return s;
      return heardOrError(s, 'no-speech');
    case 'cancel':
      return {...VOICE_IDLE, lang: s.lang};
    case 'done':
      return {...VOICE_IDLE, lang: s.lang};
    default:
      return s;
  }
};

// Is the microphone on (the button lit, the panel open)?
export const voiceActive = (state: VoiceState | null | undefined) =>
  !!state && (state.phase === 'starting' || state.phase === 'listening');

// ---- the words ----
// `platform`: "web" | "tv" — only where a fix is the device's own (its
// settings) do the two say different things.
export const voiceMessage = (state: VoiceState | null | undefined, platform: 'web' | 'tv' = 'web'): string => {
  const s = state || VOICE_IDLE;
  const name = LANG_NAME[s.lang] || 'English';
  const tv = platform === 'tv';
  switch (s.phase) {
    case 'starting':
      return 'Starting the microphone…';
    case 'listening':
      return s.interim ? '' : `Listening in ${name}… say a title`;
    case 'heard':
      return '';
    case 'error':
      switch (s.error) {
        case 'denied':
          return "Aurora isn't allowed to use the microphone. Press the mic again and choose Allow.";
        case 'blocked':
          return tv
            ? "The microphone is off for Aurora. Turn it on in the TV's Settings → Apps → Aurora → Permissions."
            : "The microphone is blocked for this site. Allow it in the browser's site settings.";
        case 'unavailable':
          return tv
            ? 'This TV has no speech recognition. Install or update the Google app to search by voice.'
            : "This browser can't search by voice.";
        case 'no-speech':
          return "Didn't hear anything. Press the mic and say a title.";
        case 'no-match':
          return "Didn't catch that. Press the mic and try again.";
        case 'network':
          return "Voice search needs the internet: the speech service didn't answer.";
        case 'busy':
          return 'The microphone is busy. Try again in a moment.';
        case 'audio':
          return tv ? "The remote's microphone didn't answer." : 'No microphone was found.';
        case 'language':
          return `Listening in ${name} isn't available here. Switch to ${LANG_NAME[otherLang(s.lang)]}.`;
        default:
          return 'Voice search stopped. Press the mic to try again.';
      }
    default:
      return '';
  }
};
