// Who this TV is to the phone remote: an id made once and kept, and a name
// ("Living room TV") the household can change — in Settings ("This TV's
// name") or from the phone (`rename`). Both belong to the box, not to a
// profile: the same TV keeps its name whoever is watching.
import {Platform} from 'react-native';
import {loadRemoteDevice, saveRemoteDeviceId, saveRemoteName} from '../storage';
import {nativeRemote} from './native';

export const DEFAULT_TV_NAME = 'Living room TV';
/** The names the Settings picker offers (after the system's own name, when it has one). */
export const TV_NAMES = ['Living room TV', 'Bedroom TV', "Kids' room TV", 'Office TV', 'Guest room TV'];

const ID_RE = /^[A-Za-z0-9_-]{8,48}$/;
export const newDeviceId = (rnd: () => number = Math.random) => {
  let s = '';
  while (s.length < 16) s += Math.floor(rnd() * 36).toString(36);
  return `tv-${s.slice(0, 16)}`;
};

/** The system's name for this TV (Settings → Device name), when it is a name
 *  and not just the model number the system falls back to. */
export const systemName = async (): Promise<string | null> => {
  const n = await nativeRemote.deviceName();
  const model = String((Platform.constants as {Model?: string} | undefined)?.Model || '');
  return n && n !== model ? n : null;
};

let device: {id: string; name: string} | null = null;
let loading: Promise<{id: string; name: string}> | null = null;
const nameFns = new Set<(name: string) => void>();

/** This TV's id and name (read once, made the first time). */
export const loadDevice = (): Promise<{id: string; name: string}> => {
  if (device) return Promise.resolve(device);
  if (loading) return loading;
  loading = (async () => {
    const stored = await loadRemoteDevice();
    let id = stored.id && ID_RE.test(stored.id) ? stored.id : null;
    if (!id) {
      id = newDeviceId();
      saveRemoteDeviceId(id);
    }
    const name = (stored.name && stored.name.trim()) || (await systemName()) || DEFAULT_TV_NAME;
    device = {id, name};
    loading = null;
    return device;
  })();
  return loading;
};

export const tvName = () => (device ? device.name : null);

export const setTvName = async (name: string) => {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
  if (!clean) return false;
  const d = await loadDevice();
  if (d.name === clean) return true;
  device = {...d, name: clean};
  await saveRemoteName(clean);
  for (const fn of [...nameFns]) fn(clean);
  return true;
};

/** Told whenever the name changes. Returns the unsubscribe. */
export const onTvName = (fn: (name: string) => void) => {
  nameFns.add(fn);
  return () => {
    nameFns.delete(fn);
  };
};

/** Test-only. */
export const _resetIdentity = () => {
  device = null;
  loading = null;
};
