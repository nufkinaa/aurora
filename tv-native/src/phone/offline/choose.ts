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

/** The space limit is full: "Remove the oldest watched copy to make room?" — true to remove and save. */
export const confirmRoom = (title: string) => (remove: {title: string; showTitle?: string | null; season?: number | null; episode?: number | null; sizeBytes: number}[], limitGb: number): Promise<boolean> =>
  new Promise(resolve => {
    const name = (c: (typeof remove)[number]) => (c.showTitle && c.season != null ? `${c.showTitle} · S${c.season} E${c.episode}` : c.title);
    const freed = remove.reduce((n, c) => n + (c.sizeBytes || 0), 0);
    openActions({
      title: `Your ${limitGb} GB on this phone is full`,
      sub: `To save “${title}”, remove ${remove.length === 1 ? 'the oldest copy you have watched' : `the ${remove.length} oldest copies you have watched`}?`,
      body: `${remove.map(name).join(', ')} — ${fmtSize(freed)}`,
      items: [
        {label: remove.length === 1 ? 'Remove it and save' : `Remove ${remove.length} and save`, danger: true, onPress: () => resolve(true)},
        {label: 'Cancel', onPress: () => resolve(false)},
      ],
    });
  });
