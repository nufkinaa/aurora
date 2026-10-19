// The native half of the phone remote (android/…/RemoteModule.kt, "AuroraRemote"):
// real key presses into the activity, the TV's own volume, the system's name
// for this TV, and bringing Aurora to the front. Absent in the logic tests
// and in builds from before it — every caller copes with null.
import {NativeModules} from 'react-native';
import type {RemoteKey, VolumeState} from './protocol';

type NativeVolume = {supported: boolean; level: number; muted: boolean};
type RemoteNative = {
  pressKey: (key: string) => Promise<boolean>;
  getVolume: () => Promise<NativeVolume>;
  setVolume: (level: number) => Promise<NativeVolume>;
  stepVolume: (dir: number) => Promise<NativeVolume>;
  setMuted: (on: boolean) => Promise<NativeVolume>;
  deviceName: () => Promise<string>;
  bringToFront: () => Promise<boolean>;
};

const mod = (): RemoteNative | null => {
  const m = (NativeModules as {AuroraRemote?: RemoteNative}).AuroraRemote;
  return m && typeof m.pressKey === 'function' ? m : null;
};

export const hasNativeRemote = () => !!mod();

const vol = (v: NativeVolume | null | undefined): VolumeState | null =>
  v && typeof v === 'object'
    ? {supported: !!v.supported, level: typeof v.level === 'number' ? Math.max(0, Math.min(1, v.level)) : null, muted: !!v.muted, scope: 'system'}
    : null;

export const nativeRemote = {
  /** A real key, down and up, through MainActivity (the same path as the remote in the hand). */
  press: async (key: Exclude<RemoteKey, 'home'>): Promise<boolean> => {
    const m = mod();
    if (!m) return false;
    try {
      return !!(await m.pressKey(key));
    } catch {
      return false;
    }
  },
  volume: async (): Promise<VolumeState | null> => {
    const m = mod();
    if (!m) return null;
    try {
      return vol(await m.getVolume());
    } catch {
      return null;
    }
  },
  setVolume: async (level: number) => vol(await mod()?.setVolume(level)),
  stepVolume: async (dir: 1 | -1) => vol(await mod()?.stepVolume(dir)),
  setMuted: async (on: boolean) => vol(await mod()?.setMuted(on)),
  deviceName: async (): Promise<string | null> => {
    const m = mod();
    if (!m) return null;
    try {
      const n = await m.deviceName();
      return typeof n === 'string' && n.trim() ? n.trim().slice(0, 40) : null;
    } catch {
      return null;
    }
  },
  bringToFront: async (): Promise<boolean> => {
    const m = mod();
    if (!m) return false;
    try {
      return !!(await m.bringToFront());
    } catch {
      return false;
    }
  },
};
