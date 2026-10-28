// "Your TVs" — the phone app as the CONTROLLER (the website's public/js/
// remote.js, controller half; the protocol is the server's, src/lib/devices.js):
//
//   remote_subscribe   on every socket open: who this is, which device the
//                      remote screen watches (its position then ticks every second)
//   remote_devices     the profile's (and, when the admin allows, the household's) TVs
//   device_state       a watched TV's state
//   remote_command     a key, play/pause/seek/skip/next, a track, the volume,
//                      play_item ("Play on TV") — each answered by remote_ack
//
// The phone is never a TARGET (it is the remote; SessionWiring leaves the TV
// side off on a phone).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useEffect, useState} from 'react';
import {getActiveProfile, getToken} from '../../api';
import {isOpen, onMessage, onSocketOpen, send} from '../../realtime';
import {peekMe} from '../../navSection';
import {showToast} from '../../toast';
import type {RemoteState} from '../../remote/protocol';
import {registerProfileCache} from '../../profileScope';

export type Device = {
  deviceId: string;
  name: string;
  kind?: string;
  form?: string;
  model?: string;
  mine?: boolean;
  profile?: {id: string; name: string} | null;
  caps?: {navigate?: boolean; volume?: boolean; playItem?: boolean; tracks?: boolean};
  state?: RemoteState | null;
  heardAt?: number;
};

const ID_KEY = 'aurora.phone.remoteId';
let remoteId: string | null = null;
let devices: Device[] = [];
let household = false;
let heard = false;
let watchId: string | null = null;
let seq = 0;
const waiting = new Map<string, {resolve: (r: Ack) => void; timer: ReturnType<typeof setTimeout>}>();
const listSubs = new Set<(d: Device[]) => void>();
const stateSubs = new Set<(id: string, s: RemoteState) => void>();
export type Ack = {ok: boolean; error: string | null; message: string | null};

AsyncStorage.getItem(ID_KEY)
  .then(v => {
    if (v && /^[A-Za-z0-9_-]{8,48}$/.test(v)) remoteId = v;
    else {
      remoteId = `phone-${Math.random().toString(16).slice(2, 12)}${Date.now().toString(16).slice(-6)}`;
      AsyncStorage.setItem(ID_KEY, remoteId).catch(() => {});
    }
    subscribe();
  })
  .catch(() => {});

// the next profile is shown its own TVs, not this one's
registerProfileCache('phone/remote', () => {
  devices = [];
  household = false;
  watchId = null;
});

const emit = () => {
  for (const fn of [...listSubs]) fn(devices);
};

export function subscribe() {
  const profileId = getActiveProfile();
  if (!isOpen() || !profileId || !remoteId) return;
  send({type: 'remote_subscribe', profileId, token: getToken() || undefined, watch: watchId, ownDeviceId: null, remoteId, label: 'Android phone'});
}
onSocketOpen(() => {
  heard = false;
  subscribe();
});
onMessage('remote_devices', d => {
  heard = true;
  household = !!d.household;
  devices = (Array.isArray(d.devices) ? (d.devices as Device[]) : []).map(x => ({...x, heardAt: Date.now()}));
  emit();
});
onMessage('device_state', d => {
  const dev = devices.find(x => x.deviceId === d.deviceId);
  if (!dev) return;
  dev.state = (d.state as RemoteState) || dev.state;
  dev.heardAt = Date.now();
  for (const fn of [...stateSubs]) fn(String(d.deviceId), dev.state as RemoteState);
});
onMessage('remote_ack', d => {
  const w = waiting.get(String(d.id));
  if (!w) return;
  waiting.delete(String(d.id));
  clearTimeout(w.timer);
  w.resolve({ok: !!d.ok, error: (d.error as string) || null, message: (d.message as string) || null});
});

export const getDevices = () => devices;
export const devicesHeard = () => heard;
export const householdOn = () => household;
export const watchDevice = (id: string | null) => {
  if (watchId === id) return;
  watchId = id;
  subscribe();
};

/** -> {ok, error, message}; never rejects */
export const command = (deviceId: string, cmd: string, args: Record<string, unknown> = {}): Promise<Ack> =>
  new Promise(resolve => {
    if (!isOpen()) return resolve({ok: false, error: 'offline', message: 'Not connected to the server — trying again'});
    const id = `c${(++seq).toString(36)}`;
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ok: false, error: 'timeout', message: 'No answer — is it still on?'});
    }, 8000);
    waiting.set(id, {resolve, timer});
    send({type: 'remote_command', id, deviceId, cmd, args});
  });

export function useDevices(): Device[] {
  const [l, setL] = useState(devices);
  useEffect(() => {
    listSubs.add(setL);
    setL(devices);
    subscribe();
    return () => {
      listSubs.delete(setL);
    };
  }, []);
  return l;
}
export function useDeviceState(id: string | null): RemoteState | null {
  const [s, setS] = useState<RemoteState | null>(id ? devices.find(x => x.deviceId === id)?.state || null : null);
  useEffect(() => {
    if (!id) return;
    setS(devices.find(x => x.deviceId === id)?.state || null);
    const fn = (dev: string, st: RemoteState) => dev === id && setS({...st});
    stateSubs.add(fn);
    watchDevice(id);
    return () => {
      stateSubs.delete(fn);
      watchDevice(null);
    };
  }, [id]);
  return s;
}

/** What a library item / episode is on the wire (website remote.js wireItem). */
export const wireItem = (it: {id: string; title?: string; showTitle?: string | null; showId?: string | null; season?: number | null; episode?: number | null; type?: string | null; imdbId?: string | null; cover?: string | null; poster?: string | null; duration?: number | null}) => ({
  id: it.id,
  title: it.title || '',
  showTitle: it.showTitle || null,
  epTitle: it.showId ? it.title || null : null,
  season: it.season != null ? it.season : null,
  episode: it.episode != null ? it.episode : null,
  type: it.type === 'show' ? 'show' : it.showId ? null : 'movie',
  imdbId: it.imdbId || null,
  poster: it.cover || it.poster || null,
  duration: it.duration || null,
});

/** "Play on TV": the command, the remembered subtitle and audio languages of the person. */
export async function playOn(device: Device, item: Parameters<typeof wireItem>[0], o: {position?: number | null; restart?: boolean} = {}): Promise<Ack> {
  const prefs = (peekMe(getActiveProfile() || '')?.prefs || {}) as {subPick?: string; audioLang?: string};
  const sub = prefs.subPick || null;
  const res = await command(device.deviceId, 'play_item', {
    item: wireItem(item),
    position: o.position && o.position > 0 ? o.position : null,
    restart: !!o.restart,
    subLang: sub === 'off' || /^[a-z]{2,3}$/.test(String(sub || '')) ? sub : null,
    audioLang: /^[a-z]{2,3}$/.test(String(prefs.audioLang || '')) ? prefs.audioLang : null,
  });
  showToast(res.ok ? `Playing on ${device.name}` : res.message || `Couldn't play on ${device.name}`, res.ok ? '📺' : '⚠️');
  return res;
}
