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
import React from 'react';
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
import {imgSrc, Profile} from '../api';
import theme, {useTvMetrics} from '../theme';
// the wall's rules (shared with the phone's wall): what a tile press does, the
// password, the household PIN, the kids lock
import {useProfileWall} from '../profileWall';

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
  notice,
}: {
  // `sid` is the sign-in session the unlock of a CLAIMED profile mints
  // (prompt 10's silent migration) — null for open/unclaimed profiles.
  // `extra.mustReset`: the admin asked for a new password (App.tsx).
  onChosen: (profileId: string, token: string | null, sid?: string | null, extra?: {mustReset?: boolean; typed?: string | null}) => void;
  // why the wall is up again (a kick, a sign-out from another device)
  notice?: string;
}) {
  const {width, safeBottom} = useTvMetrics();
  const {
    profiles,
    ordered,
    loadError,
    pwFor,
    setPwFor,
    password,
    setPassword,
    pwError,
    busy,
    lock,
    pinFor,
    setPinFor,
    pin,
    setPin,
    pinError,
    setPinError,
    choose,
    onTile,
    submitPin,
    retry,
  } = useProfileWall(onChosen);

  const cols = Math.max(
    3,
    Math.floor((width - 2 * spacing.pageX + spacing.lg) / (TILE_W + spacing.lg)),
  );

  // Not memoized on purpose: onTile closes over `choose`, which closes over the
  // `onChosen` prop, and a useCallback([]) here would freeze the first one —
  // a stale onChosen means picking a profile silently does nothing. This list is
  // a handful of static tiles, so there is nothing to gain by caching it.
  const renderTile = ({item: p, index}: {item: Profile; index: number}) => (
    <Focusable uiId="profile.pick"
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
          <Focusable uiId="profile.pin.submit" round onPress={submitPin} style={styles.btnPrimary}>
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
          <Focusable uiId="profile.unlock"
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
            {/* why the wall is up again: an admin's sign-out, a sign-out from another device */}
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
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
                onPress={retry}
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
  notice: {color: '#fbbf24', fontSize: fontSize.body, fontWeight: '700', marginTop: spacing.sm},
});
