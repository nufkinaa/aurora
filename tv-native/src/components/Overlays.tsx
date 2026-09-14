// The app-wide layer above the navigator: toasts, and the one sheet that may
// be up (overlay.ts says which) — peek, report a problem, join a party, the
// update offer, a trailer. Screens never draw these themselves.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TVFocusGuideView,
  View,
} from 'react-native';
import Focusable from './Focusable';
import Sheet, {glass} from './Sheet';
import TrailerFrame, {TrailerState} from './Trailer';
import {api, HeroItem, imgSrc, ImgSource, StreamRef} from '../api';
import {playingContext, recentErrors} from '../errors';
import {useKeyTrap} from '../focus';
import {closeOverlay, useOverlay} from '../overlay';
import {openItem} from '../openItem';
import {resolvePartyRoute} from '../party';
import {currentRouteName, pushScreen, rootNav} from '../rootNav';
import {dismissUpdate} from '../storage';
import {showToast, useToasts} from '../toast';
import {
  APP_VERSION,
  canInstall,
  cancelDownload,
  downloadUpdate,
  installUpdate,
  openInstallSettings,
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
  const art = imgSrc(item.backdrop || item.cover || item.poster);

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
        await api.toggleWatchlist(profileId, ref, next);
      } else {
        await api.toggleWatchlist(profileId, isEpisode ? item.showId! : item.id, next);
      }
      showToast(next ? 'Added to My List' : 'Removed from My List', '✓');
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
          online: true,
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
        maxLength={6}
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

  // Back from Android's settings: try the install again by itself.
  useEffect(() => {
    if (stage !== 'perm') return;
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') install();
    });
    return () => sub.remove();
  }, [stage, install]);

  const later = () => {
    if (stage === 'downloading') cancelDownload();
    dismissUpdate(info.version);
    closeOverlay();
  };
  const pct = prog.total > 0 ? Math.min(100, Math.round((prog.received / prog.total) * 100)) : null;

  return (
    <Sheet kicker="AURORA TV" title={`Version ${info.version} is ready`} onClose={later}>
      {stage === 'offer' ? (
        <>
          <Text style={styles.body}>{info.notes || 'A new version of the TV app is available.'}</Text>
          <Text style={styles.faint}>{`You have ${APP_VERSION}. The update downloads from your Aurora server and installs right here — about a minute.`}</Text>
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
            Android needs a one-time permission to let Aurora install its own updates. Switch it on in the screen that opens, then press Back to come here.
          </Text>
          <View style={styles.actions}>
            <Primary focus label="Open the permission" onPress={() => openInstallSettings().catch(() => {})} />
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

// ---------------------------------------------------------------- trailer
function TrailerModal({ids, title}: {ids: string[]; title: string}) {
  const [at, setAt] = useState(0);
  const [state, setState] = useState<TrailerState | null>(null);
  useKeyTrap(true);
  useEffect(() => {
    track('feat', {f: 'trailer'});
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeOverlay();
      return true;
    });
    return () => sub.remove();
  }, []);
  const onState = useCallback((s: TrailerState) => {
    setState(s);
    if (s === 'ended') closeOverlay();
  }, []);
  return (
    <View style={styles.trailerRoot}>
      <TrailerFrame key={ids[at]} videoId={ids[at]} muted={false} style={styles.trailerFrame} onState={onState} />
      {state === null || state === 'ready' ? (
        <View style={styles.trailerWait} pointerEvents="none">
          <ActivityIndicator color={colors.white} size="large" />
        </View>
      ) : null}
      {state === 'error' ? (
        <View style={[styles.trailerWait, styles.trailerErr]} pointerEvents="none">
          <Text style={styles.body}>This trailer won't play inside Aurora — YouTube refused the embed.</Text>
          <Text style={styles.faint}>Open in YouTube plays it in the YouTube app instead.</Text>
        </View>
      ) : null}
      <TVFocusGuideView autoFocus trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.trailerHead}>
        <Text style={styles.trailerTitle} numberOfLines={1}>
          {`${title} — trailer`}
        </Text>
        {ids.length > 1
          ? ids.map((id, i) => (
              <Focusable
                key={id}
                round
                light={i === at}
                onPress={() => {
                  setState(null);
                  setAt(i);
                }}
                style={[styles.pill, i === at && styles.pillOn]}>
                <Text style={[styles.pillText, i === at && styles.pillTextOn]}>{`Trailer ${i + 1}`}</Text>
              </Focusable>
            ))
          : null}
        <Focusable
          round
          onPress={() => {
            // The YouTube app on the TV, by intent; the web URL is the fallback.
            Linking.openURL(`vnd.youtube:${ids[at]}`).catch(() =>
              Linking.openURL(`https://www.youtube.com/watch?v=${ids[at]}`).catch(() => {}),
            );
          }}
          style={styles.ghost}>
          <Text style={styles.ghostText}>Open in YouTube</Text>
        </Focusable>
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
      {o?.kind === 'trailer' ? <TrailerModal ids={o.ids} title={o.title} /> : null}
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
  pill: {backgroundColor: 'rgba(255,255,255,0.12)', paddingVertical: 8, paddingHorizontal: 16},
  pillOn: {backgroundColor: colors.white},
  pillText: {color: colors.text, fontSize: fontSize.small, fontWeight: '700'},
  pillTextOn: {color: colors.bg},
});
