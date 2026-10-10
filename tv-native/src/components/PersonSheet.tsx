// A person, on top of X-Ray: press OK on an actor or a director in the X-Ray
// sheet and this second sheet rises over it — their portraits, then shelves
// of what they made (the server's /api/person: src/media/person.js). X-Ray
// stays where it is underneath and the film is not touched.
//
//   OK on a title    puts it on My List (the toast says so — and says when
//                    that started a download); the card wears a ✓
//   OK again         takes it off (and the server lets go of the download)
//   BACK             closes this sheet; focus returns to the person pressed
//
// Rendered BY XraySheet (Overlays.tsx), not through overlay.ts — that store
// holds one sheet at a time, and this is the one case of a sheet over a sheet.
//
// Remote rules kept here: no key handler of its own (useTVEventHandler hears a
// press on its RELEASE, after Android has already moved focus on the key-down
// — see docs/qa/native-lab/6-followup…); the only inputs are OK through each
// card's onPress and BACK through BackHandler, which answers the newest
// listener first, so X-Ray's own BACK does not fire while this is up. Focus is
// held by a TVFocusGuideView trap, and useKeyTrap hands it back to whoever had
// it when the sheet opened.
//
// Light on weak boxes: one Animated spring on the native driver (X-Ray's own),
// no blur, no shadow, pictures asked for at the size they are drawn (artSrc →
// the server's width variants, with the session headers), shelves that are
// FlatLists with a small window, and at most MAX_TITLES cards in all.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, BackHandler, Easing, FlatList, Image, ScrollView, StyleSheet, TVFocusGuideView, Text, View} from 'react-native';
import Card, {COMPACT_W} from './Card';
import Focusable from './Focusable';
import {api, artSrc, HeroItem, listAddedLine, PersonCredit, PersonData, StreamRef, XrayPerson} from '../api';
import {useKeyTrap} from '../focus';
import {rootNav} from '../rootNav';
import {showToast} from '../toast';
import {track} from '../usage';
import theme from '../theme';

const {colors, fontSize, radius, spacing} = theme;

const MAX_TITLES = 30;
const MAX_PER_SHELF = 18;
const MAX_PHOTOS = 5;
const PHOTO_W = 62;
const PHOTO_H = 93;
const GAP = 12;

const SHELF: Record<string, string> = {
  acting: 'APPEARS IN',
  directing: 'DIRECTED',
  creating: 'CREATED',
  writing: 'WROTE',
  producing: 'PRODUCED',
  music: 'SCORED',
  camera: 'SHOT',
  editing: 'EDITED',
};
const KNOWN: Record<string, string> = {Acting: 'Actor', Directing: 'Director', Writing: 'Writer', Production: 'Producer', Sound: 'Composer', Camera: 'Cinematographer', Editing: 'Editor', Creator: 'Creator'};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
const year = (iso?: string | null) => (iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null);

function Portrait({uri, w, h, round}: {uri: string; w: number; h: number; round?: boolean}) {
  const [broken, setBroken] = useState(false);
  const {src, sized} = artSrc(uri, w);
  if (!src || broken) return round ? null : <View style={{width: w, height: h}} />;
  return (
    <Image
      source={src as {uri: string}}
      style={round ? styles.faceImg : {width: w, height: h, borderRadius: radius.m, backgroundColor: 'rgba(255,255,255,0.06)'}}
      resizeMode="cover"
      resizeMethod={sized ? 'auto' : 'resize'}
      fadeDuration={0}
      onError={() => setBroken(true)}
    />
  );
}

// One title: the app's own poster card, what it is under it, and its state on
// top (✓ on the list; IN LIBRARY / WATCHED / DOWNLOADING). Memoized — a
// press repaints the one card it was made on.
const TitleCard = React.memo(function TitleCard({
  credit,
  listed,
  downloading,
  focus,
  onPress,
}: {
  credit: PersonCredit;
  listed: boolean;
  downloading: boolean;
  focus: boolean;
  onPress: (item: HeroItem) => void;
}) {
  const item = useMemo<HeroItem>(
    () => ({id: credit.key, imdbId: credit.imdbId, type: credit.type, title: credit.title, year: credit.year ?? undefined, poster: credit.poster}),
    [credit],
  );
  const flag = downloading ? 'DOWNLOADING' : credit.watched ? 'WATCHED' : credit.inLibrary ? 'IN LIBRARY' : null;
  return (
    <View style={styles.title} accessibilityLabel={`${credit.title}${listed ? ', on My List' : ''}`}>
      <Card item={item} compact hideLabel noPeek onPress={onPress} hasTVPreferredFocus={focus} />
      {listed ? (
        <View style={styles.check} pointerEvents="none">
          <Text style={styles.checkGlyph}>✓</Text>
        </View>
      ) : null}
      {flag ? (
        <View style={styles.flag} pointerEvents="none">
          <Text style={styles.flagText} numberOfLines={1}>
            {flag}
          </Text>
        </View>
      ) : null}
      <Text style={styles.titleName} numberOfLines={1}>
        {credit.title}
      </Text>
      <Text style={styles.titleSub} numberOfLines={1}>
        {[credit.year, credit.role].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );
});

export default function PersonSheet({
  who,
  of,
  type,
  onClose,
}: {
  who: XrayPerson;
  // the title X-Ray is about: it tells two people of one name apart
  of?: string | null;
  type?: 'movie' | 'series' | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<PersonData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // key -> on the list / a download was started for it. Seeded from the
  // server's marks, then owned here.
  const [listed, setListed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const listedRef = useRef(listed);
  listedRef.current = listed;
  const creditsRef = useRef<Record<string, PersonCredit>>({});
  const busy = useRef(new Set<string>());
  const profileId = rootNav().profileId;
  const rise = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  useKeyTrap(true);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Animated.timing(rise, {toValue: 0, duration: 160, easing: Easing.in(Easing.quad), useNativeDriver: true}).start(() => onClose());
  }, [onClose, rise]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true; // this sheet only: X-Ray's listener (older) is not asked
    });
    return () => sub.remove();
  }, [close]);

  useEffect(() => {
    track('feat', {f: 'person_tv'});
    Animated.spring(rise, {toValue: 1, stiffness: 190, damping: 20, mass: 0.9, useNativeDriver: true}).start();
    let live = true;
    let again: ReturnType<typeof setTimeout> | null = null;
    const id = who.id || `name:${who.name}`;
    const take = (d: PersonData) => {
      if (!live) return;
      if (d.error) return setFailed(d.error);
      const marks: Record<string, boolean> = {};
      for (const c of d.credits || []) {
        creditsRef.current[c.key] = c;
        marks[c.key] = !!c.inList;
      }
      // what was pressed while the second answer was on its way stays as pressed
      setListed(prev => ({...marks, ...prev}));
      setData(d);
    };
    const ask = (retry: boolean) =>
      api
        .person(id, {of, type, profile: profileId})
        .then(d => {
          take(d);
          // some titles were still being looked up: one more ask, a moment later
          if (live && d.partial && retry) again = setTimeout(() => ask(false), 2600);
        })
        .catch(e => live && retry && setFailed((e as Error)?.message || "Couldn't load this right now."));
    ask(true);
    return () => {
      live = false;
      if (again) clearTimeout(again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable, so the memoized cards are not repainted by a press on another one.
  const toggle = useCallback(
    async (item: HeroItem) => {
      const c = creditsRef.current[item.id];
      if (!c || !profileId || busy.current.has(c.key)) return;
      busy.current.add(c.key);
      const next = !listedRef.current[c.key];
      setListed(prev => ({...prev, [c.key]: next}));
      if (!next) setLoading(prev => ({...prev, [c.key]: false}));
      try {
        const ref: StreamRef = {imdbId: c.imdbId, type: c.type, title: c.title, poster: c.poster, year: c.year, genres: c.genres, rating: c.rating ?? undefined};
        const res = await api.toggleWatchlist(profileId, ref, next);
        if (next && res?.download?.queued) setLoading(prev => ({...prev, [c.key]: true}));
        // (an add says what it started downloading, when it started anything)
        showToast(next ? `${c.title}: ${listAddedLine(res)}` : `${c.title}: removed from My List`, next ? '✓' : '−');
        track('feat', {f: next ? 'person_add_tv' : 'person_remove_tv'});
      } catch {
        setListed(prev => ({...prev, [c.key]: !next}));
        showToast("Couldn't change My List", '⚠');
      } finally {
        busy.current.delete(c.key);
      }
    },
    [profileId],
  );

  // Shelves: the credits arrive grouped by department, the person's own first.
  const shelves = useMemo(() => {
    const out: {dept: string; items: PersonCredit[]}[] = [];
    let total = 0;
    for (const c of data?.credits || []) {
      if (total >= MAX_TITLES) break;
      let s = out[out.length - 1];
      if (!s || s.dept !== c.dept) out.push((s = {dept: c.dept, items: []}));
      if (s.items.length >= MAX_PER_SHELF) continue;
      s.items.push(c);
      total++;
    }
    return out;
  }, [data]);

  const life = data?.born ? (data.died ? `${year(data.born)}–${year(data.died)}` : `born ${year(data.born)}`) : null;
  const sub = [who.role || who.job || (data?.knownFor ? KNOWN[data.knownFor] : null), life].filter(Boolean).join('   ·   ');
  const photos = (data?.photos || []).slice(0, MAX_PHOTOS);
  const facePhoto = data?.photos?.[0]?.url || who.photo || null;
  const nothing = !!data && !shelves.length;

  const panelStyle = {
    opacity: rise.interpolate({inputRange: [0, 0.4, 1], outputRange: [0, 1, 1]}),
    transform: [
      {translateY: rise.interpolate({inputRange: [0, 1], outputRange: [120, 0]})},
      {scale: rise.interpolate({inputRange: [0, 1], outputRange: [0.96, 1]})},
    ],
  };
  const washStyle = {opacity: rise.interpolate({inputRange: [0, 1], outputRange: [0, 1]})};
  return (
    <View style={styles.backdrop}>
      <Animated.View style={[styles.wash, washStyle]} />
      <Animated.View style={[styles.panel, panelStyle]}>
        <TVFocusGuideView autoFocus trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.guide}>
          <View style={styles.head}>
            <View style={styles.face}>
              <Text style={styles.initials}>{initials(who.name)}</Text>
              {facePhoto ? <Portrait uri={facePhoto} w={58} h={58} round /> : null}
            </View>
            <View style={styles.headText}>
              <Text style={styles.name} numberOfLines={1}>
                {data?.name || who.name}
              </Text>
              {sub ? (
                <Text style={styles.sub} numberOfLines={1}>
                  {sub}
                </Text>
              ) : null}
              <Text style={styles.how} numberOfLines={1}>
                {shelves.length && profileId ? 'OK adds a title to My List  ·  OK again takes it off  ·  BACK closes' : 'BACK closes'}
              </Text>
            </View>
            {photos.length ? (
              <View style={styles.photos}>
                {photos.map(p => (
                  <Portrait key={p.url} uri={p.url} w={PHOTO_W} h={PHOTO_H} />
                ))}
              </View>
            ) : null}
          </View>
          {!data || failed || nothing ? (
            // No title to stand on (still loading, nothing came, nothing fits):
            // the sheet holds focus on its own Close, so the remote is never
            // moving X-Ray's faces underneath. When the titles arrive the
            // first card claims focus (hasTVPreferredFocus) and this goes.
            <View style={styles.empty}>
              {!data && !failed ? (
                <ActivityIndicator color={colors.white} style={styles.wait} />
              ) : (
                <Text style={styles.body}>{failed ? failed : data?.kids ? 'Nothing of theirs fits this profile.' : 'No titles are known for them yet.'}</Text>
              )}
              <Focusable round hasTVPreferredFocus onPress={close} style={styles.ghost}>
                <Text style={styles.ghostText}>✕  Close</Text>
              </Focusable>
            </View>
          ) : null}
          {shelves.length ? (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} fadingEdgeLength={36}>
              {shelves.map((s, si) => (
                <View key={s.dept}>
                  <Text style={styles.section}>{`${SHELF[s.dept] || 'TITLES'}   ${s.items.length}`}</Text>
                  <FlatList
                    data={s.items}
                    horizontal
                    keyExtractor={c => c.key}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.row}
                    initialNumToRender={8}
                    maxToRenderPerBatch={6}
                    windowSize={5}
                    getItemLayout={(_, index) => ({length: COMPACT_W + GAP, offset: (COMPACT_W + GAP) * index, index})}
                    renderItem={({item: c, index}) => (
                      <TitleCard credit={c} listed={!!listed[c.key]} downloading={!!loading[c.key]} focus={si === 0 && index === 0} onPress={toggle} />
                    )}
                  />
                </View>
              ))}
            </ScrollView>
          ) : null}
        </TVFocusGuideView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // over X-Ray's own backdrop (zIndex 500) and under the toasts (600)
  backdrop: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 520, elevation: 520, justifyContent: 'flex-end'},
  wash: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(4,5,10,0.55)'},
  // X-Ray's panel, a size up and opaque — no shadow of its own (the wash is
  // what separates it from the sheet beneath)
  panel: {
    marginHorizontal: spacing.pageX - 24,
    maxHeight: 500,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 18,
    paddingHorizontal: 28,
    paddingBottom: 18,
    backgroundColor: 'rgb(16,18,32)',
    experimental_backgroundImage:
      'linear-gradient(140deg, rgba(104,86,226,0.30) 0%, rgba(14,16,28,0) 48%, rgba(70,200,150,0.18) 100%)',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.12)',
    borderTopColor: 'rgba(255,255,255,0.26)',
  },
  guide: {flexShrink: 1},
  head: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  face: {width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  faceImg: {position: 'absolute', top: 0, left: 0, width: 58, height: 58},
  initials: {color: colors.textDim, fontSize: 17, fontWeight: '800'},
  headText: {flex: 1, minWidth: 0},
  name: {color: colors.text, fontSize: 24, lineHeight: 30, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: fontSize.small, marginTop: 2},
  how: {color: colors.textFaint, fontSize: fontSize.small, marginTop: 4},
  photos: {flexDirection: 'row', gap: 6},
  wait: {marginVertical: 28, alignSelf: 'center'},
  empty: {marginTop: spacing.lg, gap: spacing.md, alignItems: 'flex-start', minHeight: 150},
  body: {color: colors.text, fontSize: fontSize.body, lineHeight: 24},
  ghost: {backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingVertical: 12, paddingHorizontal: 20, alignItems: 'center'},
  ghostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  scroll: {marginTop: 6, maxHeight: 352},
  section: {color: colors.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: spacing.sm + 2, marginBottom: 2},
  // room for a focused card's lift and ring inside the list
  row: {gap: GAP, paddingVertical: 8, paddingHorizontal: 6},
  title: {width: COMPACT_W},
  titleName: {color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 6},
  titleSub: {color: colors.textDim, fontSize: 11, marginTop: 1},
  check: {position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: '#35c47a', alignItems: 'center', justifyContent: 'center'},
  checkGlyph: {color: '#04130b', fontSize: 14, fontWeight: '900', lineHeight: 18},
  flag: {position: 'absolute', left: 6, top: 146, maxWidth: COMPACT_W - 12, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(8,9,16,0.85)'},
  flagText: {color: colors.text, fontSize: 9, fontWeight: '800', letterSpacing: 0.6},
});
