// NIGHT MODE and DIALOGUE BOOST on the TV — the words, the rules for when they
// can apply, and the bridge to the native side (android/…/audio/AudioFx.kt:
// DynamicsProcessing on the player's own audio session). The website's
// public/js/audiofx.js has the same two switches with the same names, notes
// and numbers; both are the PERSON's (personPrefs.ts), synced to every device.
//
// When they cannot apply, the switches stay visible, greyed, with the reason
// in one line (fxReason) — and the person's choice is kept for their other
// devices:
//   - the sound goes out as a BITSTREAM (passthrough: AC-3 / E-AC-3 / DTS to
//     the TV's or the receiver's own decoder) or through the system's offload
//     path — no effect of the app's reaches it there;
//   - Android 8 or older (no DynamicsProcessing), or a firmware without it;
//   - an app build without the native side (the browser sandbox).
import {DeviceEventEmitter, NativeModules} from 'react-native';

export type AudioFxKey = 'nightMode' | 'dialogueBoost';
export const AUDIO_FX_KEYS: AudioFxKey[] = ['nightMode', 'dialogueBoost'];
export const AUDIO_FX_DEFAULTS: Record<AudioFxKey, boolean> = {nightMode: false, dialogueBoost: false};
export const AUDIO_FX_NAMES: Record<AudioFxKey, string> = {nightMode: 'Night mode', dialogueBoost: 'Dialogue boost'};
export const AUDIO_FX_NOTES: Record<AudioFxKey, string> = {
  nightMode: 'Loud bursts come down, quiet voices come up.',
  dialogueBoost: 'Voices clearer over music and effects.',
};

export type AudioFxStatus = {
  supported: boolean;
  sdk: number;
  passthrough: boolean;
  offload: boolean;
  channels: number;
  active: boolean;
  error: string | null;
};

/** Why the switches cannot work right now (null: they can). `status` null =
 *  this build has no native side. PURE. */
export const fxReason = (status: AudioFxStatus | null): string | null => {
  if (!status) return "This TV app can't change the sound.";
  if (status.passthrough) return 'Off while the sound goes to your TV or receiver as it is (passthrough).';
  if (status.offload) return "Off while the TV's own audio path plays this sound.";
  if (status.sdk > 0 && status.sdk < 28) return 'Needs Android 9 or later.';
  if (!status.supported) return "This TV's software doesn't allow it.";
  return null;
};

// ---- the bridge ----
type Native = {
  set: (night: boolean, dialogue: boolean) => void;
  status: () => Promise<AudioFxStatus>;
};
const native = (NativeModules as {AuroraAudioFx?: Native}).AuroraAudioFx;
export const hasNativeFx = () => !!native;

/** The person's two switches, for every player now and later. */
export const setAudioFx = (o: Partial<Record<AudioFxKey, boolean>>) => {
  try {
    native?.set(o.nightMode === true, o.dialogueBoost === true);
  } catch {}
};
export const audioFxStatus = async (): Promise<AudioFxStatus | null> => {
  if (!native) return null;
  try {
    return await native.status();
  } catch {
    return null;
  }
};
/** Called whenever the native status changes (a bitstream track opened, the
 *  effect attached). */
export const onAudioFxStatus = (fn: (s: AudioFxStatus) => void) => {
  if (!native) return () => {};
  const sub = DeviceEventEmitter.addListener('AuroraAudioFx', (s: AudioFxStatus) => fn(s));
  return () => sub.remove();
};
