// Which app-wide sheet is up, and with what. The sheets themselves live in
// components/Overlays.tsx, mounted once above the navigator; screens only
// call open*(). One sheet at a time — a sheet over a sheet is never wanted.
import {useEffect, useState} from 'react';
import type {HeroItem, XrayQuery} from './api';
import type {UpdateInfo} from './update';

export type Overlay =
  | {kind: 'peek'; item: HeroItem; onRemove?: (item: HeroItem) => void}
  | {kind: 'report'; hint?: string}
  | {kind: 'join'}
  | {kind: 'update'; info: UpdateInfo}
  | {kind: 'updateReady'; info: UpdateInfo}
  | {kind: 'trailer'; ids: string[]; title: string; imdbId?: string | null; type: 'movie' | 'show'; year?: number | null}
  | {kind: 'actions'; title: string; sub?: string; items: ActionItem[]}
  | {kind: 'xray'; query: XrayQuery; title: string; onClose?: () => void}
  | null;

// One row of the actions sheet (an episode's long-press menu).
export type ActionItem = {label: string; tag?: string; danger?: boolean; onPress: () => void};

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
// `ids` are the YouTube keys the page holds; the sheet asks the server first
// (Apple's trailer when there is one — trailers.ts), so the IMDb id matters.
export const openTrailer = (
  ids: string[],
  title: string,
  o: {imdbId?: string | null; type?: 'movie' | 'show' | 'series'; year?: number | null} = {},
) => {
  if (ids.length || o.imdbId)
    openOverlay({kind: 'trailer', ids, title, imdbId: o.imdbId, type: o.type === 'show' || o.type === 'series' ? 'show' : 'movie', year: o.year});
};
export const openUpdate = (info: UpdateInfo) => openOverlay({kind: 'update', info});
export const openUpdateReady = (info: UpdateInfo) => openOverlay({kind: 'updateReady', info});
export const openActions = (o: {title: string; sub?: string; items: ActionItem[]}) => openOverlay({kind: 'actions', ...o});
export const openXray = (o: {query: XrayQuery; title: string; onClose?: () => void}) => openOverlay({kind: 'xray', ...o});

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
