// "Play on TV" and "Continue on this phone" — the phone app as the SENDER
// (the website's public/js/remote.js playOn / continueHere; the words are
// remote/playOnWords.ts, the website's word for word).
//
//   sendToTv      a title page, an episode, the player: pick the TV — or, with
//                 one on, confirm it ("Play “Arrival” on Living room TV?") —
//                 send it at this second with these subtitles and this audio,
//                 then the remote for that TV (the player pauses itself first)
//   continueHere  the remote: what the TV plays, here — the TV is paused, the
//                 phone's player opens at the TV's second, same subtitles and audio
import {StackActions} from '@react-navigation/native';
import {openActions} from '../../overlay';
import {showToast} from '../../toast';
import {navRef} from '../../rootNav';
import {playerParams} from '../../remote/playItem';
import {PLAY_ON, playOnTitle} from '../../remote/playOnWords';
import type {NowState} from '../../remote/protocol';
import {pushPhone} from '../nav';
import {command, Device, playOn, wireItem} from './controller';

type Item = Parameters<typeof wireItem>[0];
export type SendOpts = {position?: number | null; restart?: boolean; subLang?: string | null; audioLang?: string | null; after?: () => void};

/** The sheet's second line for a device: whose it is, or that it is on its profile wall. */
export const tvTag = (d: Device): string | undefined => (d.wall ? PLAY_ON.onWall : d.mine === false && d.profile ? d.profile.name : undefined);

export function sendToTv(tvs: Device[], item: Item, o: SendOpts = {}) {
  if (!tvs.length) return;
  const what = playOnTitle(item);
  const go = async (d: Device) => {
    const r = await playOn(d, item, o);
    if (!r.ok) return;
    o.after?.();
    // the remote for that TV (the same device id when a TV on its wall comes into the profile)
    pushPhone('Remote', {deviceId: d.deviceId});
  };
  openActions({
    title: tvs.length === 1 ? PLAY_ON.confirm(tvs[0].name, what) : PLAY_ON.pick,
    sub: tvs.length === 1 ? undefined : what,
    items: tvs.map(d => ({label: d.name, tag: tvTag(d), uiId: 'phone.remote.device', onPress: () => go(d)})),
  });
}

/** What the phone's own player is playing, as Play on TV sends it (from its remote NowState). */
export const fromNow = (n: NowState): {item: Item; position: number; subLang: string | null; audioLang: string | null} => ({
  item: {id: n.id, title: n.epTitle || n.title, showTitle: n.showTitle, showId: n.showTitle ? 'show' : null, season: n.season, episode: n.episode, poster: n.poster, duration: n.duration || null},
  position: n.position || 0,
  subLang: n.sub == null ? 'off' : n.subs.find(t => t.id === n.sub)?.lang || null,
  audioLang: n.audios.find(t => t.id === n.audio)?.lang || null,
});

/** The TV's position NOW: the last report, moved on by the time since (`heardAt`, ms). */
export const livePosition = (n: NowState, heardAt: number | undefined, now = Date.now()) =>
  Math.max(0, (n.position || 0) + (n.paused || n.buffering || !heardAt ? 0 : Math.max(0, (now - heardAt) / 1000)));

export async function continueHere(d: Device | null, n: NowState | null) {
  if (!d || !n) {
    showToast(PLAY_ON.nothingThere(d ? d.name : 'the TV'), '📺');
    return false;
  }
  const at = livePosition(n, d.heardAt);
  const f = fromNow(n);
  if (!n.paused) await command(d.deviceId, 'pause');
  const params = playerParams({
    item: {id: n.id, title: n.title, showTitle: n.showTitle, epTitle: n.epTitle, season: n.season, episode: n.episode, type: null, imdbId: null, poster: n.poster, duration: n.duration || null},
    position: at,
    restart: false,
    subLang: f.subLang,
    audioLang: f.audioLang,
  });
  if (!navRef.isReady()) return false;
  navRef.dispatch(StackActions.push('Player', params));
  showToast(PLAY_ON.continued(d.name), '📱');
  return true;
}
