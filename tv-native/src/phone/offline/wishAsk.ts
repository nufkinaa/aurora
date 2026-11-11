// The size sheet for a title the server does not have yet, then the wish (wishes.ts) — the
// website's askWish / wishButton (public/js/offlineWish.js): sizes estimated before the file
// exists, and for an episode "And every new episode of season N" / "…of this show".
import {api} from '../../api';
import {showToast} from '../../toast';
import {askSize} from './SizeSheet';
import {phoneHevc, setOfflinePrefs} from './store';
import type {OfflineQuality} from './rules';
import {addWish, removeWish, wishOf} from './wishes';
import {scopeChoices, wishLead, wishMadeText, WishTarget} from './wishRules';
import type {OfflineWish} from '../../api';

/** The size sheet for a title not on the server yet, then the wish. → the wish, or null. */
export async function askWish(t0: WishTarget, label: string): Promise<OfflineWish | null> {
  let t = {...t0};
  const h = await phoneHevc();
  let options: {quality: string; label: string; sizeBytes: number; estimated?: boolean; detail?: string; note?: string}[] = [];
  try {
    options = (await api.offlineWishOptions({type: t.type, imdbId: t.imdbId, season: t.season, episode: t.episode, duration: t.duration, hevc: h})).options || [];
  } catch {}
  if (!options.length) options = [{quality: '720', label: '720p', detail: '', sizeBytes: 0, estimated: true}];
  const a = await askSize({name: label, lead: wishLead(t, label), options, scopes: scopeChoices(t)});
  if (!a) return null;
  if (a.always) setOfflinePrefs({quality: a.quality as OfflineQuality});
  if (a.scope === 'season') t = {...t, scope: 'season', episode: undefined};
  if (a.scope === 'show') t = {...t, scope: 'show', season: undefined, episode: undefined};
  const w = await addWish(t, a.quality);
  showToast(wishMadeText(t, label), '📱');
  return w;
}

/** "This device too" / "Will be saved to this device" — a press: make the wish, or stop it. */
export async function toggleWish(t: WishTarget, label: string) {
  const w = wishOf(t);
  try {
    if (w && w.state !== 'failed') {
      await removeWish(w.id);
      showToast(`“${label}” won't be saved to this device`, '📱');
    } else await askWish(t, label);
  } catch (e) {
    showToast(`Couldn't: ${(e as Error)?.message || 'try again'}`, '⚠️');
  }
}

