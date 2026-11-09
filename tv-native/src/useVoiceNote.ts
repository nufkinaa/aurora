// The microphone for a few words in a sheet ("Problem with this copy? → Other"):
// the same listening as voice search (voice.ts runs it, voiceLogic.ts has the
// rules), on the TV (the remote's microphone) and the phone. Offered only where
// the device can hear at all (voiceAvailability: a recogniser or the system's
// voice overlay) — elsewhere the keyboard's own microphone, if it has one, is
// the way. What is heard is handed to `onHeard`; the caller adds it to the field.
import {useCallback, useEffect, useRef, useState} from 'react';
import {createVoice, nativeVoiceDeps, voiceAvailability, VoiceController} from './voice';
import {voiceActive, voiceLangFor, VoiceState, VOICE_IDLE} from './voiceLogic';
import {personNow} from './personSync';
import {voiceNoteWords} from './replaceLogic';

export type VoiceNote = {
  /** the device can hear (null: not known yet) */
  available: boolean | null;
  listening: boolean;
  /** the button's word */
  label: string;
  /** a line under the field: listening, what is being heard, or why it failed */
  line: string;
  press: () => void;
  cancel: () => void;
};

export const useVoiceNote = (onHeard: (text: string) => void): VoiceNote => {
  const [state, setState] = useState<VoiceState>(VOICE_IDLE);
  const [available, setAvailable] = useState<boolean | null>(null);
  const ctl = useRef<VoiceController | null>(null);
  const heardRef = useRef(onHeard);
  heardRef.current = onHeard;
  useEffect(() => {
    let live = true;
    voiceAvailability()
      .then(a => live && setAvailable(!!a && (a.recognizer || a.intent)))
      .catch(() => live && setAvailable(false));
    const c = createVoice(nativeVoiceDeps(), s => {
      setState(s);
      if (s.phase === 'heard') {
        c.done();
        heardRef.current(s.text);
      }
    });
    ctl.current = c;
    return () => {
      live = false;
      c.dispose();
      ctl.current = null;
    };
  }, []);
  const press = useCallback(async () => {
    const c = ctl.current;
    if (!c) return;
    if (voiceActive(c.state())) return c.stop();
    const a = await voiceAvailability();
    c.start(voiceLangFor(personNow()?.voiceLang, a?.locale));
  }, []);
  const cancel = useCallback(() => {
    const c = ctl.current;
    if (c && voiceActive(c.state())) c.cancel();
  }, []);
  const words = voiceNoteWords(state);
  return {available, listening: voiceActive(state), label: words.label, line: words.line, press, cancel};
};
