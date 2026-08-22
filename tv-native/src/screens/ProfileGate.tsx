// Profile picker. Lists the server's profiles as avatar tiles; an open profile
// is chosen with one press, a protected one prompts for its password. On
// success we persist the profile id + unlock token and hand control up.
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import Focusable from '../components/Focusable';
import {api, ApiError, Profile} from '../api';
import {loadRecentProfiles, pushRecentProfile} from '../storage';
import theme, {useTvMetrics} from '../theme';

const {colors, radius, fontSize, spacing} = theme;

// A household can run 50+ profiles and a remote steps one tile at a time, so the
// picker is a GRID ordered with this TV's own profiles first — reaching any tile
// is a few D-pad presses instead of forty. (The web app solves the same problem
// with recents + a search box; a search box on a 10-foot UI means summoning the
// on-screen keyboard, so on TV the grid does that job without one.)
const TILE_W = 168;
const AVATAR = 104;

// No "change server" here: resolveServer() already walks the known candidates in
// parallel on boot and picks whichever answers, so a manual entry screen was a
// dead end that only ever got in the way.
export default function ProfileGate({
  onChosen,
}: {
  onChosen: (profileId: string, token: string | null) => void;
}) {
  const {width, safeBottom} = useTvMetrics();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [pwFor, setPwFor] = useState<Profile | null>(null);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped by the failure state's Retry.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    // Deliberately NOT clearing loadError here: doing so unmounts the Retry
    // button for the whole in-flight window, and with nothing else focusable
    // during a retry that is a dead remote on the one screen with no way back.
    // The error (and its button) clear on success instead.
    Promise.all([api.profiles(), loadRecentProfiles()])
      .then(([list, rec]) => {
        if (!live) return;
        setProfiles(list);
        setRecent(rec);
        setLoadError('');
      })
      .catch(() => live && setLoadError('Could not load profiles from the server.'));
    return () => {
      live = false;
    };
  }, [attempt]);

  // This TV's own profiles first (most recent first), everything else by name.
  const ordered = useMemo(() => {
    const list = profiles || [];
    const rank = new Map(recent.map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id)! : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id)! : Infinity;
      if (ra !== rb) return ra - rb;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [profiles, recent]);

  const cols = Math.max(
    3,
    Math.floor((width - 2 * spacing.pageX + spacing.lg) / (TILE_W + spacing.lg)),
  );

  const choose = async (p: Profile, pw = '') => {
    // A second OK while the unlock is in flight would double-POST and call
    // onChosen twice.
    if (busy) return;
    setBusy(true);
    setPwError('');
    try {
      const res = await api.unlock(p.id, pw);
      if (res.token) {
        // Remember it for this TV before handing control up, so the next visit
        // to the gate lands straight on the profile actually used here.
        await pushRecentProfile(p.id);
        onChosen(p.id, res.token);
      } else {
        setPwError(res.error === 'wrong password' ? 'Wrong password' : 'Could not unlock');
      }
    } catch (e) {
      // The server returns 401 for a wrong password and 403 for an admin-locked
      // profile — distinguish those from an actual network failure.
      if (e instanceof ApiError && e.status === 401) setPwError('Wrong password');
      else if (e instanceof ApiError && e.status === 403) {
        setPwError('This profile has been locked by an admin');
      } else setPwError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const onTile = (p: Profile) => {
    if (p.locked) {
      setLoadError(`"${p.name}" has been locked by an admin.`);
      return;
    }
    setLoadError('');
    if (p.hasPassword) {
      setPwFor(p);
      setPassword('');
      setPwError('');
    } else {
      choose(p);
    }
  };

  // Not memoized on purpose: onTile closes over `choose`, which closes over the
  // `onChosen` prop, and a useCallback([]) here would freeze the first one —
  // a stale onChosen means picking a profile silently does nothing. This list is
  // a handful of static tiles, so there is nothing to gain by caching it.
  const renderTile = ({item: p, index}: {item: Profile; index: number}) => (
    <Focusable
      // .profile-tile:hover, :focus -> transform: scale(1.07)
      scaleTo={1.07}
      // index 0 is the profile this TV used last, so the remote starts there.
      hasTVPreferredFocus={index === 0}
      onPress={() => onTile(p)}
      style={[styles.tile, p.locked && styles.tileLocked]}
      highlightColor={colors.surface}>
      <View style={[styles.avatar, {backgroundColor: p.color || colors.surfaceHover}]}>
        <Text style={styles.avatarGlyph}>{p.avatar || '🍿'}</Text>
      </View>
      <Text style={styles.tileName} numberOfLines={1}>
        {p.name}
        {p.locked ? '  🚫' : p.hasPassword ? '  🔒' : ''}
      </Text>
    </Focusable>
  );

  // Password entry sub-view for a protected profile.
  if (pwFor) {
    return (
      <View style={styles.root}>
        <Text style={styles.heading}>Enter password</Text>
        <Text style={styles.sub}>{pwFor.name}</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoFocus
          placeholder="Password"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={() => choose(pwFor, password)}
        />
        <View style={styles.row}>
          {/* No hasTVPreferredFocus here: it fought the field's autoFocus and
              won, so the gate opened with Unlock highlighted and an empty
              password — press OK and you get "Wrong password" without ever
              having typed. The field is first in the tree, so it takes focus and
              the on-screen keyboard comes up straight away. */}
          <Focusable
            round
            onPress={() => choose(pwFor, password)}
            style={styles.btnPrimary}>
            {busy ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.btnPrimaryText}>Unlock</Text>
            )}
          </Focusable>
          <Focusable round onPress={() => setPwFor(null)} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>Back</Text>
          </Focusable>
        </View>
        {pwError ? <Text style={styles.error}>{pwError}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.rootTop}>
      {/* A FlatList grid, not a wrapped ScrollView: react-native-tvos scrolls a
          focused FlatList cell into view, which a plain ScrollView does not do
          reliably on Android TV — with many profiles the lower rows would be
          unreachable. Same reason Browse uses one. */}
      <FlatList
        key={`cols-${cols}`}
        data={ordered}
        numColumns={cols}
        keyExtractor={p => p.id}
        style={{paddingBottom: safeBottom}}
        contentContainerStyle={styles.gridContent}
        columnWrapperStyle={cols > 1 ? styles.gridRow : undefined}
        initialNumToRender={cols * 3}
        windowSize={5}
        ListHeaderComponent={
          <View>
            <Text style={styles.heading}>Who's watching?</Text>
            {profiles === null && !loadError ? (
              <ActivityIndicator color={colors.text} style={{marginTop: spacing.lg}} />
            ) : null}
            {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
            {/* A load failure used to leave this screen with NOTHING focusable —
                and with nothing focused, no key events reach JS at all, so the
                remote was completely dead and the only way out was force-quitting
                the app. A transient 500 here must always leave a Retry. */}
            {loadError && profiles === null ? (
              <Focusable
                round
                hasTVPreferredFocus
                onPress={() => setAttempt(n => n + 1)}
                style={[styles.btnGhost, styles.retry]}>
                <Text style={styles.btnGhostText}>Try again</Text>
              </Focusable>
            ) : null}
          </View>
        }
        renderItem={renderTile}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.pageX,
    justifyContent: 'center',
  },
  // The grid is top-aligned: with many profiles it scrolls, so centring it would
  // shift every tile as the list grows.
  rootTop: {flex: 1, backgroundColor: colors.bg},
  gridContent: {paddingHorizontal: spacing.pageX, paddingTop: spacing.xl, paddingBottom: spacing.lg},
  gridRow: {gap: spacing.lg, marginBottom: spacing.lg},
  heading: {color: colors.text, fontSize: fontSize.hero, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: fontSize.row, marginTop: spacing.sm},
  tile: {
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.l,
    width: TILE_W,
  },
  tileLocked: {opacity: 0.45},
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: radius.l,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarGlyph: {fontSize: 48},
  tileName: {
    color: colors.text,
    fontSize: fontSize.body,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.row,
    paddingVertical: 16,
    paddingHorizontal: 22,
    maxWidth: 480,
    marginTop: spacing.lg,
  },
  row: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg},
  retry: {alignSelf: 'flex-start', marginTop: spacing.md},
  btnPrimary: {
    backgroundColor: colors.white,
    paddingVertical: 14,
    paddingHorizontal: 40,
    minWidth: 150,
    alignItems: 'center',
  },
  btnPrimaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  btnGhost: {
    backgroundColor: colors.surface,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: 'center',
  },
  btnGhostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  error: {color: '#ff8080', fontSize: fontSize.small, marginTop: spacing.md},
});
