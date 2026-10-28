// "Save to this phone — which size?" — the website's quality sheet (offline
// picker), as the app's actions sheet: each size the server can make, with
// how big it is and what it is.
import {openActions} from '../../overlay';
import {fmtSize, Option} from './rules';

export const chooseQuality = (title: string) => (options: Option[]): Promise<string | null> =>
  new Promise(resolve => {
    openActions({
      title: `Save “${title}” to this phone`,
      sub: 'Pick a size. Settings → Saved on this phone remembers one for next time.',
      items: [
        ...options.map(o => ({
          label: `${o.label}${o.sizeBytes ? ` · ${o.instant ? '' : '~'}${fmtSize(o.sizeBytes)}` : ''}`,
          tag: [o.detail, o.ready ? 'ready on the server' : o.note].filter(Boolean).join(' — '),
          onPress: () => resolve(o.quality),
        })),
        {label: 'Cancel', onPress: () => resolve(null)},
      ],
    });
  });
