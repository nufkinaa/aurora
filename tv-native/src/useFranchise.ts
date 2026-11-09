// [franchise] The title page's "Part of … · 12 of 34" — asked AFTER the page's
// first paint (the page's own reads go first), only for a title with an IMDb
// id, and again when the page comes back into view (the order may have been
// switched on the franchise page; api.ts keeps the answer a few minutes and
// the switch forgets it). Lives in the small component that draws the line,
// so the answer landing re-renders that line and not the whole title page.
import {useEffect, useRef, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';
import {api, FranchiseLine} from './api';
import {isImdbId} from './franchiseRules';

/** How long after the page mounts the first ask waits. */
export const FRANCHISE_ASK_AFTER_MS = 900;

export function useFranchiseFor(imdbId: string | null | undefined, type: 'movie' | 'series', profileId: string | null | undefined): FranchiseLine | null {
  const [fr, setFr] = useState<FranchiseLine | null>(null);
  const focused = useIsFocused();
  const first = useRef(true);
  useEffect(() => {
    if (!focused || !isImdbId(imdbId)) return;
    let live = true;
    const wait = first.current ? FRANCHISE_ASK_AFTER_MS : 0;
    first.current = false;
    const t = setTimeout(() => {
      api
        .franchiseFor(imdbId, type, profileId)
        .then(r => {
          if (!live) return;
          const next = (r && r.franchise) || null;
          // the same answer again (a memo hit on return): no render
          setFr(cur => (cur && next && cur.id === next.id && cur.line === next.line ? cur : next));
        })
        .catch(() => {}); // decoration: a failure shows nothing
    }, wait);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [focused, imdbId, type, profileId]);
  return fr;
}
