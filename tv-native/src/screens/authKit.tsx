// [auth-round] The pieces of the TV's sign-in screens (SignIn.tsx, Reset.tsx,
// NewPassword.tsx), in the round's look (docs/auth-round.md section 3), the
// same as the website and the phone app, sized for ten feet:
//
//   - the night sky with the aurora glow (the app's own ambient canvas) as the
//     ground, and ONE glass panel carrying the form, at the app's radius;
//   - the Beam mark with "Aurora" small at the panel's top;
//   - a label above every field, help under it, the error IN PLACE of the help;
//   - one mint→violet primary button, Google's dark button, quiet text links;
//   - the TV's strong focus: the app's white ring on every button and link,
//     a bright 3dp edge on the field being typed into. Text is left-aligned.
//
// The colours are the phone app's sign-in colours (src/phone/auth/ui.tsx),
// copied rather than imported so the TV bundle never carries phone code. Every
// text pair on the panel is AA or better.
import React, {createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  useWindowDimensions,
} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import Ambient from '../components/Ambient';
import Focusable from '../components/Focusable';
import {useCanvasScale} from '../canvas';
import {liftFor} from '../authLift';
import {passwordStrength} from '../passRules';

const BEAM = require('../assets/logo-mark.png');

export const A = {
  text: '#eef1fa',
  dim: '#c2c7d6', // 10.9:1 on the panel
  faint: '#9aa1b5', // 6.6:1
  label: '#d5d9e6',
  error: '#ffb4ab', // 9.1:1
  link: '#a9c4ff',
  fieldBg: 'rgba(255,255,255,0.06)',
  fieldEdge: 'rgba(255,255,255,0.18)',
  focus: '#ffffff',
  panel: 'rgba(16,18,36,0.80)',
  mint: '#3fd8a4',
  notice: '#f0c67e',
};
export const R = {control: 12, panel: 20};
// the site's --g-fill (glass.css): the sheen on a glass surface
const G_FILL = 'linear-gradient(135deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.025) 55%, rgba(255,255,255,0.06) 100%)';
const MAIN_FILL = 'linear-gradient(115deg, rgb(63,216,164) 0%, rgb(127,140,255) 90%)';

/** A value as it was when the element was drawn. `first` (take focus) acts
 *  ONCE: a button whose `first` turns true later (a field filled in) must
 *  never pull focus off the field being typed into. */
function useMountValue<T>(v: T): T {
  return useRef(v).current;
}

/** The TV was asked for less movement (Settings → Accessibility → Remove animations):
 *  no focus scale on these screens, nothing slides. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(v => live && setReduced(!!v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => setReduced(!!v));
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

// THE KEYBOARD NEVER HIDES THE FIELD BEING TYPED INTO. The TV's keyboard
// (Gboard for TV on the Mi TV) floats over the bottom ~45% of the screen and
// does NOT resize the window, so nothing moves by itself. Instead, a focused
// field whose box would sit under that band lifts the whole panel until it
// clears it (a field already high enough moves nothing); focus leaving the
// fields brings the panel back down. Measured in window units, so it holds at
// any panel density. authLift.ts has the arithmetic.
const HELP_LINE = 24; // the help or error line under a field, kept clear too
type Lift = {focusIn: (node: View | null) => void; focusOut: () => void};
const LiftContext = createContext<Lift | null>(null);

/** The screen: the sky, and the glass panel centred on it. `top` sits beside
 *  the brand (the Sign in · Request access switch). */
export function AuthShell({children, top, width = 840}: {children: React.ReactNode; top?: React.ReactNode; width?: number}) {
  const reduced = useReducedMotion();
  const {height: winH} = useWindowDimensions();
  const scale = useCanvasScale();
  const y = useRef(new Animated.Value(0)).current;
  const lifted = useRef(0);
  const panelRef = useRef<View>(null);
  const svRef = useRef<ScrollView>(null);
  const panelY = useRef(0); // the panel's layout offset in the scroll view (no transform)
  const scrollY = useRef(0);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveTo = useCallback(
    (to: number) => {
      if (Math.abs(to - lifted.current) < 1) return;
      lifted.current = to;
      if (reduced) y.setValue(-to);
      else Animated.timing(y, {toValue: -to, duration: 200, easing: Easing.bezier(0.2, 0.7, 0.2, 1), useNativeDriver: true}).start();
    },
    [reduced, y],
  );
  // the field that has focus, and whether the keyboard is up: the panel lifts
  // only for the two together (moving through the fields with the D-pad, the
  // keyboard closed, moves nothing)
  const focused = useRef<View | null>(null);
  const kbOpen = useRef(false);
  const place = useCallback(
    (node: View | null) => {
      if (!node || !kbOpen.current) return moveTo(0);
      // Where the field sits with the panel AT REST, whatever the panel is
      // doing right now (lifted, or halfway down): its offset inside the panel
      // is the same either way, and the panel's resting place is the
      // (never moved) scroll view's top plus the panel's own layout offset.
      const panel = panelRef.current;
      const sv = svRef.current as unknown as View | null;
      if (!panel || !sv) return;
      node.measureInWindow((_x, fieldTop, _w, h) => {
        panel.measureInWindow((_px, panelTop) => {
          sv.measureInWindow((_sx, svTop) => {
            if (focused.current !== node || !kbOpen.current) return;
            const restTop = svTop + (panelY.current - scrollY.current) * scale + (fieldTop - panelTop);
            // + the help / error line under the box: it is read while typing
            moveTo(liftFor({top: restTop, height: h + HELP_LINE * scale, windowHeight: winH, scale}));
          });
        });
      });
    },
    [moveTo, winH, scale],
  );
  const lift = useMemo<Lift>(
    () => ({
      focusIn: node => {
        if (leaving.current) clearTimeout(leaving.current);
        leaving.current = null;
        focused.current = node;
        place(node);
      },
      focusOut: () => {
        focused.current = null;
        if (leaving.current) clearTimeout(leaving.current);
        // a moment's grace: field → its Show button → the next field is not a drop
        leaving.current = setTimeout(() => {
          if (!focused.current) moveTo(0);
        }, 90);
      },
    }),
    [moveTo, place],
  );
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      kbOpen.current = true;
      place(focused.current);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      kbOpen.current = false;
      moveTo(0);
    });
    return () => {
      show.remove();
      hide.remove();
      if (leaving.current) clearTimeout(leaving.current);
    };
  }, [place, moveTo]);
  return (
    <View style={s.root}>
      <Ambient />
      <View style={s.calm} pointerEvents="none" />
      <LiftContext.Provider value={lift}>
        <ScrollView
          ref={svRef}
          scrollEventThrottle={64}
          onScroll={e => {
            scrollY.current = e.nativeEvent.contentOffset.y;
          }}
          style={s.scroll} contentContainerStyle={s.scrollBody} keyboardShouldPersistTaps="handled">
          <Animated.View
            ref={panelRef}
            collapsable={false}
            onLayout={e => {
              panelY.current = e.nativeEvent.layout.y;
            }}
            style={[s.panel, {maxWidth: width, transform: [{translateY: y}]}]}>
            <View style={s.head}>
              <View style={s.brand} accessible accessibilityRole="header" accessibilityLabel="Aurora">
                <Image source={BEAM} style={s.beam} resizeMode="contain" fadeDuration={0} />
                <Text style={s.brandText}>Aurora</Text>
              </View>
              {top}
            </View>
            {children}
          </Animated.View>
        </ScrollView>
      </LiftContext.Provider>
    </View>
  );
}

/** "Sign in · Request access": two tabs; the lit one is the page you are on. */
export function Switch({value, onChange}: {value: 'signin' | 'request'; onChange: (v: 'signin' | 'request') => void}) {
  const reduced = useReducedMotion();
  const tab = (k: 'signin' | 'request', label: string) => {
    const on = value === k;
    return (
      <Focusable
        uiId={k === 'signin' ? 'signin.tab.signin' : 'signin.tab.request'}
        noScale={reduced}
        scaleTo={1.03}
        accessibilityLabel={label}
        onPress={() => !on && onChange(k)}
        style={[s.tab, on && s.tabOn]}>
        <Text style={[s.tabText, on && s.tabTextOn]} numberOfLines={1}>
          {label}
        </Text>
      </Focusable>
    );
  };
  return (
    <View style={s.tabs} accessibilityRole="tablist">
      {tab('signin', 'Sign in')}
      {tab('request', 'Request access')}
    </View>
  );
}

export function Title({children, line, notice}: {children: string; line?: React.ReactNode; notice?: string | null}) {
  return (
    <View style={s.titleBox}>
      <Text style={s.title} accessibilityRole="header">
        {children}
      </Text>
      {notice ? <Text style={s.notice}>{notice}</Text> : null}
      {line ? <Text style={s.line}>{line}</Text> : null}
    </View>
  );
}

export type FieldHandle = {
  /** focus, and open the keyboard (moving on from the field before) */
  focus: () => void;
  /** focus WITHOUT opening the keyboard (a screen's first field, the field an
   *  error belongs to): OK opens it, as on any TV field */
  focusQuietly: () => void;
  blur: () => void;
};

type FieldProps = Omit<TextInputProps, 'ref'> & {
  label: string;
  help?: string | null;
  error?: string | null;
  secret?: boolean;
  /** under the field, before the help (the strength hint) */
  below?: React.ReactNode;
  /** the field this screen opens on: focused quietly once it is drawn */
  first?: boolean;
  /** the field's nativeID, for QA tools (fields are not counted controls) */
  qaId?: string;
};

/** A labelled field. Password fields carry Show / Hide, a button of its own
 *  (RIGHT from the field). What was typed is never cleared by an error. */
export const Field = forwardRef<FieldHandle, FieldProps>(function Field(
  {label, help, error, secret, below, first, qaId, onFocus, onBlur, style, ...rest},
  ref,
) {
  const input = useRef<TextInput>(null);
  const [on, setOn] = useState(false);
  const [shown, setShown] = useState(false);
  // false only for a moment: while a quiet focus lands (react-native-tvos
  // opens the keyboard on a programmatic focus unless this is off).
  const [soft, setSoft] = useState(!first);
  // each quiet focus asked for: the effect below runs once per ask
  const [quietAsk, setQuietAsk] = useState(0);
  const pendingQuiet = useRef(!!first);
  const focusQuietly = useCallback(() => {
    pendingQuiet.current = true;
    setSoft(false);
    setQuietAsk(n => n + 1);
  }, []);
  useEffect(() => {
    if (!quietAsk) return;
    // the prop has reached the native view: focus, then let OK open the keyboard again
    let back: ReturnType<typeof setTimeout> | null = null;
    const t = setTimeout(() => {
      input.current?.focus();
      back = setTimeout(() => {
        pendingQuiet.current = false;
        setSoft(true);
      }, 250);
    }, 60);
    return () => {
      clearTimeout(t);
      if (back) clearTimeout(back);
    };
  }, [quietAsk]);
  // ONCE, when the field is drawn: `first` changing later (the screen's
  // "first empty field" moves on as you type) must never pull focus away
  const firstAtMount = useRef(!!first).current;
  useEffect(() => {
    if (!firstAtMount) return;
    // after the screen's own layout pass, so Android has somewhere to put focus
    const t = setTimeout(focusQuietly, 120);
    return () => clearTimeout(t);
  }, [firstAtMount, focusQuietly]);
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    focusQuietly,
    blur: () => input.current?.blur(),
  }));
  const note = error || help || '';
  const lift = useContext(LiftContext);
  const row = useRef<View>(null);
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <View style={s.boxRow} ref={row} collapsable={false}>
        <View style={[s.box, on && s.boxOn]}>
          {/* the focus ring (and the error edge) drawn OVER the box's own 1dp edge,
              so gaining focus never moves anything */}
          {on || error ? <View pointerEvents="none" style={[s.ringOver, !on && s.ringErr]} /> : null}
          <TextInput
            ref={input}
            placeholderTextColor="rgba(154,161,181,0.75)"
            selectionColor="#8b7bff"
            cursorColor="#ffffff"
            accessibilityLabel={label}
            accessibilityHint={note || undefined}
            autoCapitalize="none"
            autoCorrect={false}
            showSoftInputOnFocus={soft}
            secureTextEntry={!!secret && !shown}
            {...rest}
            onFocus={e => {
              setOn(true);
              // reached by the D-pad before a quiet focus: OK must open the keyboard
              if (!pendingQuiet.current) setSoft(true);
              lift?.focusIn(row.current);
              onFocus?.(e);
            }}
            onBlur={e => {
              setOn(false);
              lift?.focusOut();
              onBlur?.(e);
            }}
            style={[s.input, style]}
            nativeID={qaId}
          />
        </View>
        {secret ? (
          <Focusable
            uiId="signin.reveal"
            noScale
            onFocusChange={f => (f ? lift?.focusIn(row.current) : lift?.focusOut())}
            accessibilityLabel={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            onPress={() => setShown(v => !v)}
            style={s.reveal}>
            <Text style={s.revealText}>{shown ? 'Hide' : 'Show'}</Text>
          </Focusable>
        ) : null}
      </View>
      {below}
      <Text style={[s.help, !!error && s.err]} accessibilityLiveRegion={error ? 'polite' : 'none'} numberOfLines={2}>
        {note}
      </Text>
    </View>
  );
});

const STRENGTH_COLORS = ['#ffb4ab', '#ffb4ab', '#f0c67e', '#8fd8b8', A.mint];
/** The strength hint under a new password (a hint, never a rule). */
export function Strength({pw, personal}: {pw: string; personal?: Array<string | null | undefined>}) {
  if (!pw) return null;
  const st = passwordStrength(pw, personal);
  return (
    <View style={s.meter} accessible accessibilityLabel={`Password strength: ${st.label}`}>
      <View style={s.bars}>
        {[1, 2, 3, 4].map(i => (
          <View key={i} style={[s.bar, i <= st.score && {backgroundColor: STRENGTH_COLORS[st.score]}]} />
        ))}
      </View>
      <Text style={[s.meterText, {color: st.score <= 1 ? A.error : A.dim}]}>{st.label}</Text>
    </View>
  );
}

type BtnProps = {
  label: string;
  busyLabel?: string;
  onPress: () => void;
  busy?: boolean;
  uiId?: string;
  first?: boolean;
  grow?: boolean;
};

/** The one primary button: the mint→violet sweep, dark words. Busy = spinner
 *  and its busy words; it stays focusable (focus never jumps) but does nothing. */
export const MainButton = forwardRef<View, BtnProps & {claim?: string | null}>(function MainButton(
  {label, busyLabel, onPress, busy, uiId, first, grow, claim},
  ref,
) {
  const reduced = useReducedMotion();
  const own = useRef<View | null>(null);
  const setRef = useCallback(
    (v: View | null) => {
      own.current = v;
      if (typeof ref === 'function') ref(v);
      else if (ref) (ref as React.MutableRefObject<View | null>).current = v;
    },
    [ref],
  );
  // `claim`: words about the whole form just appeared (no connection, too
  // many tries). The field that was sent from has let go of focus, so it comes
  // here, next to the words, rather than to whatever Android picks.
  useEffect(() => {
    if (!claim) return;
    const t = setTimeout(() => (own.current as unknown as {requestTVFocus?: () => void} | null)?.requestTVFocus?.(), 80);
    return () => clearTimeout(t);
  }, [claim]);
  return (
    <Focusable
      uiId={uiId}
      ref={setRef}
      light
      noScale={reduced}
      scaleTo={1.03}
      hasTVPreferredFocus={useMountValue(!!first)}
      accessibilityLabel={busy && busyLabel ? busyLabel : label}
      onPress={() => !busy && onPress()}
      style={[s.main, grow && s.grow, busy && s.busy]}>
      {/* the sweep on its own layer, inside the reserved ring border: drawn on the
          button itself it repeats into that border (a stripe at each end, Mi TV) */}
      <View style={s.mainFill} pointerEvents="none" />
      <View style={s.btnInner}>
        {busy ? <ActivityIndicator color="#061310" size="small" /> : null}
        <Text style={s.mainText} numberOfLines={1}>
          {busy && busyLabel ? busyLabel : label}
        </Text>
      </View>
    </Focusable>
  );
});

/** A quiet button (Back, Try again): glass, light words. */
export const PlainButton = forwardRef<View, BtnProps>(function PlainButton({label, busyLabel, onPress, busy, uiId, first, grow}, ref) {
  const reduced = useReducedMotion();
  return (
    <Focusable
      uiId={uiId}
      ref={ref}
      noScale={reduced}
      scaleTo={1.03}
      hasTVPreferredFocus={useMountValue(!!first)}
      accessibilityLabel={label}
      onPress={() => !busy && onPress()}
      style={[s.plain, grow && s.grow, busy && s.busy]}>
      <View style={s.btnInner}>
        {busy ? <ActivityIndicator color={A.text} size="small" /> : null}
        <Text style={s.plainText} numberOfLines={1}>
          {busy && busyLabel ? busyLabel : label}
        </Text>
      </View>
    </Focusable>
  );
});

function GoogleG({size = 20}: {size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}

/** Google's dark button (Google's branding rules: #131314, a #8E918F edge, #E3E3E3 words, the four-colour G). */
export const GoogleButton = forwardRef<View, BtnProps>(function GoogleButton({label, onPress, busy, uiId, first, grow}, ref) {
  const reduced = useReducedMotion();
  return (
    <Focusable
      uiId={uiId}
      ref={ref}
      noScale={reduced}
      scaleTo={1.03}
      hasTVPreferredFocus={useMountValue(!!first)}
      accessibilityLabel={label}
      onPress={() => !busy && onPress()}
      style={[s.google, grow && s.grow, busy && s.busy]}>
      <View style={s.btnInner}>
        {busy ? <ActivityIndicator color="#E3E3E3" size="small" /> : <GoogleG />}
        <Text style={s.googleText} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Focusable>
  );
});

/** A text button (a link's look, a button's job, the app's focus ring). */
export const TextLink = forwardRef<View, {label: string; onPress: () => void; uiId?: string; first?: boolean}>(function TextLink(
  {label, onPress, uiId, first},
  ref,
) {
  return (
    <Focusable uiId={uiId} ref={ref} noScale hasTVPreferredFocus={useMountValue(!!first)} accessibilityLabel={label} onPress={onPress} style={s.linkTap}>
      <Text style={s.link}>{label}</Text>
    </Focusable>
  );
});

/** A tick box with its words (the whole row is the target). */
export function Check({label, value, onChange, uiId}: {label: string; value: boolean; onChange: (v: boolean) => void; uiId?: string}) {
  return (
    <Focusable uiId={uiId} noScale accessibilityLabel={`${label}: ${value ? 'on' : 'off'}`} onPress={() => onChange(!value)} style={s.check}>
      <View style={s.checkRow}>
        <View style={[s.tick, value && s.tickOn]}>
          {value ? (
            <Svg width={16} height={16} viewBox="0 0 24 24">
              <Path d="M20 6 9 17l-5-5" stroke="#061310" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          ) : null}
        </View>
        <Text style={s.checkLabel}>{label}</Text>
      </View>
    </Focusable>
  );
}

/** One way to reset ("Use Google", "Ask the admin", …): a row with its line. */
export function Choice({title, line, onPress, uiId, first}: {title: string; line?: string; onPress: () => void; uiId?: string; first?: boolean}) {
  return (
    <Focusable
      uiId={uiId}
      noScale
      hasTVPreferredFocus={useMountValue(!!first)}
      accessibilityLabel={line ? `${title}. ${line}` : title}
      onPress={onPress}
      highlightColor="rgba(255,255,255,0.08)"
      style={s.choice}>
      <View style={s.choiceRow}>
        <View style={s.choiceWords}>
          <Text style={s.choiceTitle}>{title}</Text>
          {line ? <Text style={s.choiceLine}>{line}</Text> : null}
        </View>
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path d="m9 6 6 6-6 6" stroke={A.dim} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    </Focusable>
  );
}

/** An error about the whole form (no connection, too many tries). */
export function FormError({text}: {text?: string | null}) {
  if (!text) return null;
  return (
    <Text style={s.formErr} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      {text}
    </Text>
  );
}

/** A big code to type elsewhere (Google's code, the pairing code). */
export function CodeBlock({label, code, sub}: {label: string; code: string; sub?: string}) {
  return (
    <View style={s.codeBox}>
      <Text style={s.codeLabel}>{label}</Text>
      <Text style={s.code} selectable>
        {code}
      </Text>
      {sub ? <Text style={s.codeSub}>{sub}</Text> : null}
    </View>
  );
}

/** "Waiting for …": a small spinner and its words. */
export function Waiting({text}: {text: string}) {
  return (
    <View style={s.waitRow} accessibilityLiveRegion="polite">
      <ActivityIndicator color={A.dim} size="small" />
      <Text style={s.waitText}>{text}</Text>
    </View>
  );
}

export function Row({children, gap = 14, style}: {children: React.ReactNode; gap?: number; style?: object}) {
  return <View style={[s.row, {gap}, style]}>{children}</View>;
}

export function Body({children, strong}: {children: React.ReactNode; strong?: boolean}) {
  return <Text style={[s.body, strong && s.strong]}>{children}</Text>;
}

export const as = StyleSheet.create({
  cols: {flexDirection: 'row', gap: 28, alignItems: 'flex-start'},
  col: {flex: 1, minWidth: 0},
  side: {width: 300},
  gap: {height: 10},
  // the QR's white card: quiet-zone contrast, which phone cameras need
  qr: {width: 178, height: 178, borderRadius: R.control, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center'},
  sideTitle: {color: A.text, fontSize: 18, fontWeight: '700', marginBottom: 6},
  url: {color: A.text, fontSize: 18, fontWeight: '800'},
  divider: {width: 1, alignSelf: 'stretch', backgroundColor: 'rgba(255,255,255,0.10)'},
});

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0b0c14'},
  // calmer and lower: the sky dimmed a little, so the panel is what you see
  calm: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8,9,16,0.12)'},
  scroll: {flex: 1},
  scrollBody: {flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 48, paddingVertical: 16},
  panel: {
    width: '100%',
    borderRadius: R.panel,
    paddingHorizontal: 30,
    paddingTop: 20,
    paddingBottom: 22,
    backgroundColor: A.panel,
    experimental_backgroundImage: G_FILL,
    borderWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.30)',
    borderLeftColor: 'rgba(255,255,255,0.14)',
    borderRightColor: 'rgba(255,255,255,0.07)',
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 40},
  brand: {flexDirection: 'row', alignItems: 'center', gap: 8},
  beam: {width: 22, height: 22},
  brandText: {color: A.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.35},
  tabs: {flexDirection: 'row', gap: 6, padding: 4, borderRadius: R.control, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)'},
  tab: {minHeight: 36, minWidth: 120, borderRadius: R.control - 4, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  tabOn: {backgroundColor: 'rgba(255,255,255,0.14)'},
  tabText: {color: A.dim, fontSize: 15, fontWeight: '600'},
  tabTextOn: {color: A.text, fontWeight: '700'},
  titleBox: {marginBottom: 10},
  title: {color: A.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.2, lineHeight: 32},
  line: {color: A.dim, fontSize: 15, lineHeight: 21, marginTop: 4, maxWidth: 640},
  notice: {color: A.notice, fontSize: 15, fontWeight: '700', lineHeight: 21, marginTop: 4},
  field: {marginBottom: 4},
  label: {color: A.label, fontSize: 15, fontWeight: '600', marginBottom: 6},
  boxRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  box: {flex: 1, minHeight: 44, borderRadius: R.control, backgroundColor: A.fieldBg, borderWidth: 1, borderColor: A.fieldEdge, justifyContent: 'center'},
  boxOn: {backgroundColor: 'rgba(255,255,255,0.11)'},
  ringOver: {position: 'absolute', top: -2, left: -2, right: -2, bottom: -2, borderRadius: R.control + 2, borderWidth: 3, borderColor: A.focus},
  ringErr: {borderColor: A.error, borderWidth: 2, top: -1, left: -1, right: -1, bottom: -1, borderRadius: R.control + 1},
  input: {minHeight: 40, paddingHorizontal: 14, paddingVertical: 0, color: A.text, fontSize: 18, textAlign: 'left'},
  reveal: {minHeight: 44, minWidth: 74, borderRadius: R.control, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, backgroundColor: 'rgba(255,255,255,0.06)'},
  revealText: {color: A.dim, fontSize: 15, fontWeight: '700'},
  help: {color: A.faint, fontSize: 14, lineHeight: 19, marginTop: 4, minHeight: 19},
  err: {color: A.error, fontWeight: '600'},
  meter: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 7},
  bars: {flex: 1, flexDirection: 'row', gap: 4},
  bar: {flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)'},
  meterText: {fontSize: 14, fontWeight: '600', minWidth: 72, textAlign: 'right'},
  row: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap'},
  grow: {flexGrow: 1},
  btnInner: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10},
  main: {minHeight: 46, minWidth: 170, borderRadius: R.control, justifyContent: 'center', paddingHorizontal: 26},
  mainFill: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: R.control - 3, experimental_backgroundImage: MAIN_FILL},
  busy: {opacity: 0.7},
  mainText: {color: '#061310', fontSize: 17, fontWeight: '800'},
  plain: {minHeight: 46, minWidth: 120, borderRadius: R.control, justifyContent: 'center', paddingHorizontal: 22, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)'},
  plainText: {color: A.text, fontSize: 16, fontWeight: '700'},
  google: {minHeight: 46, borderRadius: R.control, justifyContent: 'center', paddingHorizontal: 22, backgroundColor: '#131314', borderWidth: 1, borderColor: '#8E918F'},
  googleText: {color: '#E3E3E3', fontSize: 16, fontWeight: '600'},
  linkTap: {minHeight: 40, borderRadius: 8, justifyContent: 'center', paddingHorizontal: 8},
  link: {color: A.link, fontSize: 15, fontWeight: '700'},
  check: {borderRadius: R.control, paddingVertical: 8, paddingHorizontal: 8, marginLeft: -11, alignSelf: 'flex-start'},
  checkRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  tick: {width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center'},
  tickOn: {backgroundColor: A.mint, borderColor: A.mint},
  checkLabel: {color: A.text, fontSize: 16, fontWeight: '600'},
  choice: {minHeight: 84, justifyContent: 'center', borderRadius: R.control, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', marginBottom: 10},
  choiceRow: {flexDirection: 'row', alignItems: 'center', gap: 14},
  choiceWords: {flex: 1, minWidth: 0},
  choiceTitle: {color: A.text, fontSize: 17, fontWeight: '700'},
  choiceLine: {color: A.dim, fontSize: 14, lineHeight: 19, marginTop: 2},
  formErr: {color: A.error, fontSize: 15, fontWeight: '600', lineHeight: 21, marginBottom: 10},
  codeBox: {paddingVertical: 12, paddingHorizontal: 16, borderRadius: R.control, backgroundColor: A.fieldBg, borderWidth: 1, borderColor: A.fieldEdge, marginBottom: 12},
  codeLabel: {color: A.dim, fontSize: 14, fontWeight: '700'},
  code: {color: A.text, fontSize: 34, fontWeight: '800', letterSpacing: 6, marginTop: 2, fontVariant: ['tabular-nums']},
  codeSub: {color: A.faint, fontSize: 14, marginTop: 2},
  waitRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 6},
  waitText: {color: A.dim, fontSize: 15, fontWeight: '600'},
  body: {color: A.dim, fontSize: 15, lineHeight: 22},
  strong: {color: A.text, fontWeight: '700'},
});
