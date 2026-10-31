// The phone app's window and device (android .../phone/PhoneModule.kt, the
// "AuroraPhone" module — registered only in the phone build). Every call is
// safe when the module is missing (jest, a TV build): it does nothing.
import {DeviceEventEmitter, NativeModules} from 'react-native';

type Native = {
  setPip(on: boolean, w: number, h: number): void;
  enterPip(): Promise<boolean>;
  isInPip(): Promise<boolean>;
  setKeepAwake(on: boolean): void;
  setImmersive(on: boolean): void;
  setBrightness(v: number): void;
  getBrightness(): Promise<number>;
  setOrientation(mode: 'auto' | 'landscape' | 'portrait'): void;
  getVolume(): Promise<number>;
  setVolume(v: number): void;
  haptic(kind: 'tick' | 'long' | 'confirm'): void;
  pickAndUploadPhoto?(url: string, headers: Record<string, string>): Promise<string | null>;
  googlePkce?(): Promise<{verifier: string; challenge: string}>;
  openAuthTab?(url: string): Promise<boolean>;
  getConstants?: () => {sdk: number; pipSupported: boolean};
  sdk?: number;
  pipSupported?: boolean;
};

const N: Native | undefined = (NativeModules as {AuroraPhone?: Native}).AuroraPhone;

export const phoneNative = {
  available: !!N,
  pipSupported: (): boolean => {
    try {
      const c = N?.getConstants ? N.getConstants() : (N as {pipSupported?: boolean} | undefined);
      return !!c?.pipSupported;
    } catch {
      return false;
    }
  },
  setPip: (on: boolean, w = 16, h = 9) => N?.setPip(on, w, h),
  enterPip: async () => (N ? N.enterPip().catch(() => false) : false),
  isInPip: async () => (N ? N.isInPip().catch(() => false) : false),
  setKeepAwake: (on: boolean) => N?.setKeepAwake(on),
  setImmersive: (on: boolean) => N?.setImmersive(on),
  setBrightness: (v: number) => N?.setBrightness(v),
  getBrightness: async () => (N ? N.getBrightness().catch(() => 0.5) : 0.5),
  setOrientation: (m: 'auto' | 'landscape' | 'portrait') => N?.setOrientation(m),
  getVolume: async () => (N ? N.getVolume().catch(() => 0.5) : 0.5),
  setVolume: (v: number) => N?.setVolume(v),
  haptic: (kind: 'tick' | 'long' | 'confirm' = 'tick') => N?.haptic(kind),
  /** Settings → Upload a photo: Android's photo picker, the picture made smaller (longest
   *  side 1024, JPEG, under 2 MB) and POSTed to `url` with `headers` as its raw body.
   *  Resolves the server's answer (JSON text), null when the picker was closed; rejects
   *  with a sentence (the server's refusal, or why it could not be read or sent). */
  pickAndUploadPhoto: (url: string, headers: Record<string, string>): Promise<string | null> =>
    N?.pickAndUploadPhoto ? N.pickAndUploadPhoto(url, headers) : Promise.reject(new Error("This phone can't pick a photo here.")),
  /** [auth-round] A fresh PKCE pair for Google in a Custom Tab: 32 bytes of SecureRandom
   *  (base64url, 43 characters) and base64url(SHA-256) of it. Rejects without the module. */
  googlePkce: (): Promise<{verifier: string; challenge: string}> =>
    N?.googlePkce ? N.googlePkce() : Promise.reject(new Error('no secure random source here')),
  /** [auth-round] Opens a web page in a Custom Tab; false = nothing on this phone can. */
  openAuthTab: async (url: string): Promise<boolean> => (N?.openAuthTab ? N.openAuthTab(url).catch(() => false) : false),
};

/** Picture-in-picture came or went (the player hides its chrome inside the window). */
export const onPipChange = (fn: (inPip: boolean) => void) => {
  const sub = DeviceEventEmitter.addListener('AuroraPip', (e: {inPip?: boolean}) => fn(!!e?.inPip));
  return () => sub.remove();
};
