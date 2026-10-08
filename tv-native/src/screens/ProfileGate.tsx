// Profile picker. Lists the server's profiles as avatar tiles; an open profile
// is chosen with one press, a protected one prompts for its password. On
// success we persist the profile id + unlock token and hand control up.
//
// KIDS PROFILES (2026-10-08). A kids profile wears a "Kids" badge. Entering
// one writes a lock on this TV (storage.ts KidsLock); while that lock stands,
// opening any OTHER profile first asks for the household PIN, which the
// server checks (POST /api/kids/exit). Going back into the same kids profile
// — or into a stricter one — asks nothing. Separately, the server itself asks
// for the PIN before it opens a grown-up's profile that has no password
// (401 {pinRequired:true} from unlock); the same PIN view answers that.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  StyleSheet,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import Focusable from '../components/Focusable';
import {api, getSession, imgSrc, setSession, ApiError, Profile} from '../api';
import {
  clearKidsLock,
  KidsLock,
  loadKidsLock,
  loadRecentProfiles,
  pushRecentProfile,
  saveAuthSession,
  saveKidsLock,
} from '../storage';
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
  // `sid` is the sign-in session the unlock of a CLAIMED profile mints
  // (prompt 10's silent migration) — null for open/unclaimed profiles.
  onChosen: (profileId: string, token: string | null, sid?: string | null) => void;
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
  // The kids profile this TV is in (or was last left in): see the header.
  const [lock, setLock] = useState<KidsLock | null>(null);
  // The PIN view: who it is for, and why. 'exit' = leaving the kids profile
  // (checked by /api/kids/exit); 'open' = the server asked for the PIN to
  // open a profile that has no password (checked by unlock itself).
  const [pinFor, setPinFor] = useState<{profile: Profile; mode: 'exit' | 'open'} | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  // The PIN the server last accepted in this visit to the wall — so leaving a
  // kids profile for a password-free one asks once, not twice.
  const goodPin = useRef('');

  useEffect(() => {
    let live = true;
    // Deliberately NOT clearing loadError here: doing so unmounts the Retry
    // button for the whole in-flight window, and with nothing else focusable
    // during a retry that is a dead remote on the one screen with no way back.
    // The error (and its button) clear on success instead.
    Promise.all([api.profiles(), loadRecentProfiles(), loadKidsLock()])
      .then(([list, rec, kl]) => {
        if (!live) return;
        setProfiles(list);
        setRecent(rec);
        setLoadError('');
        // A lock only means something while its profile is still a kids one
        // (the admin switched kids mode off, or deleted it: nothing to guard).
        const still = kl ? list.find(p => p.id === kl.id) : null;
        if (kl && still && still.kids) {
          console.log('[kids] wall: this TV is locked to kids profile', kl.id, 'limit', still.kids.maxAge);
          setLock({id: kl.id, maxAge: still.kids.maxAge});
        } else {
          if (kl) {
            console.log('[kids] wall: stored lock', kl.id, 'is void (no longer a kids profile)');
            clearKidsLock();
          }
          setLock(null);
        }
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

  const choose = async (p: Profile, pw = '', withPin = goodPin.current) => {
    // A second OK while the unlock is in flight would double-POST and call
    // onChosen twice.
    if (busy) return;
    setBusy(true);
    setPwError('');
    setPinError('');
    try {
      const res = await api.unlock(p.id, pw, withPin || undefined);
      if (res.token) {
        // Remember it for this TV before handing control up, so the next visit
        // to the gate lands straight on the profile actually used here.
        await pushRecentProfile(p.id);
        // Into a kids profile: this TV is locked to it from here on. Into
        // anyone else's: whatever lock there was has been answered for.
        if (p.kids) {
          console.log('[kids] entered kids profile', p.id, 'limit', p.kids.maxAge, '- TV locked to it');
          await saveKidsLock({id: p.id, maxAge: p.kids.maxAge});
        } else {
          if (lock) console.log('[kids] left kids profile', lock.id, 'for', p.id, '- lock cleared');
          await clearKidsLock();
        }
        // A claimed profile's unlock signs the device in on the spot — carry
        // the session up so the eventual flip to closed mode costs nothing.
        onChosen(p.id, res.token, res.session || null);
      } else {
        setPwError(res.error === 'wrong password' ? 'Wrong password' : 'Could not unlock');
      }
    } catch (e) {
      // The household PIN is wanted (a profile with no password, in a house
      // with a kids profile) — or the one just sent was wrong / rate-limited.
      // The message is the server's own either way.
      if (e instanceof ApiError && (e.pinRequired || (e.status === 429 && pinFor))) {
        console.log('[kids] unlock of', p.id, 'wants the household PIN:', e.status, e.message);
        goodPin.current = '';
        setPwFor(null);
        setPin('');
        // (no PIN was sent: that is a question, not an error to show in red)
        setPinError(withPin || e.status === 429 ? e.message : '');
        setPinFor({profile: p, mode: 'open'});
      }
      // The server returns 401 for a wrong password and 403 for an admin-locked
      // profile — distinguish those from an actual network failure.
      // (A profile with no password has no password view to print into: its
      // failures used to vanish. They go to the wall's own error line.)
      else {
        const show = pw || pwFor ? setPwError : setLoadError;
        if (e instanceof ApiError && e.status === 429) show(e.message);
        else if (e instanceof ApiError && e.status === 401) show('Wrong password');
        else if (e instanceof ApiError && e.status === 403) {
          show('This profile has been locked by an admin');
        } else show('Could not reach the server');
      }
    } finally {
      setBusy(false);
    }
  };

  // The PIN has let this TV out of the kids profile. If the TV is also SIGNED
  // IN as that profile (its unlock minted a session, which rides every
  // request as X-Session), the server would go on reading every request as
  // the child's — the grown-up's profile, opened next, would come up
  // filtered. The site is told by a cookie; here the session is simply ended.
  const dropKidsSession = async (kidId: string) => {
    if (!getSession()) return;
    try {
      const who = await api.me();
      if (who.user && who.user.profileId === kidId) {
        console.log('[kids] this TV was signed in as the kids profile - ending that session');
        await api.logout().catch(() => {});
        setSession(null);
        await saveAuthSession(null);
      }
    } catch {}
  };

  // Past the kids lock (or there was none): the profile's own door.
  const open = (p: Profile) => {
    if (p.hasPassword) {
      setPinFor(null);
      setPwFor(p);
      setPassword('');
      setPwError('');
    } else {
      choose(p);
    }
  };

  // Does picking `p` mean LEAVING the kids profile this TV is locked to?
  // Not when it is that profile, nor a kids profile at least as strict.
  const leavesKids = (p: Profile) =>
    !!lock && p.id !== lock.id && !(p.kids && p.kids.maxAge <= lock.maxAge);

  const onTile = async (p: Profile) => {
    if (p.locked) {
      setLoadError(`"${p.name}" has been locked by an admin.`);
      return;
    }
    setLoadError('');
    if (!leavesKids(p)) return open(p);
    if (busy) return;
    // Leaving a kids profile. Is there a PIN in the house at all?
    setBusy(true);
    let pinSet = true; // can't tell (server unreachable): ask — never fail open
    try {
      pinSet = !!(await api.kidsStatus()).pinSet;
    } catch (e) {
      // a server from before kids profiles has no such route and nothing to guard
      if (e instanceof ApiError && e.status === 404) pinSet = false;
    }
    setBusy(false);
    if (!pinSet) {
      console.log('[kids] leaving', lock?.id, '- no household PIN is set, nothing to ask');
      if (lock) await dropKidsSession(lock.id);
      await clearKidsLock();
      setLock(null);
      return open(p);
    }
    console.log('[kids] leaving', lock?.id, 'for', p.id, '- asking for the household PIN');
    setPin('');
    setPinError('');
    setPinFor({profile: p, mode: 'exit'});
  };

  // OK on the PIN view.
  const submitPin = async () => {
    if (!pinFor || busy) return;
    const typed = pin.trim();
    if (!/^\d{4,6}$/.test(typed)) {
      setPinError('The PIN is 4 to 6 digits.');
      return;
    }
    const target = pinFor.profile;
    if (pinFor.mode === 'open') {
      // the unlock itself checks it (and comes back here if it was wrong)
      return choose(target, '', typed);
    }
    setBusy(true);
    setPinError('');
    try {
      await api.kidsExit(typed, lock ? lock.id : '');
      console.log('[kids] PIN accepted - lock on', lock?.id, 'lifted');
      goodPin.current = typed;
      if (lock) await dropKidsSession(lock.id);
      await clearKidsLock();
      setLock(null);
      setPinFor(null);
      setPin('');
      setBusy(false);
      // `choose` reads goodPin, so a password-free profile opens on this PIN
      if (target.hasPassword) open(target);
      else choose(target, '', typed);
      return;
    } catch (e) {
      // 401 "That's not the PIN." / 429 "too many attempts — try again in a
      // few minutes": the server's words, as they are.
      const msg = e instanceof ApiError && e.status ? e.message : 'Could not reach the server';
      console.log('[kids] PIN refused:', e instanceof ApiError ? e.status : 0, msg);
      setPinError(msg);
      setPin('');
    }
    setBusy(false);
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
        {p.avatarImage ? (
          <Image
            source={imgSrc(p.avatarImage) || undefined}
            style={styles.avatarImg}
            resizeMode="cover"
            fadeDuration={0}
          />
        ) : (
          <Text style={styles.avatarGlyph}>{p.avatar || '🍿'}</Text>
        )}
        {/* .profile-kids — the site's mark, same colours, same place */}
        {p.kids ? (
          <View style={styles.kidsBadge}>
            <Text style={styles.kidsBadgeText}>KIDS</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.tileName} numberOfLines={1}>
        {p.name}
        {p.locked ? '  🚫' : p.hasPassword ? '  🔒' : ''}
      </Text>
    </Focusable>
  );

  // The household PIN: leaving a kids profile, or opening a profile that has
  // no password. Same shape as the password view below — one field with the
  // system keyboard (numeric), OK on the remote submits.
  if (pinFor) {
    const from = lock && pinFor.mode === 'exit' ? (profiles || []).find(x => x.id === lock.id) : null;
    return (
      <View style={styles.root}>
        <Text style={styles.heading}>Grown-ups only</Text>
        <Text style={styles.sub}>
          {pinFor.mode === 'exit'
            ? `Enter the household PIN to leave ${from ? `“${from.name}”` : 'the kids profile'}.`
            : `“${pinFor.profile.name}” has no password, so the household PIN opens it.`}
        </Text>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={t => setPin(t.replace(/\D/g, '').slice(0, 6))}
          secureTextEntry
          autoFocus
          keyboardType="number-pad"
          maxLength={6}
          placeholder="PIN"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={submitPin}
        />
        <View style={styles.row}>
          <Focusable round onPress={submitPin} style={styles.btnPrimary}>
            {busy ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.btnPrimaryText}>{pinFor.mode === 'exit' ? 'Unlock' : 'Open'}</Text>
            )}
          </Focusable>
          <Focusable
            round
            onPress={() => {
              setPinFor(null);
              setPin('');
              setPinError('');
            }}
            style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>Back</Text>
          </Focusable>
        </View>
        {pinError ? <Text style={styles.error}>{pinError}</Text> : null}
      </View>
    );
  }

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
  // screens.css `.profile-kids`: a mint pill sitting on the avatar's lower edge
  kidsBadge: {
    position: 'absolute',
    bottom: -9,
    alignSelf: 'center',
    backgroundColor: '#86efac',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  kidsBadgeText: {color: '#0b1a12', fontSize: 11, fontWeight: '800', letterSpacing: 0.8},
  avatarImg: {width: '100%', height: '100%', borderRadius: radius.l},
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
