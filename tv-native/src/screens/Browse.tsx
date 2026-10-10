// Movies / Shows — the site's Browse (public/js/screens/browse.js), re-shaped
// for a 10-foot screen with a remote.
//
// THE GRID IS THE PAGE. Everything that used to sit above it — the search stop,
// the category pills, the genre/unwatched band — lives in a FILTER PANEL that
// opens from the RIGHT edge, the mirror of the nav rail on the left: RIGHT from
// the last column opens it, LEFT or Back closes it and hands focus straight
// back to the card you left. One slim heading line (title + count) is all the
// chrome the grid pays for.
//
// This replaced a collapsing header (2026-08-23, elia): the collapse looked
// junky, the search stop duplicated the Search page, and a sticky Load-more
// strip under the grid read as a stray control. Paging is now automatic —
// the next page is fetched as focus nears the end of what is loaded, and a
// page APPENDS, so nothing under the focused card ever moves.
//
// The category list, the genre picker, the Unwatched toggle and Surprise me
// are the site's own controls; only their home changed.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  Animated,
  BackHandler,
  Easing,
  FlatList,
  StyleSheet,
  TVFocusGuideView,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Btn from '../components/Btn';
import Chip from '../components/Chip';
import MiniSpinner from '../components/MiniSpinner';
import NavRail from '../components/NavRail';
import Picker from '../components/Picker';
import Skeleton from '../components/Skeleton';
import {Empty, ErrorState} from '../components/States';
import Card, {CARD_W} from '../components/Card';
import {api, HeroItem, ProfileState} from '../api';
import {onMessage} from '../realtime';
import {warmItem} from '../prefetch';
import {artIdle, artForget, limits as artLimits} from '../artPrefetch';
import {prefetchable} from '../cardArt';
import {watchStateFor} from '../watchState';
import {canNavigate} from '../navLock';
import {
  atRightEdge,
  captureFocus,
  focusJustMoved,
  pressMovedFocus,
  railOpen,
  useFocusFallback,
  useIsLive,
  useListClaim,
  useTVKeys,
} from '../focus';
import {defer, useScreenIn} from '../motion';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, CLEARANCE, motion, focus} = theme;

const EASE = Easing.bezier(...(focus.ease as unknown as [number, number, number, number]));

// P17. 18px x 0.70 — the grid gap, not spacing.md.
const GRID_GAP = 13;
// browse.js:352 — the placeholder count is fixed, not derived from the viewport.
const SKELETONS = 18;
// The filter panel: wide enough for "Downloaded" and the genre picker at row
// type, narrow enough to leave four columns of the grid showing behind it.
const PANEL_W = 300;
// The passive edge strip that says a panel lives here (the rail's collapsed
// 72dp strip, mirrored and slimmer — it carries one glyph and no focus target).
const STRIP_W = 44;
// How close to the end of the loaded list focus has to get before the next page
// is fetched: two rows out, so the page lands before the viewer reaches it.
const PREFETCH_ROWS = 2;
// HOW MUCH OF THE GRID EXISTS — IN ROWS. With numColumns the list's "items"
// are ROWS (FlatList hands VirtualizedList ceil(n / numColumns) of them), so
// the three numbers below count rows of six cards, not cards. They used to be
// 24 / 12 / 3, written as if they counted cards: the first commit of Movies
// mounted up to 24 ROWS — every title of the library and the whole first
// catalogue page, 78 cards on this server, ~900 views and 78 picture requests
// — before the screen could show its first three; a batch was 72 cards; and
// beyond those first rows only one viewport either side was kept.
//
// Geometry (960×540 canvas): a row is 186 + 13 = 199dp; the list is 472dp
// tall under the heading, so three rows show at the top and parts of four
// once it has scrolled — 2.4 rows to a viewport.
//
//  • FIRST COMMIT: 5 rows (30 cards) — what shows, and a row and a half
//    under it. These first rows are never unmounted (VirtualizedList keeps
//    them), so focus restore, "Change filters" → first card and the scroll
//    back to the top always find them.
//  • THEN, BY THEMSELVES, 2 rows (12 cards) per batch, 50 ms apart, until the
//    window is full — small commits after the first picture instead of one
//    huge one in front of it.
//  • THE WINDOW: 11 viewports — 5 either side, ≈ 12 rows. A held DOWN moves
//    a row every ~110 ms, so that is 1.3 s of rows already mounted (with
//    their pictures asked for) ahead of focus, against a fill rate of 2 rows
//    per batch; before it was the first 24 rows and then one viewport (0.26
//    s) ahead. Mounted at most: 5 + 12 + 3.4 + 12 ≈ 30 rows, about what the
//    old numbers held (24 + 6).
// A grid of up to ~15 rows ends up fully mounted, as it always was — only no
// longer in its first commit.
const GRID_FIRST_ROWS = 5;
const GRID_BATCH_ROWS = 2;
const GRID_WINDOW = 11;
// Rows the list keeps rendered beyond the viewport, each way.
const GRID_AHEAD = Math.round(((GRID_WINDOW - 1) / 2) * 2.4);
// A failed read is tried again by itself after these waits (then it waits for
// Retry). Measured through a 0.9 Mbit / 250 ms line: one dropped request used
// to read as "nothing here" for good. Spaced out so a struggling line is not
// hammered with the very requests it is struggling to carry.
const BACKOFF = [3000, 8000, 20000];

// The site's CATEGORIES, verbatim (browse.js:195-201). `withLocal` leads with
// your own library and then continues into the catalog; `local` is the library
// alone; `taste` re-ranks by the genres you actually watch.
type Category = {
  id: string;
  label: string;
  catalog?: string;
  withLocal?: boolean;
  local?: boolean;
  taste?: boolean;
};
const CATEGORIES: Category[] = [
  {id: 'all', label: 'All', catalog: 'trending', withLocal: true},
  {id: 'trending', label: 'Trending', catalog: 'trending'},
  {id: 'new', label: 'New', catalog: 'new'},
  {id: 'top', label: 'Top rated', catalog: 'top'},
  {id: 'recommended', label: 'For you', catalog: 'trending', taste: true},
  {id: 'downloaded', label: 'Downloaded', local: true},
];

const byTitle = (a: HeroItem, b: HeroItem) => (a.title || '').localeCompare(b.title || '');
const norm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (i: HeroItem) => i.id || i.imdbId || i.title;

export default function Browse({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Browse'>) {
  const {kind} = route.params;
  const title = kind === 'show' ? 'Shows' : 'Movies';
  const {profileId} = useApp();
  const {width, safeBottom} = useTvMetrics();
  const screenIn = useScreenIn();
  // P17 — a FIXED 124dp cell at a 13dp gap in the content box, not a fluid
  // column. The content box now ends at the edge strip rather than the safe
  // inset: the strip is chrome the grid must not slide under.
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - STRIP_W - spacing.sm + GRID_GAP) / (CARD_W + GRID_GAP)),
  );

  const [lib, setLib] = useState<HeroItem[] | null>(null);
  const [category, setCategory] = useState('all');
  const [genre, setGenre] = useState('');
  const [unwatched, setUnwatched] = useState(false);
  const [genreList, setGenreList] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Catalog items fetched so far, in catalog order — that order IS the ranking.
  const [fetched, setFetched] = useState<HeroItem[]>([]);
  const [page, setPage] = useState(-1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [profState, setProfState] = useState<ProfileState | null>(null);
  const [likedGenres, setLikedGenres] = useState<string[]>([]);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(lib !== null || fetched.length > 0);
  // Started/finished across ALL THREE progress maps. A bare progress[id] lookup
  // only ever answers for downloaded FILMS — catalog items have no library id
  // at all and streamed history lives in streamProgress/episodeProgress — so
  // the Unwatched toggle was a no-op for every streamable title on the grid.
  const marks = useMemo(() => watchStateFor(profState), [profState]);

  const cat = CATEGORIES.find(c => c.id === category) || CATEGORIES[0];
  const localOnly = !!cat.local;

  // Is this screen the one on top? The automatic retries wait while it is not
  // (a Detail page above it has its own reads to make on the same slow line).
  const screenLive = useIsLive();
  const screenLiveRef = useRef(screenLive);
  screenLiveRef.current = screenLive;

  // The library list. A failure is NOT an empty library: `lib` stays null
  // (unknown), the page says so, and the read is tried again on the backoff.
  // Setting [] here used to open the grid without the downloaded titles and
  // count them as "0", with only leaving and coming back to fix it.
  const [libErr, setLibErr] = useState(false);
  const [libTry, setLibTry] = useState(0);
  const [libRetrying, setLibRetrying] = useState(false);
  const libAttempts = useRef(0);
  useEffect(() => {
    libAttempts.current = 0;
  }, [kind]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    api
      .library()
      .then(l => {
        if (!live) return;
        libAttempts.current = 0;
        setLibErr(false);
        setLibRetrying(false);
        setLib((kind === 'show' ? l.shows : l.movies).map(i => ({...i, source: 'downloaded' as const})));
      })
      .catch(() => {
        if (!live) return;
        setLibErr(true);
        const n = libAttempts.current++;
        if (n >= BACKOFF.length) return setLibRetrying(false); // Retry is the viewer's now
        setLibRetrying(true);
        const fire = () => {
          if (!live) return;
          // Not on top: look again shortly rather than spend the line now.
          if (!screenLiveRef.current) {
            timer = setTimeout(fire, 2000);
            return;
          }
          setLibTry(t => t + 1);
        };
        timer = setTimeout(fire, BACKOFF[n]);
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [kind, libTry]);

  useEffect(() => {
    let live = true;
    api.catalogGenres(kind).then(r => live && setGenreList(r.genres || [])).catch(() => {});
    // Unwatched needs saved progress, and "For you" needs the genres this profile
    // said it likes — the same two things the site reads off `state`.
    api
      .state(profileId)
      .then(s => {
        if (!live) return;
        setProfState(s);
        setLikedGenres(s.likedGenres || []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [kind, profileId]);

  // The library changed on the server (a download landed, a rescan): the
  // Downloaded shelf of this grid is read again. Only that — the catalogue
  // pages already on screen stay as they are, so the grid under the viewer's
  // focus does not reshuffle. Held a moment: a season landing says so per file.
  //
  // Only while this grid is the screen on top. Under a title page or the
  // player it used to read the whole library (and re-render, frozen) once per
  // burst of messages — a season landing during a film meant a 90 KB parse
  // behind the player every few seconds. Now the change is noted, and read
  // once when the grid is back on top (Home does the same with its rows).
  const libStale = useRef(false);
  useEffect(() => {
    let on = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onMessage('library_updated', () => {
      if (!screenLiveRef.current) {
        libStale.current = true;
        return;
      }
      if (t) return;
      t = setTimeout(() => {
        t = null;
        if (!screenLiveRef.current) {
          libStale.current = true;
          return;
        }
        console.log('[live] browse: library changed, shelf re-read');
        api
          .library(true)
          .then(l => {
            if (!on) return;
            setLibErr(false);
            setLib((kind === 'show' ? l.shows : l.movies).map(i => ({...i, source: 'downloaded' as const})));
          })
          .catch(() => {});
      }, 2500);
    });
    return () => {
      on = false;
      off();
      if (t) clearTimeout(t);
    };
  }, [kind]);
  useEffect(() => {
    if (!screenLive || !libStale.current) return;
    libStale.current = false;
    let on = true;
    console.log('[live] browse: library changed while away, shelf re-read');
    // Not `fresh`: the message already dropped the kept list (realtime.ts), so
    // this is either a new read or the one another screen made since.
    api
      .library()
      .then(l => {
        if (!on) return;
        setLibErr(false);
        setLib((kind === 'show' ? l.shows : l.movies).map(i => ({...i, source: 'downloaded' as const})));
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [screenLive, kind]);

  // What "For you" is built from: the genres you picked in Preferences if you
  // picked any, otherwise the ones your own library leans on.
  const tasteGenres = useMemo(() => {
    if (likedGenres.length) return likedGenres.slice(0, 6);
    const tally = new Map<string, number>();
    for (const i of lib || []) for (const g of i.genres || []) tally.set(g, (tally.get(g) || 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);
  }, [likedGenres, lib]);

  // ---- catalog paging ----------------------------------------------------
  // One effect owns the fetch: it resets on any change of category/genre and
  // then fills page by page. `reqId` makes a superseded round of fetches unable
  // to append to the new list. A category already opened is not fetched again —
  // session-scoped, like the site's own viewState.
  const reqId = useRef(0);
  const cache = useRef(
    new Map<string, {items: HeroItem[]; page: number; hasMore: boolean}>(),
  );
  const cacheKey = `${kind}|${category}|${genre}`;
  // The first page failed (not: answered with nothing). Shown as an error with
  // Retry, and tried again by itself on BACKOFF; `catTry` re-runs the fetch.
  const [catErr, setCatErr] = useState(false);
  const [catTry, setCatTry] = useState(0);
  const [catRetrying, setCatRetrying] = useState(false);
  const catAttempts = useRef(0);
  // A new grid starts clean. NOT reset per attempt: a retry in flight keeps
  // the error (and its focused Retry) up rather than flashing skeletons.
  useEffect(() => {
    catAttempts.current = 0;
    setCatErr(false);
    setCatRetrying(false);
  }, [cacheKey]);
  useEffect(() => {
    if (localOnly) {
      // Bump the request id here too: an in-flight catalog fetch from the
      // previous category must not write into the Downloaded view's state.
      ++reqId.current;
      setFetched([]);
      setHasMore(false);
      setPage(-1);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    const hit = cache.current.get(cacheKey);
    if (hit) {
      setFetched(hit.items);
      setPage(hit.page);
      setHasMore(hit.hasMore);
      setLoading(false);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setFetched([]);
    setPage(-1);
    setHasMore(true);
    setLoading(true);
    api
      .catalog({type: kind, category: cat.catalog || 'trending', genre: genre || null, page: 0})
      .then(r => {
        if (!live || id !== reqId.current) return;
        catAttempts.current = 0;
        setCatErr(false);
        setCatRetrying(false);
        const list = r.items || [];
        cache.current.set(cacheKey, {items: list, page: 0, hasMore: !!r.hasMore});
        setFetched(list);
        setPage(0);
        setHasMore(!!r.hasMore);
      })
      .catch(() => {
        if (!live || id !== reqId.current) return;
        // Failed, not empty: `page` stays -1 (nothing to page on from) and
        // `hasMore` stays true — nothing has said the catalogue is over.
        setFetched([]);
        setCatErr(true);
        const n = catAttempts.current++;
        if (n >= BACKOFF.length) return setCatRetrying(false); // Retry is the viewer's now
        setCatRetrying(true);
        const fire = () => {
          if (!live || id !== reqId.current) return;
          if (!screenLiveRef.current) {
            timer = setTimeout(fire, 2000);
            return;
          }
          setCatTry(t => t + 1);
        };
        timer = setTimeout(fire, BACKOFF[n]);
      })
      .finally(() => live && id === reqId.current && setLoading(false));
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, category, genre, localOnly, cacheKey, catTry]);

  // Retry, pressed: every read that failed, at once, each with a fresh run of
  // automatic tries behind it.
  const retryAll = useCallback(() => {
    if (libErr) {
      libAttempts.current = 0;
      setLibRetrying(true);
      setLibTry(t => t + 1);
    }
    if (catErr) {
      catAttempts.current = 0;
      setCatRetrying(true);
      setCatTry(t => t + 1);
    }
  }, [libErr, catErr]);

  // A failed NEXT page does not end the list: `hasMore` stays as it was and the
  // next trigger (focus nearing the end) tries again — but not before the
  // backoff has passed, so a viewer walking the last row does not fire a
  // request per press at a line that just dropped one.
  const nextFails = useRef(0);
  const nextNotBefore = useRef(0);
  const nextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nextErr, setNextErr] = useState(false);
  // The last card focus rested on, so the retry timer can tell whether the
  // viewer is still down at the end of the list.
  const lastFocusIdx = useRef(0);
  // PAGING IS ASKED FOR FROM A CARD'S FOCUS HANDLER, so what it does there has
  // to be next to nothing. It used to setLoading(true) on the spot — a render
  // of this whole screen in front of the next press — and apply the answer
  // (a page of new cells) the same way. The request still leaves at once (a
  // held DOWN needs the page; waiting for rest would stop the list at its end
  // for no reason), but every state change is a transition (motion.ts defer):
  // React does it between presses and drops it for the next one.
  //
  // Because `loading` now lands a moment late, "a page is on its way" is a
  // ref for the guard; it is let go only once the commit that carries the new
  // page (or the failure) has happened — `loadSeq` — so a press in between
  // cannot ask for the same page twice.
  const nextBusy = useRef(false);
  const [loadSeq, setLoadSeq] = useState(0);
  useEffect(() => {
    nextBusy.current = false;
  }, [loadSeq, cacheKey]);
  useEffect(() => {
    nextFails.current = 0;
    nextNotBefore.current = 0;
    setNextErr(false);
    if (nextTimer.current) clearTimeout(nextTimer.current);
    nextTimer.current = null;
  }, [cacheKey]);
  useEffect(
    () => () => {
      if (nextTimer.current) clearTimeout(nextTimer.current);
    },
    [],
  );
  const loadNext = useCallback(() => {
    if (nextBusy.current || loading || !hasMore || localOnly || page < 0) return;
    if (Date.now() < nextNotBefore.current) return;
    const id = reqId.current;
    nextBusy.current = true;
    defer(() => setLoading(true));
    api
      .catalog({type: kind, category: cat.catalog || 'trending', genre: genre || null, page: page + 1})
      .then(r => {
        if (id !== reqId.current) return;
        // De-dupe on append: the catalogs overlap between pages often enough that
        // letting them through gave the grid the same poster twice.
        const nextPage = r.page ?? page + 1;
        nextFails.current = 0;
        nextNotBefore.current = 0;
        defer(() => {
          setFetched(prev => {
            const have = new Set(prev.map(keyOf));
            const merged = [...prev, ...(r.items || []).filter(i => !have.has(keyOf(i)))];
            cache.current.set(cacheKey, {items: merged, page: nextPage, hasMore: !!r.hasMore});
            return merged;
          });
          setPage(nextPage);
          setHasMore(!!r.hasMore);
          setNextErr(false);
        });
      })
      .catch(() => {
        if (id !== reqId.current) return;
        const wait = BACKOFF[Math.min(nextFails.current, BACKOFF.length - 1)];
        nextFails.current += 1;
        nextNotBefore.current = Date.now() + wait;
        setNextErr(true);
        // Someone parked on the last row moves no focus, so no trigger would
        // ever come: try once more by itself when the wait is over, if focus
        // is still near the end and the screen is on top.
        if (nextTimer.current) clearTimeout(nextTimer.current);
        nextTimer.current = setTimeout(() => {
          nextTimer.current = null;
          if (id !== reqId.current || !screenLiveRef.current) return;
          if (lastFocusIdx.current >= itemCountRef.current - colsRef.current * PREFETCH_ROWS) loadNextRef.current();
        }, wait + 50);
      })
      .finally(() => {
        // superseded (another category was opened): that round owns `loading`
        if (id !== reqId.current) {
          nextBusy.current = false;
          return;
        }
        defer(() => {
          setLoading(false);
          setLoadSeq(n => n + 1);
        });
      });
  }, [cacheKey, cat.catalog, genre, hasMore, kind, loading, localOnly, page]);
  // Read through a ref by the card focus handler, which must keep a stable
  // identity (it is a prop on every memoized card).
  const loadNextRef = useRef(loadNext);
  loadNextRef.current = loadNext;
  const colsRef = useRef(cols);
  colsRef.current = cols;

  // A catalogue title as the grid shows it: tagged `source: 'stream'`. ONE
  // tagged object per fetched title, made once and kept. The tagging used to
  // be a `.map(i => ({...i, source}))` inside the list memo below, which runs
  // again whenever a page is appended (or the library / profile state lands):
  // every title got a new object each time, so every memoised card in the
  // mounted window re-rendered on each page — while a key was held down the
  // grid. (`fetched` itself stays untagged: "Surprise me" reads it.)
  const streamTagged = useRef(new WeakMap<HeroItem, HeroItem>()).current;

  // ---- what to show ------------------------------------------------------
  // `visible()` transcribed (browse.js:310-327): the WHOLE downloaded library,
  // alphabetical, ahead of the catalog whenever the category asks for it.
  const {list: items, owned} = useMemo(() => {
    const downloaded = lib || [];
    let local: HeroItem[] = [];
    if (localOnly || cat.withLocal) {
      local = downloaded;
      if (genre) local = local.filter(i => (i.genres || []).includes(genre));
      if (unwatched) local = local.filter(i => !marks(i).finished);
      // Alphabetical, always. A sort control here was one more thing to read for
      // a list you can already see all of.
      local = [...local].sort(byTitle);
    }
    if (localOnly) return {list: local, owned: local.length};

    const libTitles = new Set(downloaded.map(i => norm(i.title)));
    let stream = fetched.filter(m => m.imdbId && !libTitles.has(norm(m.title)));
    if (unwatched) stream = stream.filter(m => !marks(m).finished);
    let tagged = stream.map(i => {
      let t = streamTagged.get(i);
      if (!t) {
        t = {...i, source: 'stream' as const};
        streamTagged.set(i, t);
      }
      return t;
    });
    // "For you": float the genres this profile actually watches to the front,
    // keeping catalog order within each group.
    if (cat.taste && tasteGenres.length && !genre) {
      const liked = new Set(tasteGenres);
      const hit = tagged.filter(i => (i.genres || []).some(g => liked.has(g)));
      const rest = tagged.filter(i => !(i.genres || []).some(g => liked.has(g)));
      tagged = [...hit, ...rest];
    }
    return {list: [...local, ...tagged], owned: local.length};
  }, [cat, fetched, genre, lib, localOnly, marks, streamTagged, tasteGenres, unwatched]);
  const itemCount = items.length;
  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => artForget('grid'), []);

  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Detail', {item});
    },
    [navigation],
  );
  // The site rolls over everything the screen could show, not over what is
  // currently filtered in (browse.js:534).
  //
  // The panel is closed FIRST — focus handed back to the card it was opened
  // from (or the first card when a filter changed) — and the page opens a beat
  // later. Navigating straight from the panel unmounted the focused Surprise
  // button under the new page, and BACK came home to a screen with nothing
  // lit (Mi TV, 2026-10-09). The same card is asked for again when this screen
  // is back on top, in case Android dropped it in between.
  const surprise = () => {
    const pool = [...(lib || []), ...fetched];
    if (!pool.length) return;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const back = panel ? closePanel() : captureFocus();
    setTimeout(() => {
      if (!canNavigate(navigation)) return;
      const off = navigation.addListener('focus', () => {
        off();
        back();
      });
      navigation.push('Detail', {item: chosen});
    }, 60);
  };

  // ---- the filter panel --------------------------------------------------
  const [panel, setPanel] = useState(false);
  const slide = useRef(new Animated.Value(0)).current;
  // Who had focus before the panel took it — the card you were on — so closing
  // can give it straight back (the rail does exactly this).
  const restore = useRef<(() => void) | null>(null);
  // The grid's first card and the list itself: where focus lands when the
  // panel closes on a CHANGED grid (the card you came from may be filtered
  // away), and this screen's focus fallback.
  const firstCard = useRef(null);
  const listRef = useRef<FlatList<HeroItem>>(null);
  // Did a filter change while the panel was open? Decides restore-vs-first.
  const dirty = useRef(false);
  const openPanel = useCallback(() => {
    restore.current = captureFocus();
    dirty.current = false;
    setPanel(true);
  }, []);
  // Returns the focus restore it used, so a caller that leaves the screen right
  // after (Surprise me) can ask for the same element again on the way back.
  const closePanel = useCallback(() => {
    setPanel(false);
    slide.setValue(0);
    let back: () => void;
    if (dirty.current) {
      // New results: start them from the top, on the first card. Restoring to
      // the old card would aim at a cell the filter may have unmounted —
      // focus would land nowhere.
      listRef.current?.scrollToOffset({offset: 0, animated: false});
      back = () => (firstCard.current as {requestTVFocus?: () => void} | null)?.requestTVFocus?.();
    } else {
      const r = restore.current;
      back = () => r?.();
    }
    back();
    restore.current = null;
    return back;
  }, [slide]);
  const pick = useCallback((fn: () => void) => {
    dirty.current = true;
    fn();
  }, []);
  useEffect(() => {
    if (!panel) return;
    Animated.timing(slide, {
      toValue: 1,
      duration: motion.med,
      easing: EASE,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }, [panel, slide]);

  // RIGHT from the last column opens it; LEFT inside it closes it. The race
  // guard is the rail's: the press that carried focus INTO the last column must
  // not also open the panel. Deaf while the rail is open, while the genre
  // picker's trap is up (useTVKeys handles that), and while the panel's own
  // Back is pending.
  const onTV = useCallback(
    (evt: {eventType: string}) => {
      const t = evt.eventType;
      if (!panel) {
        if (t === 'right' && atRightEdge() && !railOpen() && !focusJustMoved(120) && !pressMovedFocus()) openPanel();
        return;
      }
      if (t === 'left') closePanel();
    },
    [panel, openPanel, closePanel],
  );
  useTVKeys(onTV);
  useEffect(() => {
    if (!panel) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closePanel();
      return true;
    });
    return () => sub.remove();
  }, [panel, closePanel]);

  // Where focus goes if it is ever lost on this screen: the first card. The
  // Empty state brings its own.
  useFocusFallback(firstCard);

  // Claim the first card once, when the grid first fills. NOT per filter: the
  // panel hands focus back to the card you left when it closes. See focus.ts.
  // Not while the grid is held for the library: the cells do not exist yet,
  // and a claim spent on them would leave the grid with nothing focused.
  const claims = useListClaim('grid', items.length > 0 && !((localOnly || cat.withLocal) && lib === null));
  const onCardFocus = useCallback((item: HeroItem, index: number) => {
    warmItem(item); // the Detail page's data, if focus holds a moment
    lastFocusIdx.current = index;
    // The rows BELOW. The list keeps about twelve rows rendered under the
    // viewport (GRID_WINDOW) and their cards ask for their own pictures, so
    // there is no mount to see here; what can show is a picture arriving
    // while the list is still filling, in the first second after it opens.
    // While the remote rests, the next rows' pictures are fetched ahead
    // (artPrefetch.ts), so holding DOWN runs onto pictures that are already
    // decoded. Anything already drawn or asked for is skipped there, so the
    // overlap with rendered rows is free.
    artIdle('grid', () => {
      const rows = artLimits().gridRows;
      if (!rows) return [];
      const row = Math.floor(index / cols);
      // (from the edge of what the list keeps rendered below: ~2 rows on screen under focus + GRID_AHEAD)
      const from = row + 2 + GRID_AHEAD;
      return itemsRef.current.slice(from * cols, (from + 2 + rows) * cols).map(i => prefetchable(i));
    });
    // Automatic paging, two rows ahead of the focus. The page APPENDS, so no
    // card already on screen moves; the only visible change is more rows
    // below, which is what "scrolling" is.
    if (index >= itemCountRef.current - cols * PREFETCH_ROWS) loadNextRef.current();
  }, [cols]);
  const renderCard = useCallback(
    ({item, index}: {item: HeroItem; index: number}) => (
      <Card
        item={item}
        index={index}
        ref={index === 0 ? firstCard : undefined}
        onPress={openDetail}
        onFocus={onCardFocus}
        // Column 0 has nothing to its left, so LEFT from it opens the rail; the
        // last column has nothing to its right, so RIGHT opens the filters.
        edgeLeft={index % cols === 0}
        edgeRight={index % cols === cols - 1}
        hasTVPreferredFocus={claims(index)}
      />
    ),
    [openDetail, onCardFocus, cols, claims],
  );

  // The downloaded titles lead this grid and their list is not known yet (or
  // failed): the grid is held — never shown without them — and the count does
  // not claim a number it does not have.
  const needLib = localOnly || !!cat.withLocal;
  const holdForLib = needLib && lib === null;
  // The first catalogue page has not answered yet (or failed).
  const catPending = !localOnly && page < 0;

  // paintCount, transcribed (browse.js:411-423) — but only numbers that are
  // KNOWN: "Loading…" while the library is out, and no "to stream" figure
  // until the catalogue has answered.
  const count = holdForLib
    ? libErr
      ? ''
      : 'Loading…'
    : localOnly
    ? `${items.length} downloaded`
    : catPending
    ? (owned ? `${owned} downloaded · ` : '') + (catErr ? "the rest didn't load" : 'loading the rest…')
    : (owned ? `${owned} downloaded · ` : '') +
      `${items.length - owned} to stream${hasMore ? ' · more available' : ''}`;
  const taste = cat.taste && !genre ? tasteGenres.slice(0, 3) : [];
  const note = taste.length ? `From your ${taste.join(', ')}` : '';

  // Failed rather than empty: what stands in for the grid when a read it
  // needs did not come back.
  const failed = holdForLib ? libErr : items.length === 0 && catErr;
  const retrying = (libErr && libRetrying) || (catErr && catRetrying);
  const skeletons = !failed && (holdForLib || (items.length === 0 && (loading || catPending)));
  // The spinner row under the grid while the next page is on its way. Not a
  // focus target — there is nothing to press. When the first page failed under
  // a grid of downloaded titles, the row carries Retry instead (DOWN from the
  // last row reaches it); a failed NEXT page just says it will try again.
  const footer =
    localOnly || items.length === 0 ? null : loading ? (
      <View style={styles.footer}>
        <MiniSpinner />
      </View>
    ) : catPending && catErr ? (
      <View style={styles.footer}>
        <Btn small label="Retry" onPress={retryAll} />
      </View>
    ) : nextErr && hasMore ? (
      <View style={styles.footer}>
        <Text style={styles.note}>Couldn't load more — trying again</Text>
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.page, screenIn]}>
        {/* One line of chrome: the title, the live count, and — on the right
            — which category is showing, next to the strip that opens it. */}
        <View style={styles.head}>
          <Text style={styles.h1}>{title}</Text>
          <Text style={styles.count} numberOfLines={1}>
            {count}
          </Text>
          <View style={styles.spacer} />
          <Text style={styles.active} numberOfLines={1}>
            {[cat.label, genre, unwatched ? 'Unwatched' : ''].filter(Boolean).join(' · ')}
          </Text>
        </View>

        {failed ? (
          <ErrorState
            message="Couldn't load — the server took too long or the connection dropped"
            detail={retrying ? 'Trying again…' : undefined}
            onAction={retryAll}
          />
        ) : skeletons ? (
          <View style={styles.skelGrid}>
            {Array.from({length: SKELETONS}, (_, i) => (
              <Skeleton key={i} />
            ))}
          </View>
        ) : items.length === 0 ? (
          <Empty
            glyph="🍿"
            message={
              genre
                ? `Nothing in ${genre} here. Try another genre?`
                : 'Nothing matches. Try fewer filters?'
            }
            actionLabel="Change filters"
            onAction={openPanel}
          />
        ) : (
          <FlatList
            ref={listRef}
            data={items}
            // numColumns cannot be changed in place, so the list is re-keyed.
            key={`${kind}-${cols}`}
            style={styles.listFill}
            numColumns={cols}
            // keyOf ALONE. With the index in the key, appending a page would
            // remount every card behind the insertion.
            keyExtractor={keyOf}
            columnWrapperStyle={styles.rowGap}
            contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
            initialNumToRender={GRID_FIRST_ROWS}
            maxToRenderPerBatch={GRID_BATCH_ROWS}
            // Measured on the Streamer (see git history for the numbers): with
            // clipping off the grid degraded to 750ms frames the longer you
            // browsed; on, it stays flat. The clearance is contentContainer
            // padding, so a focused card's ring on the last row is never clipped.
            removeClippedSubviews
            windowSize={GRID_WINDOW}
            renderItem={renderCard}
            ListFooterComponent={footer}
          />
        )}
      </Animated.View>

      {/* The passive edge strip — the panel's "collapsed" state, mirroring the
          rail's: a tune glyph, no focus target, fading out as the panel arrives. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.strip, {opacity: slide.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}>
        <View style={styles.tune}>
          <View style={[styles.tuneBar, {width: 18}]} />
          <View style={[styles.tuneBar, {width: 12}]} />
          <View style={[styles.tuneBar, {width: 6}]} />
        </View>
      </Animated.View>

      {panel ? (
        <Animated.View
          style={[
            styles.panel,
            {transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [PANEL_W, 0]})}]},
          ]}>
          {/* Traps all four directions: the grid behind is unreachable while the
              panel is up; LEFT is handled above as "close". The active category
              claims focus on open — the most useful place to start. */}
          <TVFocusGuideView
            autoFocus
            trapFocusLeft
            trapFocusRight
            trapFocusUp
            trapFocusDown
            style={styles.panelInner}>
            <Text style={styles.kicker}>{title.toUpperCase()}</Text>
            <View style={styles.cats}>
              {CATEGORIES.map(c => (
                <Chip
                  key={c.id}
                  bare
                  label={c.label}
                  on={category === c.id}
                  hasTVPreferredFocus={category === c.id}
                  onPress={() => category !== c.id && pick(() => setCategory(c.id))}
                />
              ))}
            </View>
            <View style={styles.rule} />
            <Picker
              label="Genre"
              value={genre}
              options={[{label: 'All genres', value: ''}, ...genreList.map(g => ({label: g, value: g}))]}
              onPick={g => pick(() => setGenre(g))}
              onOpenChange={setPickerOpen}
            />
            <View style={styles.toolRow}>
              <Chip label="Unwatched" on={unwatched} onPress={() => pick(() => setUnwatched(u => !u))} />
            </View>
            {note ? <Text style={styles.note}>{note}</Text> : null}
            <View style={styles.spacer} />
            <Btn small glyph="🎲" label="Surprise me" onPress={surprise} />
          </TVFocusGuideView>
        </Animated.View>
      ) : null}

      {/* Outside the sliding page: `.nav` is not inside `.screen` on the site,
          and the entry animation is the screen's, not the app's. Gone while a
          panel or the genre picker owns the screen (§5.8). */}
      <NavRail active={kind === 'show' ? 'shows' : 'movies'} disabled={pickerOpen || panel} />
    </View>
  );
}

// Every chrome band carries the same horizontal frame (P1/P2): the rail plus its
// gutter on the left, the edge strip on the right.
const frame = {paddingLeft: spacing.contentLeft, paddingRight: STRIP_W + spacing.sm};

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground is already this colour, and
  // painting it again cost a second full-screen fill on every frame.
  root: {flex: 1},
  page: {flex: 1},
  head: {flexDirection: 'row', alignItems: 'baseline', gap: 16, paddingTop: 27, paddingBottom: 2, ...frame},
  // --fs-title 35.2 x 0.72 = 26 (P8), lh 1.5, -0.02em.
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 39, fontWeight: '900', letterSpacing: -0.52},
  count: {color: colors.textFaint, fontSize: 16, lineHeight: 24, fontWeight: '600', flexShrink: 1},
  spacer: {flex: 1},
  // What the panel currently says, in its own words, so the grid never has to
  // be guessed at while the panel is shut.
  active: {color: colors.textDim, fontSize: 16, lineHeight: 24, fontWeight: '700', flexShrink: 1},
  listFill: {flex: 1},
  // A vertical FlatList spends the clearance as padding and takes NO cancelling
  // margins: a recycled cell cannot be relied on to carry them (§F.4 / G.1).
  grid: {paddingTop: CLEARANCE.above, ...frame},
  // NOT space-between: the gap is pinned at 13 and the residue stays trailing,
  // so the grid stays left-aligned under the content inset.
  rowGap: {gap: GRID_GAP, marginBottom: GRID_GAP},
  skelGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP, paddingTop: CLEARANCE.above, ...frame},
  footer: {alignItems: 'center', paddingVertical: spacing.md},

  // ---- the filter panel ------------------------------------------------
  strip: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: STRIP_W,
    alignItems: 'center',
    paddingTop: 27 + 8,
    zIndex: 100,
  },
  tune: {gap: 4, alignItems: 'flex-end', width: 18},
  tuneBar: {height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.35)'},
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: PANEL_W,
    // Opaque, like the rail: measured on the Streamer, a 3% see-through reads
    // as ghost posters behind the controls.
    backgroundColor: '#0a0b14',
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.09)',
    zIndex: 101,
  },
  // Insets to the 48dp safe edge on the right, the panel's own gutter on the left.
  // Budgeted against a 540dp panel: 18 + kicker 24 + six 48dp chips + rule 9 +
  // picker 48 + chip 48 + Surprise 48 + 27 = 510. The first cut had 27/8/6 here
  // and came to 543 — Surprise me sat clipped below the safe inset.
  panelInner: {flex: 1, paddingLeft: 18, paddingRight: spacing.pageX, paddingTop: 18, paddingBottom: 27},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3, marginBottom: 4},
  cats: {alignItems: 'flex-start'},
  rule: {height: 1, backgroundColor: colors.line, marginVertical: 4},
  toolRow: {flexDirection: 'row', alignItems: 'center'},
  note: {color: colors.textFaint, fontSize: 14, fontWeight: '600', marginTop: 2},
});
