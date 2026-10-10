// The app-wide layer above the navigator: toasts, and the one sheet that may
// be up (overlay.ts says which) — peek, report a problem, join a party, the
// update offer, a trailer. Screens never draw these themselves.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Animated, AppState, BackHandler, Easing, FlatList, Image, Linking, Platform, ScrollView, StyleSheet, TVFocusGuideView, Text, TextInput, View} from 'react-native';
import Focusable from './Focusable';
import PersonSheet from './PersonSheet';
import Sheet, {glass} from './Sheet';
import TrailerFrame, {TrailerState} from './Trailer';
import {prepareTrailer, ResolvedTrailer} from '../trailers';
import type {ActionItem} from '../overlay';
import {api, artSrc, HeroItem, imgSrc, ImgSource, listAddedLine, ListDownload, StreamRef, XrayData, XrayPerson, XrayQuery} from '../api';
import {playingContext, recentErrors} from '../errors';
import {useKeyTrap} from '../focus';
import {closeOverlay, useOverlay} from '../overlay';
import {openItem} from '../openItem';
import {resolvePartyRoute} from '../party';
import {currentRouteName, pushScreen, rootNav} from '../rootNav';
import {dismissUpdate} from '../storage';
import {showToast, useToasts} from '../toast';
import {isOpen as socketOpen} from '../realtime';
import {
  APP_VERSION,
  canInstall,
  cancelDownload,
  downloadUpdate,
  installUpdate,
  openInstallSettings,
  restartIntoUpdate,
  canRelaunch,
  openRelaunchSettings,
  UpdateInfo,
} from '../update';
import {track} from '../usage';
import theme from '../theme';

const {colors, fontSize, radius, spacing} = theme;

// ---------------------------------------------------------------- buttons
const Primary = ({label, onPress, focus, busy}: {label: string; onPress: () => void; focus?: boolean; busy?: boolean}) => (
  <Focusable round light ring="violet" hasTVPreferredFocus={focus} onPress={onPress} style={styles.primary}>
    {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>{label}</Text>}
  </Focusable>
);
const Ghost = ({label, onPress, focus}: {label: string; onPress: () => void; focus?: boolean}) => (
  <Focusable round hasTVPreferredFocus={focus} onPress={onPress} style={styles.ghost}>
    <Text style={styles.ghostText}>{label}</Text>
  </Focusable>
);

// ---------------------------------------------------------------- toasts
function Toasts() {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <View style={styles.toasts} pointerEvents="none">
      {list.map(t => (
        <View key={t.id} style={styles.toast}>
          {t.glyph ? <Text style={styles.toastGlyph}>{t.glyph}</Text> : null}
          <Text style={styles.toastText} numberOfLines={2}>
            {t.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- peek
const fmtLeft = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m} min left`;
};
function PeekSheet({item, onRemove}: {item: HeroItem; onRemove?: (item: HeroItem) => void}) {
  const isEpisode = !!item.showId && item.type !== 'show';
  const [synopsis, setSynopsis] = useState(item.synopsis || '');
  const [inList, setInList] = useState<boolean | null>(null);
  const profileId = rootNav().profileId;
  useEffect(() => {
    track('feat', {f: 'peek'});
    let live = true;
    if (!item.synopsis) {
      (async () => {
        try {
          if (item.source === 'stream' && item.imdbId) {
            const m = await api.discoverMeta(item.type === 'show' ? 'series' : 'movie', item.imdbId);
            live && setSynopsis(m.synopsis || '');
          } else {
            const id = isEpisode ? item.showId! : item.id;
            if (id && !String(id).startsWith('torrent|')) {
              const it = await api.item(id, profileId || undefined);
              live && setSynopsis(it.synopsis || '');
            }
          }
        } catch {}
      })();
    }
    if (profileId) {
      api
        .watchlist(profileId)
        .then(w => {
          if (!live) return;
          const key = item.imdbId || item.id;
          setInList((w.items || []).some(x => (x.id && x.id === item.id) || (x.imdbId && x.imdbId === key)));
        })
        .catch(() => live && setInList(false));
    }
    return () => {
      live = false;
    };
  }, [item, isEpisode, profileId]);

  const sub = isEpisode
    ? [item.showTitle, `S${item.season} E${item.episode}`].filter(Boolean).join(' · ')
    : [item.year, item.type === 'show' ? 'Series' : item.type === 'movie' ? 'Film' : null].filter(Boolean).join(' · ');
  const prog = item.progress;
  const pct = prog && prog.duration > 0 && !prog.finished ? Math.round((prog.position / prog.duration) * 100) : null;
  // at the 256dp the peek sheet draws it (styles.peekArt; api.ts artSrc)
  const art = artSrc(item.backdrop || item.cover || item.poster, 256).src;

  const play = () => {
    closeOverlay();
    const nav = rootNav();
    if (item.source !== 'stream' && item.type === 'movie' && item.id && !isEpisode) {
      pushScreen('Player', {id: item.id, title: item.title});
    } else {
      openItem(nav.nav, item);
    }
  };
  const details = () => {
    closeOverlay();
    // An episode's page is its show's.
    if (isEpisode && item.showId) pushScreen('Detail', {item: {id: item.showId, title: item.showTitle || item.title, type: 'show'}});
    else pushScreen('Detail', {item});
  };
  const toggleList = async () => {
    if (!profileId || inList === null) return;
    const next = !inList;
    setInList(next);
    try {
      let res: {download?: ListDownload | null} | null = null;
      if (item.source === 'stream' || !item.id) {
        const ref: StreamRef = {
          imdbId: item.imdbId || item.id,
          type: item.type || 'movie',
          title: item.title,
          poster: item.cover || item.poster,
          year: item.year,
          genres: item.genres,
          rating: item.rating ?? undefined,
        };
        res = await api.toggleWatchlist(profileId, ref, next);
      } else {
        res = await api.toggleWatchlist(profileId, isEpisode ? item.showId! : item.id, next);
      }
      // (an add says what it started downloading, when it started anything)
      showToast(next ? listAddedLine(res) : 'Removed from My List', '✓');
    } catch {
      setInList(!next);
    }
  };

  return (
    <Sheet onClose={closeOverlay} width={720}>
      <View style={styles.peekRow}>
        <View style={styles.peekArt}>
          {art ? <Image source={art as ImgSource} style={styles.peekArtImg} resizeMode="cover" fadeDuration={0} /> : null}
          {pct != null ? (
            <View style={styles.peekBar}>
              <View style={[styles.peekBarFill, {width: `${pct}%`}]} />
            </View>
          ) : null}
        </View>
        <View style={styles.peekText}>
          <Text style={styles.peekTitle} numberOfLines={2}>
            {isEpisode ? item.title : item.title}
          </Text>
          {sub ? <Text style={styles.peekSub}>{sub}</Text> : null}
          {pct != null && prog ? (
            <Text style={styles.peekLeft}>{`${pct}% watched · ${fmtLeft(prog.duration - prog.position)}`}</Text>
          ) : null}
          {synopsis ? (
            <Text style={styles.peekSynopsis} numberOfLines={4}>
              {synopsis}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        <Primary focus label={isEpisode || (item.type === 'movie' && item.source !== 'stream') ? '▶  Play' : '▶  Open'} onPress={play} />
        <Ghost label="Details" onPress={details} />
        {inList !== null ? <Ghost label={inList ? '✓  In My List' : '+  My List'} onPress={toggleList} /> : null}
        {onRemove ? (
          <Ghost
            label="Remove from Continue Watching"
            onPress={() => {
              closeOverlay();
              onRemove(item);
            }}
          />
        ) : null}
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- report
function ReportSheet({hint}: {hint?: string}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr('');
    const playing = playingContext();
    const c = Platform.constants as {Model?: string; Release?: string};
    try {
      await api.report(
        `${text.trim()}${hint ? `\n\n(${hint})` : ''}`,
        {
          route: `tv:${currentRouteName()}`,
          title: playing ? playing.title : null,
          itemId: playing ? playing.id : null,
          look: 'tv',
          ua: `Aurora TV ${APP_VERSION} · Android ${c.Release || ''} · ${c.Model || 'TV'}`,
          viewport: 'tv',
          // (was always `true`: whether the app's socket to the server is up)
          online: socketOpen(),
          version: APP_VERSION,
          errors: recentErrors(),
        },
        rootNav().profileName,
      );
      track('feat', {f: 'report'});
      closeOverlay();
      showToast('Sent — thank you. It landed with the admin.', '🛠️');
    } catch (e) {
      setErr((e as Error).message || "Couldn't send it — try again in a moment");
      setBusy(false);
    }
  };
  return (
    <Sheet kicker="HELP" title="Report a problem" onClose={closeOverlay}>
      <Text style={styles.body}>
        A few words is enough. Where you are, what is playing and the last errors this TV saw come along by themselves.
      </Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        autoFocus
        multiline
        numberOfLines={3}
        placeholder="What went wrong? What did you expect?"
        placeholderTextColor={colors.textFaint}
        onSubmitEditing={send}
        blurOnSubmit
      />
      {err ? <Text style={styles.error}>{err}</Text> : null}
      <View style={[styles.actions, styles.actionsSpread]}>
        <Primary label="Send report" onPress={send} busy={busy} />
        <Ghost label="Cancel" onPress={closeOverlay} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- join a party
function JoinSheet() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const join = async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4 || busy) return;
    setBusy(true);
    setErr('');
    const route = await resolvePartyRoute(c);
    if (!route) {
      setErr('No party with that code. Codes are four letters and expire when the host leaves.');
      setBusy(false);
      return;
    }
    track('feat', {f: 'party_join'});
    closeOverlay();
    pushScreen('Player', {...route, party: c});
  };
  return (
    <Sheet kicker="WATCH TOGETHER" title="Join a watch party" onClose={closeOverlay}>
      <Text style={styles.body}>
        Type the four-letter code from the host's screen. Play, pause and jumps then stay in step for everyone.
      </Text>
      <TextInput
        style={[styles.input, styles.codeInput]}
        value={code}
        onChangeText={t => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={4}
        placeholder="ABCD"
        placeholderTextColor={colors.textFaint}
        onSubmitEditing={join}
      />
      {err ? <Text style={styles.error}>{err}</Text> : null}
      <View style={[styles.actions, styles.actionsSpread]}>
        <Primary label="Join" onPress={join} busy={busy} />
        <Ghost label="Cancel" onPress={closeOverlay} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- update
// The new build is already on the TV (fetched quietly): restart into it now,
// or later — "later" installs it the next time Aurora leaves the screen.
function UpdateReadySheet({info}: {info: UpdateInfo}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Whether Android will let Aurora reopen itself afterwards. Asked again
  // whenever the app comes back to the front (the viewer may have just
  // granted it in Settings).
  const [reopens, setReopens] = useState<boolean | null>(null);
  useEffect(() => {
    let on = true;
    const ask = () => canRelaunch().then(v => on && setReopens(v));
    ask();
    const sub = AppState.addEventListener('change', st => st === 'active' && ask());
    return () => {
      on = false;
      sub.remove();
    };
  }, []);
  const now = useCallback(async () => {
    setBusy(true);
    setErr('');
    try {
      await restartIntoUpdate();
      // the system replaces the app from here; this screen simply goes away
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || "Couldn't start the update");
    }
  }, []);
  const after = reopens
    ? 'Aurora closes for a few seconds and comes back as the new version.'
    : "Aurora closes for a few seconds. Open it again from the TV's home screen and it is the new version.";
  return (
    <Sheet kicker="UPDATE READY" title={`Aurora TV ${info.version}`} accent onClose={closeOverlay}>
      <Text style={styles.body}>
        {busy ? `Installing — ${after}` : `The new version is downloaded. Restart now to use it — ${after} Or carry on, and it installs the next time you leave Aurora.`}
      </Text>
      {err ? <Text style={styles.faint}>{err}</Text> : null}
      <View style={styles.actions}>
        <Primary label="Restart now" onPress={now} focus busy={busy} />
        {busy ? null : <Ghost label="Later" onPress={closeOverlay} />}
        {busy || reopens !== false ? null : (
          <Ghost
            label="Let Aurora reopen itself"
            onPress={async () => {
              if (!(await openRelaunchSettings())) showToast('Allow "Display over other apps" for Aurora under Settings → Apps → Special app access', '⚙️');
            }}
          />
        )}
      </View>
    </Sheet>
  );
}

const fmtMb = (b: number) => `${(b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1)} MB`;
type Stage = 'offer' | 'downloading' | 'perm' | 'installing' | 'error';
function UpdateSheet({info}: {info: UpdateInfo}) {
  const [stage, setStage] = useState<Stage>('offer');
  const [prog, setProg] = useState({received: 0, total: 0});
  const [err, setErr] = useState('');
  const path = useRef<string | null>(null);

  const install = useCallback(async () => {
    if (!path.current) return;
    if (!(await canInstall())) {
      setStage('perm');
      return;
    }
    try {
      setStage('installing');
      await installUpdate(path.current);
    } catch (e) {
      setErr((e as Error).message || 'Could not start the installer');
      setStage('error');
    }
  }, []);

  const start = useCallback(async () => {
    // The permission FIRST, before 40 MB come down: a TV that has not yet
    // allowed Aurora to install apps goes to that screen now and downloads
    // once it is back (the AppState hook below).
    if (!(await canInstall())) {
      setStage('perm');
      return;
    }
    setStage('downloading');
    setProg({received: 0, total: 0});
    track('feat', {f: 'tv_update'});
    try {
      path.current = await downloadUpdate(info.url, p => setProg(p));
      await install();
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/cancelled/i.test(msg)) {
        closeOverlay();
        return;
      }
      setErr(msg || 'The download failed');
      setStage('error');
    }
  }, [info.url, install]);

  // Back from Android's settings: carry on by itself — download if that is
  // still to do, install if the APK is already here. Nothing happens while
  // the permission is still off (the screen stays, with the manual path).
  useEffect(() => {
    if (stage !== 'perm') return;
    const sub = AppState.addEventListener('change', s => {
      if (s !== 'active') return;
      canInstall().then(ok => {
        if (!ok) return;
        if (path.current) install();
        else start();
      });
    });
    return () => sub.remove();
  }, [stage, install, start]);
  const [permErr, setPermErr] = useState('');

  const later = () => {
    if (stage === 'downloading') cancelDownload();
    dismissUpdate(info.version);
    closeOverlay();
  };
  const pct = prog.total > 0 ? Math.min(100, Math.round((prog.received / prog.total) * 100)) : null;

  return (
    <Sheet kicker="UPDATE AVAILABLE" title={`Aurora TV ${info.version} is available`} width={680} accent onClose={later}>
      {stage === 'offer' ? (
        <>
          <Text style={styles.body}>{info.notes || 'A new version of the TV app is available.'}</Text>
          <Text style={styles.faint}>{`This TV runs ${APP_VERSION}. Press Update now — it downloads from your Aurora server and installs right here, about a minute. Later asks again in ten minutes.`}</Text>
          <View style={styles.actions}>
            <Primary focus label="Update now" onPress={start} />
            <Ghost label="Later" onPress={later} />
          </View>
        </>
      ) : null}
      {stage === 'downloading' ? (
        <>
          <Text style={styles.body}>Downloading the update…</Text>
          <View style={styles.progress}>
            <View style={[styles.progressFill, pct == null ? styles.progressBusy : {width: `${pct}%`}]} />
          </View>
          <Text style={styles.faint}>
            {prog.total > 0 ? `${fmtMb(prog.received)} of ${fmtMb(prog.total)} · ${pct}%` : fmtMb(prog.received)}
          </Text>
          <View style={styles.actions}>
            <Ghost focus label="Cancel" onPress={later} />
          </View>
        </>
      ) : null}
      {stage === 'perm' ? (
        <>
          <Text style={styles.body}>
            Android needs a one-time permission to let Aurora install its own updates. Switch it on in the screen that opens, then press Back to come here — the update carries on by itself.
          </Text>
          <Text style={styles.faint}>If the screen does not open: Settings → Apps → Security &amp; restrictions → Unknown sources → Aurora.</Text>
          {permErr ? <Text style={styles.error}>{permErr}</Text> : null}
          <View style={styles.actions}>
            <Primary
              focus
              label="Open the permission"
              onPress={() =>
                openInstallSettings().catch(e => setPermErr(`Couldn't open the settings screen (${(e as Error).message || 'no such screen'}) — use the path above.`))
              }
            />
            <Ghost label="Later" onPress={later} />
          </View>
        </>
      ) : null}
      {stage === 'installing' ? (
        <>
          <Text style={styles.body}>Installing… Android will ask you to confirm, and Aurora reopens on the new version.</Text>
          <View style={styles.actions}>
            <Ghost focus label="Close" onPress={closeOverlay} />
          </View>
        </>
      ) : null}
      {stage === 'error' ? (
        <>
          <Text style={styles.error}>{err}</Text>
          <View style={styles.actions}>
            <Primary focus label="Try again" onPress={start} />
            <Ghost label="Later" onPress={later} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------- x-ray
// Who is in this, who made it, what people thought — the site's panel as a
// TV sheet over the paused film (elia, 2026-10-07). For an episode: its own
// guests first, the regulars under them, the director and writers, the air
// date and runtime. Faces are round; a face that never arrives keeps its
// initials.
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
function Face({p, index, onPress}: {p: XrayPerson; index: number; onPress?: (p: XrayPerson) => void}) {
  const [broken, setBroken] = useState(false);
  return (
    <Focusable
      hasTVPreferredFocus={index === 0}
      onPress={onPress ? () => onPress(p) : undefined}
      style={styles.xrPerson}
      accessibilityLabel={`${p.name}${p.role ? `, ${p.role}` : ''}`}>
      <View style={styles.xrFace}>
        <Text style={styles.xrInitials}>{initials(p.name)}</Text>
        {p.photo && !broken ? (
          <Image
            source={imgSrc(p.photo) as {uri: string}}
            style={styles.xrPhoto}
            resizeMode="cover"
            // up to twenty faces arrive together over a paused film: no
            // cross-fade each (Android's default is 300 ms)
            fadeDuration={0}
            onError={() => setBroken(true)}
          />
        ) : null}
      </View>
      <Text style={styles.xrName} numberOfLines={1}>
        {p.name}
      </Text>
      {p.role ? (
        <Text style={styles.xrRole} numberOfLines={1}>
          {p.role}
        </Text>
      ) : null}
    </Focusable>
  );
}
const fmtAired = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
};
function XraySheet({query, title, onClose}: {query: XrayQuery; title: string; onClose?: () => void}) {
  const [data, setData] = useState<XrayData | null>(null);
  const [failed, setFailed] = useState(false);
  // OK on a person: their own sheet, on top of this one (PersonSheet.tsx).
  // X-Ray stays mounted under it; its BACK listener is older than the person
  // sheet's, so BACK closes that one first.
  const [person, setPerson] = useState<XrayPerson | null>(null);
  const openPerson = useCallback((p: XrayPerson) => setPerson(p), []);
  const closePerson = useCallback(() => setPerson(null), []);
  // Rises from the foot of the screen the way the phone's sheet does, with a
  // little overshoot: a spring on translateY and scale, a short fade under it.
  const rise = useRef(new Animated.Value(0)).current;
  useKeyTrap(true);
  const close = useCallback(() => {
    Animated.timing(rise, {toValue: 0, duration: 160, easing: Easing.in(Easing.quad), useNativeDriver: true}).start(() => {
      closeOverlay();
      onClose?.();
    });
  }, [onClose, rise]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);
  useEffect(() => {
    track('feat', {f: 'xray_tv'});
    Animated.spring(rise, {toValue: 1, stiffness: 190, damping: 20, mass: 0.9, useNativeDriver: true}).start();
    let live = true;
    api
      .xray(query)
      .then(d => live && (d.error ? setFailed(true) : setData(d)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ep = data?.episode || null;
  const guests = ep?.guests || [];
  const cast = data?.cast || [];
  const crew = data?.crew || [];
  const ratings = data?.ratings || [];
  const heading = ep ? `${title} · S${ep.season} E${ep.episode} — ${ep.title}` : data?.title || title;
  const names = (v?: string | string[] | null) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : v || '');
  const facts = ep
    ? [fmtAired(ep.aired) ? `Aired ${fmtAired(ep.aired)}` : null, ep.runtime, ep.rating ? `★ ${ep.rating.value} ${ep.rating.source}` : null]
        .filter(Boolean)
        .join('   ·   ')
    : [
        ...ratings.map(r => `★ ${r.value} ${r.source}`),
        ...(data?.facts || [])
          .filter(f => /^(Released|Runtime|Country|Box office)$/.test(f.label))
          .map(f => (f.label === 'Released' ? fmtAired(f.value) || f.value : f.value)),
      ].join('   ·   ');
  const behind = ep
    ? [names(ep.directors) ? `Directed by ${names(ep.directors)}` : null, names(ep.writers) ? `Written by ${names(ep.writers)}` : null]
        .filter(Boolean)
        .join('   ·   ')
    : crew
        .slice(0, 6)
        .map(c => (c.job || c.role ? `${c.job || c.role}: ${c.name}` : c.name))
        .join('   ·   ');
  const showRegulars = cast.length > 0 && !(data?.anthology && guests.length);
  // The people who made it, as faces that can be pressed like the cast (the
  // site's "Filmmakers"): one per person, their jobs joined; an episode's own
  // director and writers lead. The line in the header stays as it was.
  const makers: XrayPerson[] = [];
  const maker = (name?: string | null, job?: string | null, photo?: string | null, id?: string | null) => {
    if (!name) return;
    let m = makers.find(x => x.name === name);
    if (!m) makers.push((m = {name, role: null, photo: null, id: null}));
    if (job && !(m.role || '').split(' · ').includes(job)) m.role = m.role ? `${m.role} · ${job}` : job;
    if (photo && !m.photo) m.photo = photo;
    if (id && !m.id) m.id = id;
  };
  const listOf = (v?: string | string[] | null) => (Array.isArray(v) ? v : v ? String(v).split(/,\s*/) : []);
  if (ep) {
    for (const n of listOf(ep.directors)) maker(n, 'Director');
    for (const n of listOf(ep.writers)) maker(n, 'Writer');
  }
  for (const c of crew) maker(c.name, c.job || c.role, c.photo, c.id);
  const nobody = !!data && !guests.length && !showRegulars && !makers.length;
  const row = (people: XrayPerson[], first: boolean) => (
    <FlatList
      data={people}
      horizontal
      keyExtractor={(p, i) => `${p.name}-${i}`}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.xrRow}
      renderItem={({item: p, index}) => <Face p={p} index={first ? index : -1} onPress={openPerson} />}
    />
  );
  const panelStyle = {
    opacity: rise.interpolate({inputRange: [0, 0.4, 1], outputRange: [0, 1, 1]}),
    transform: [
      {translateY: rise.interpolate({inputRange: [0, 1], outputRange: [120, 0]})},
      {scale: rise.interpolate({inputRange: [0, 1], outputRange: [0.96, 1]})},
    ],
  };
  const washStyle = {opacity: rise.interpolate({inputRange: [0, 1], outputRange: [0, 1]})};
  return (
    <View style={styles.xrBackdrop}>
      <Animated.View style={[styles.xrWash, washStyle]} />
      <Animated.View style={[styles.xrPanel, panelStyle]}>
        <TVFocusGuideView autoFocus trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.xrGuide}>
          <View style={styles.xrHead}>
            <View style={styles.xrHeadText}>
              <Text style={styles.xrKicker}>X-RAY</Text>
              <Text style={styles.xrTitle} numberOfLines={1}>
                {heading}
              </Text>
              {facts ? (
                <Text style={styles.xrFacts} numberOfLines={1}>
                  {facts}
                </Text>
              ) : null}
              {behind ? (
                <Text style={styles.xrBehind} numberOfLines={1}>
                  {behind}
                </Text>
              ) : null}
            </View>
            {nobody || failed ? (
              <Ghost label="✕  Close" onPress={close} focus />
            ) : (
              <View style={styles.xrHint}>
                <Text style={styles.xrHintKey}>BACK</Text>
                <Text style={styles.xrHintText}>closes</Text>
              </View>
            )}
          </View>
          {!data && !failed ? <ActivityIndicator color={colors.white} style={styles.xrWait} /> : null}
          {failed ? <Text style={styles.body}>X-Ray couldn't reach its sources for this title.</Text> : null}
          {data ? (
            <ScrollView style={styles.xrBody} showsVerticalScrollIndicator={false} fadingEdgeLength={36}>
              {ep?.overview ? (
                <Text style={styles.xrOverview} numberOfLines={2}>
                  {ep.overview}
                </Text>
              ) : null}
              {guests.length ? (
                <>
                  <Text style={styles.xrSection}>{data.anthology ? 'CAST' : 'IN THIS EPISODE'}</Text>
                  {row(guests, true)}
                </>
              ) : null}
              {showRegulars ? (
                <>
                  <Text style={styles.xrSection}>{ep && guests.length ? 'REGULAR CAST' : 'CAST'}</Text>
                  {row(cast.slice(0, 18), !guests.length)}
                </>
              ) : null}
              {makers.length ? (
                <>
                  <Text style={styles.xrSection}>FILMMAKERS</Text>
                  {row(makers.slice(0, 12), !guests.length && !showRegulars)}
                </>
              ) : null}
              {nobody ? <Text style={styles.faint}>Nothing known about this one yet.</Text> : null}
            </ScrollView>
          ) : null}
        </TVFocusGuideView>
      </Animated.View>
      {person ? (
        <PersonSheet
          who={person}
          of={data?.imdbId || query.imdbId || null}
          type={data?.type || query.type || null}
          onClose={closePerson}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- actions
// A short list of things to do with one thing (an episode, from its card's
// long-press): Mark watched, Sources, Play. A press closes the sheet first.
function ActionsSheet({title, sub, items}: {title: string; sub?: string; items: ActionItem[]}) {
  useKeyTrap(true);
  useEffect(() => {
    const s = BackHandler.addEventListener('hardwareBackPress', () => {
      closeOverlay();
      return true;
    });
    return () => s.remove();
  }, []);
  return (
    <Sheet kicker={sub} title={title} width={520} onClose={closeOverlay}>
      <View style={styles.actionList}>
        {items.map((it, i) => (
          <Focusable
            key={it.label}
            hasTVPreferredFocus={i === 0}
            onPress={() => {
              closeOverlay();
              it.onPress();
            }}
            style={styles.actionRow}>
            <Text style={[styles.actionLabel, it.danger && styles.actionDanger]}>{it.label}</Text>
            {it.tag ? <Text style={styles.actionTag}>{it.tag}</Text> : null}
          </Focusable>
        ))}
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- trailer
// The trailer plays HERE, in ExoPlayer: Apple's when the title has one, else a
// YouTube trailer resolved on this TV (trailers.ts), else nothing — the sheet
// says so. No embedded web player (elia, 2026-10-09). "Open in YouTube" stays
// as a choice whenever a YouTube key is known.
function TrailerModal({
  ids,
  title,
  imdbId,
  type,
  year,
}: {
  ids: string[];
  title: string;
  imdbId?: string | null;
  type: 'movie' | 'show';
  year?: number | null;
}) {
  const [trailer, setTrailer] = useState<ResolvedTrailer | null>(null);
  const [phase, setPhase] = useState<'resolving' | 'loading' | 'playing' | 'none'>('resolving');
  // a trailer that fails in the player sends the sheet back for the next
  // source (Apple → YouTube → the next YouTube key), twice at most
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  useKeyTrap(true);
  useEffect(() => {
    track('feat', {f: 'trailer'});
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeOverlay();
      return true;
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    let live = true;
    setPhase('resolving');
    setTrailer(null);
    prepareTrailer({imdbId, type, title, year, youtubeIds: ids}) // ready already when the page pre-resolved it
      .then(r => {
        if (!live) return;
        setTrailer(r);
        setPhase(r ? 'loading' : 'none');
      })
      .catch(() => live && setPhase('none'));
    return () => {
      live = false;
    };
  }, [ids, imdbId, type, title, year, attempt]);
  const onState = useCallback((s: TrailerState) => {
    if (s === 'playing') setPhase('playing');
    else if (s === 'ended') closeOverlay();
    else if (s === 'error') {
      setTrailer(null);
      if (attemptRef.current >= 2) setPhase('none');
      else setAttempt(++attemptRef.current);
    }
  }, []);
  const ytId = trailer?.ytId || ids[0] || null;
  return (
    <View style={styles.trailerRoot}>
      {trailer ? (
        <TrailerFrame key={trailer.uri} trailer={trailer} muted={false} style={styles.trailerFrame} onState={onState} />
      ) : null}
      {phase === 'resolving' || phase === 'loading' ? (
        <View style={styles.trailerWait} pointerEvents="none">
          <ActivityIndicator color={colors.white} size="large" />
        </View>
      ) : null}
      {phase === 'none' ? (
        <View style={[styles.trailerWait, styles.trailerErr]} pointerEvents="none">
          <Text style={styles.body}>No trailer available for this title</Text>
        </View>
      ) : null}
      <TVFocusGuideView autoFocus trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.trailerHead}>
        <Text style={styles.trailerTitle} numberOfLines={1}>
          {`${title} — trailer`}
        </Text>
        {ytId ? (
          <Focusable
            round
            onPress={() => {
              // The YouTube app on the TV, by intent; the web URL is the fallback.
              Linking.openURL(`vnd.youtube:${ytId}`).catch(() =>
                Linking.openURL(`https://www.youtube.com/watch?v=${ytId}`).catch(() => {}),
              );
            }}
            style={styles.ghost}>
            <Text style={styles.ghostText}>Open in YouTube</Text>
          </Focusable>
        ) : null}
        <Focusable round hasTVPreferredFocus onPress={closeOverlay} style={styles.ghost}>
          <Text style={styles.ghostText}>✕  Close</Text>
        </Focusable>
      </TVFocusGuideView>
    </View>
  );
}

// ---------------------------------------------------------------- host
export default function Overlays() {
  const o = useOverlay();
  return (
    <>
      {o?.kind === 'peek' ? <PeekSheet item={o.item} onRemove={o.onRemove} /> : null}
      {o?.kind === 'report' ? <ReportSheet hint={o.hint} /> : null}
      {o?.kind === 'join' ? <JoinSheet /> : null}
      {o?.kind === 'update' ? <UpdateSheet info={o.info} /> : null}
      {o?.kind === 'updateReady' ? <UpdateReadySheet info={o.info} /> : null}
      {o?.kind === 'trailer' ? <TrailerModal ids={o.ids} title={o.title} imdbId={o.imdbId} type={o.type} year={o.year} /> : null}
      {o?.kind === 'actions' ? <ActionsSheet title={o.title} sub={o.sub} items={o.items} /> : null}
      {o?.kind === 'xray' ? <XraySheet query={o.query} title={o.title} onClose={o.onClose} /> : null}
      <Toasts />
    </>
  );
}

const styles = StyleSheet.create({
  primary: {backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 26, minWidth: 130, alignItems: 'center'},
  primaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  ghost: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  ghostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg},
  // Primary on the left under the field's centre, Cancel pushed to the far
  // right — so DOWN from a text field lands on the primary, not on Cancel.
  actionsSpread: {justifyContent: 'space-between'},
  trailerErr: {backgroundColor: '#000', paddingHorizontal: 80},
  // X-Ray: a bottom sheet over the page, the phone's shape at TV size.
  xrBackdrop: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 500, elevation: 500, justifyContent: 'flex-end'},
  xrWash: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(4,5,10,0.6)'},
  xrPanel: {
    marginHorizontal: spacing.pageX - 12,
    maxHeight: 446,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 18,
    paddingHorizontal: 28,
    paddingBottom: 22,
    // opaque: a bright subtitle line under a 96% panel still read through it
    backgroundColor: 'rgb(14,16,28)',
    // the player menus' hue (elia, 2026-10-07): the site's violet from the
    // top-left, the aurora's green from the foot
    experimental_backgroundImage:
      'linear-gradient(140deg, rgba(104,86,226,0.28) 0%, rgba(14,16,28,0) 48%, rgba(70,200,150,0.18) 100%)',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.10)',
    borderTopColor: 'rgba(255,255,255,0.22)',
    boxShadow: '0 -24px 70px rgba(0,0,0,0.6)',
  },
  xrGuide: {flexShrink: 1},
  xrHead: {flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg},
  xrHeadText: {flex: 1, minWidth: 0},
  xrKicker: {color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 3, marginBottom: 2},
  xrTitle: {color: colors.text, fontSize: 24, lineHeight: 30, fontWeight: '900'},
  xrFacts: {color: colors.textDim, fontSize: fontSize.small, marginTop: 4},
  xrHint: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6},
  xrHintKey: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  xrHintText: {color: colors.textFaint, fontSize: fontSize.small},
  xrWait: {marginVertical: 48},
  xrBody: {marginTop: 8, maxHeight: 300},
  xrOverview: {color: colors.text, fontSize: fontSize.small, lineHeight: 20},
  xrSection: {color: colors.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: spacing.sm + 2, marginBottom: 2},
  xrRow: {gap: 6, paddingVertical: 4, paddingHorizontal: 2},
  xrPerson: {width: 114, alignItems: 'center', borderRadius: radius.m, paddingVertical: 6, paddingHorizontal: 5},
  xrFace: {width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  xrPhoto: {position: 'absolute', top: 0, left: 0, width: 58, height: 58},
  xrInitials: {color: colors.textDim, fontSize: 17, fontWeight: '800'},
  xrName: {color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 5, maxWidth: 104, textAlign: 'center'},
  xrRole: {color: colors.textFaint, fontSize: 11, marginTop: 1, maxWidth: 104, textAlign: 'center'},
  xrBehind: {color: colors.textDim, fontSize: fontSize.small, marginTop: 2},
  actionList: {gap: spacing.sm, marginTop: spacing.sm},
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.m,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  actionLabel: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  actionTag: {color: colors.textDim, fontSize: fontSize.small, marginLeft: spacing.md},
  actionDanger: {color: '#ff8080'},
  body: {color: colors.text, fontSize: fontSize.body, lineHeight: 24},
  faint: {color: colors.textDim, fontSize: fontSize.small, marginTop: spacing.sm},
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.sm},
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.body,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: spacing.md,
    minHeight: 84,
    textAlignVertical: 'top',
  },
  codeInput: {minHeight: 0, fontSize: 34, fontWeight: '900', letterSpacing: 12, textAlign: 'center', maxWidth: 260},
  progress: {height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden', marginTop: spacing.md},
  progressFill: {height: '100%', borderRadius: 4, backgroundColor: colors.accent},
  progressBusy: {width: '30%', opacity: 0.6},

  // toasts — the glass pill, bottom centre, above everything
  toasts: {position: 'absolute', left: 0, right: 0, bottom: 28, alignItems: 'center', gap: 8, zIndex: 600, elevation: 600},
  toast: {
    ...glass,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
    maxWidth: '70%',
  },
  toastGlyph: {fontSize: 16},
  toastText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},

  // peek
  peekRow: {flexDirection: 'row', gap: spacing.lg},
  peekArt: {width: 256, height: 144, borderRadius: radius.m, backgroundColor: colors.bgRaised, overflow: 'hidden'},
  peekArtImg: {width: '100%', height: '100%'},
  peekBar: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(255,255,255,0.2)'},
  peekBarFill: {height: '100%', backgroundColor: colors.progress},
  peekText: {flex: 1, minWidth: 0},
  peekTitle: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', letterSpacing: -0.5},
  peekSub: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700', marginTop: 4},
  peekLeft: {color: colors.accent, fontSize: fontSize.small, fontWeight: '700', marginTop: 4},
  peekSynopsis: {color: colors.textDim, fontSize: fontSize.body, lineHeight: 23, marginTop: spacing.sm},

  // trailer, full screen
  trailerRoot: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 500, elevation: 500, backgroundColor: '#000'},
  trailerFrame: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  trailerWait: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center'},
  trailerHead: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.pageX,
    paddingTop: 22,
    paddingBottom: 30,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  trailerTitle: {flex: 1, color: colors.text, fontSize: fontSize.row, fontWeight: '800'},
});
