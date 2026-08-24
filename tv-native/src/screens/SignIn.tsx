// Sign in — the TV's face of prompt 10 (account = profile), shown when the
// server runs in CLOSED mode (or a session dies mid-run).
//
// THE PRIMARY FLOW IS THE QR. A remote is a terrible keyboard and every
// household member already has a signed-in phone: the TV mints a pairing code
// (POST /api/auth/device/start), draws {base}/link?code=XXXXXX as a QR, and
// polls until the phone's one-tap approval hands back a session. The code is
// shown as text beside the QR for phones that won't scan. Codes live 5
// minutes; the QR refreshes itself on expiry (never on an interval — `start`
// is rate-limited).
//
// Fallbacks, one Focusable each: typed username-or-email + password, and
// "Continue with Google" via the OAuth device flow — rendered only when the
// server says a TV-type Google client exists (serverInfo.googleDevice).
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import Focusable from '../components/Focusable';
import {api, ApiError, getBaseUrl, SigninResult} from '../api';
import {useFocusFallback} from '../focus';
import theme from '../theme';

const {colors, radius, fontSize, spacing} = theme;

const POLL_MS = 3000;

type Mode = 'qr' | 'typed' | 'google';

export default function SignIn({
  onSignedIn,
}: {
  onSignedIn: (profileId: string, token: string, session: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('qr');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleDevice, setGoogleDevice] = useState(false);
  const done = useRef(false); // success is single-shot across every poller

  const finish = useCallback(
    (r: Partial<SigninResult>) => {
      if (done.current) return;
      if (!r.profile?.id || !r.profileToken || !r.session) return;
      done.current = true;
      onSignedIn(r.profile.id, r.profileToken, r.session);
    },
    [onSignedIn],
  );

  // Whether to offer Google at all. Errors mean "don't" — the button would
  // only lead to a 501.
  useEffect(() => {
    let live = true;
    api
      .serverInfo()
      .then(i => live && setGoogleDevice(!!i.googleDevice))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // ---- QR pairing -----------------------------------------------------------
  const [pair, setPair] = useState<{code: string; secret: string; linkPath: string} | null>(null);
  const [pairErr, setPairErr] = useState('');
  useEffect(() => {
    if (mode !== 'qr') return;
    let live = true;
    let poll: ReturnType<typeof setInterval> | null = null;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    let polling = false;

    const start = async () => {
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
      setPair(null);
      setPairErr('');
      try {
        const r = await api.deviceStart();
        if (!live) return;
        setPair({code: r.code, secret: r.secret, linkPath: r.linkPath});
        // A fresh code shortly before this one dies, so the QR on screen is
        // always scannable. 10s of slack keeps us clear of the server's edge.
        refresh = setTimeout(start, Math.max(30, (r.expiresIn || 300) - 10) * 1000);
        poll = setInterval(async () => {
          if (polling || done.current) return;
          polling = true;
          try {
            const p = await api.devicePoll(r.code, r.secret);
            if (!live) return;
            if (!p.pending) finish(p);
          } catch (e) {
            if (!live) return;
            // 410 = expired or already spent: mint a fresh code right away.
            if (e instanceof ApiError && e.status === 410) start();
          } finally {
            polling = false;
          }
        }, POLL_MS);
      } catch (e) {
        if (!live) return;
        // Rate-limited or offline: say so, and let the retry button handle it.
        setPairErr(e instanceof ApiError && e.message ? e.message : 'Could not start pairing');
      }
    };
    start();
    return () => {
      live = false;
      if (poll) clearInterval(poll);
      if (refresh) clearTimeout(refresh);
    };
  }, [mode, finish]);

  // ---- typed login ----------------------------------------------------------
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const passRef = useRef<TextInput>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.login(username.trim(), password);
      finish(r);
    } catch (e) {
      // 401/429 bodies are written for viewers ("too many attempts — …").
      setError(e instanceof ApiError && e.message ? e.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  // ---- Google device flow ---------------------------------------------------
  const [gcode, setGcode] = useState<{userCode: string; url: string} | null>(null);
  const [gErr, setGErr] = useState('');
  useEffect(() => {
    if (mode !== 'google') return;
    let live = true;
    let poll: ReturnType<typeof setInterval> | null = null;
    let polling = false;
    (async () => {
      setGcode(null);
      setGErr('');
      try {
        const r = await api.googleStart();
        if (!live) return;
        setGcode({userCode: r.userCode, url: r.verificationUrl});
        poll = setInterval(async () => {
          if (polling || done.current) return;
          polling = true;
          try {
            const p = await api.googlePoll(r.pollId);
            if (!live) return;
            if (p.pending) return;
            if (p.signup) {
              // Verified Google account, but no Aurora profile is linked to it.
              setGErr('No profile is linked to that Google account — request access from the website.');
              if (poll) clearInterval(poll);
              return;
            }
            finish(p);
          } catch (e) {
            if (!live) return;
            if (e instanceof ApiError && e.status !== 0) {
              setGErr(e.message || 'Google sign-in failed');
              if (poll) clearInterval(poll);
            }
          } finally {
            polling = false;
          }
        }, Math.max(POLL_MS, 3000));
      } catch (e) {
        if (!live) return;
        setGErr(e instanceof ApiError && e.message ? e.message : 'Google sign-in is not available');
      }
    })();
    return () => {
      live = false;
      if (poll) clearInterval(poll);
    };
  }, [mode, finish]);

  // Back returns to the QR view from either fallback; from the QR view it
  // falls through (this screen is the app's floor — Back exits the app).
  useEffect(() => {
    if (mode === 'qr') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setMode('qr');
      setError('');
      return true;
    });
    return () => sub.remove();
  }, [mode]);

  // Focus safety: the primary button is this screen's anchor in every state.
  const anchor = useRef(null);
  useFocusFallback(anchor);

  const base = getBaseUrl();
  const host = base.replace(/^https?:\/\//, '');

  if (mode === 'typed') {
    return (
      <View style={styles.root}>
        <Text style={styles.kicker}>SIGN IN</Text>
        <Text style={styles.heading}>Username & password</Text>
        <Text style={styles.sub}>Your username or email, and your profile's password.</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Username or email"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={() => passRef.current?.focus()}
        />
        <TextInput
          ref={passRef}
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Password"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={submit}
        />
        <View style={styles.row}>
          <Focusable round ref={anchor} onPress={submit} style={styles.btnPrimary}>
            {busy ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.btnPrimaryText}>Sign in</Text>
            )}
          </Focusable>
          <Focusable round onPress={() => setMode('qr')} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>Back</Text>
          </Focusable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  if (mode === 'google') {
    return (
      <View style={styles.root}>
        <Text style={styles.kicker}>SIGN IN</Text>
        <Text style={styles.heading}>Continue with Google</Text>
        {gcode ? (
          <View style={styles.googleWrap}>
            <View style={styles.qrCard}>
              <QRCode
                value={`${gcode.url}${gcode.url.includes('?') ? '&' : '?'}user_code=${gcode.userCode}`}
                size={190}
                backgroundColor="#ffffff"
                color="#0b0c14"
              />
            </View>
            <View style={styles.googleText}>
              <Text style={styles.sub}>Scan the code, or on any device open</Text>
              <Text style={styles.googleUrl}>{gcode.url}</Text>
              <Text style={styles.sub}>and enter</Text>
              <Text style={styles.pairCode}>{gcode.userCode}</Text>
              <Text style={styles.waiting}>Waiting for Google…</Text>
            </View>
          </View>
        ) : gErr ? null : (
          <ActivityIndicator color={colors.text} style={{marginTop: spacing.lg}} />
        )}
        {gErr ? <Text style={styles.error}>{gErr}</Text> : null}
        <View style={styles.row}>
          <Focusable round ref={anchor} hasTVPreferredFocus onPress={() => setMode('qr')} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>Back</Text>
          </Focusable>
        </View>
      </View>
    );
  }

  // ---- the QR home ----------------------------------------------------------
  return (
    <View style={styles.root}>
      <Text style={styles.kicker}>SIGN IN</Text>
      <Text style={styles.heading}>Scan with your phone</Text>
      <Text style={styles.sub}>
        Open your camera, scan the code, and approve this TV — you'll be watching in seconds.
      </Text>

      <View style={styles.pairRow}>
        <View style={styles.qrCard}>
          {pair ? (
            <QRCode value={base + pair.linkPath} size={190} backgroundColor="#ffffff" color="#0b0c14" />
          ) : (
            <ActivityIndicator color={colors.bg} />
          )}
        </View>
        <View style={styles.pairText}>
          <Text style={styles.sub}>No camera handy? On your phone, open</Text>
          <Text style={styles.googleUrl}>{host}/link</Text>
          <Text style={styles.sub}>and type this code:</Text>
          <Text style={styles.pairCode}>{pair ? pair.code : '· · · · · ·'}</Text>
          {pair ? <Text style={styles.waiting}>Waiting for your phone…</Text> : null}
          {pairErr ? <Text style={styles.error}>{pairErr}</Text> : null}
        </View>
      </View>

      <View style={styles.row}>
        <Focusable
          round
          ref={anchor}
          hasTVPreferredFocus
          onPress={() => {
            setError('');
            setMode('typed');
          }}
          style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>Type username & password</Text>
        </Focusable>
        {googleDevice ? (
          <Focusable round onPress={() => setMode('google')} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>Continue with Google</Text>
          </Focusable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.pageX + 24,
    justifyContent: 'center',
  },
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  heading: {color: colors.text, fontSize: fontSize.hero, fontWeight: '900', marginTop: 4},
  sub: {color: colors.textDim, fontSize: fontSize.body, marginTop: 6, maxWidth: 560},
  pairRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.xl, marginTop: spacing.lg},
  // White card behind the QR: quiet-zone contrast, which phone cameras need.
  qrCard: {
    width: 230,
    height: 230,
    borderRadius: radius.l,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pairText: {flex: 1, maxWidth: 520},
  pairCode: {
    color: colors.text,
    fontSize: 40,
    fontWeight: '900',
    letterSpacing: 10,
    marginTop: 4,
  },
  waiting: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '600', marginTop: 10},
  googleWrap: {flexDirection: 'row', alignItems: 'center', gap: spacing.xl, marginTop: spacing.lg},
  googleText: {flex: 1, maxWidth: 560},
  googleUrl: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', marginTop: 2},
  row: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl},
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.row,
    paddingVertical: 14,
    paddingHorizontal: 22,
    maxWidth: 520,
    marginTop: spacing.md,
  },
  btnPrimary: {
    backgroundColor: colors.white,
    paddingVertical: 13,
    paddingHorizontal: 34,
    minWidth: 150,
    alignItems: 'center',
  },
  btnPrimaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  btnGhost: {
    backgroundColor: colors.surface,
    paddingVertical: 13,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  btnGhostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.md, maxWidth: 560},
});
