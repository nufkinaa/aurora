// The size sheet, as saveOffline asks it (offline/SizeSheet.tsx draws it): each size the server
// can make, the sound when there are several, and "Always use the size I pick" — which becomes
// the standing choice (Settings → On this device changes it back to Ask each time).
import {askSize} from './SizeSheet';
import type {Chooser} from './store';
import {setOfflinePrefs} from './store';
import type {OfflineQuality} from './rules';

export const chooseQuality =
  (title: string): Chooser =>
  async ({options, audio, chosenAudio, free}) => {
    const a = await askSize({name: title, options, sounds: audio, chosenAudio, free});
    if (!a) return null;
    if (a.always) setOfflinePrefs({quality: a.quality as OfflineQuality});
    return {quality: a.quality, audio: a.audio};
  };
