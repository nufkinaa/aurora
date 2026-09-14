// Which app-wide sheet is up, and with what. The sheets themselves live in
// components/Overlays.tsx, mounted once above the navigator; screens only
// call open*(). One sheet at a time — a sheet over a sheet is never wanted.
import {useEffect, useState} from 'react';
import type {HeroItem} from './api';
import type {UpdateInfo} from './update';

export type Overlay =
  | {kind: 'peek'; item: HeroItem; onRemove?: (item: HeroItem) => void}
  | {kind: 'report'; hint?: string}
  | {kind: 'join'}
  | {kind: 'update'; info: UpdateInfo}
  | {kind: 'trailer'; ids: string[]; title: string}
  | null;

let current: Overlay = null;
const subs = new Set<(o: Overlay) => void>();
const set = (o: Overlay) => {
  current = o;
  for (const fn of subs) fn(o);
};

export const openOverlay = (o: Exclude<Overlay, null>) => {
  if (current) return; // one at a time
  set(o);
};
export const closeOverlay = () => set(null);
export const overlayOpen = () => current !== null;

export const openPeek = (item: HeroItem, onRemove?: (item: HeroItem) => void) =>
  openOverlay({kind: 'peek', item, onRemove});
export const openReport = (hint?: string) => openOverlay({kind: 'report', hint});
export const openJoinParty = () => openOverlay({kind: 'join'});
export const openTrailer = (ids: string[], title: string) => {
  if (ids.length) openOverlay({kind: 'trailer', ids, title});
};
export const openUpdate = (info: UpdateInfo) => openOverlay({kind: 'update', info});

export const useOverlay = () => {
  const [o, setO] = useState<Overlay>(current);
  useEffect(() => {
    subs.add(setO);
    return () => {
      subs.delete(setO);
    };
  }, []);
  return o;
};
