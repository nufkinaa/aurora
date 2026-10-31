// [auth-round] The pieces of the phone's sign-in screens, in the website's sign-in look
// (docs/auth-round.md section 3): the night sky with the aurora, ONE glass panel with
// the Beam mark and "Aurora" small at its top, a label above every field, help under
// it and the error in place of the help, one mint→violet button, Google's own dark
// button. Corners at the app's radius (12 for controls, 24 for the panel), never
// pill-round; text starts at the start edge (RTL-safe: start/end, rows flip).
import React, {forwardRef, useEffect, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  useWindowDimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path} from 'react-native-svg';
import {passwordStrength} from '../../passRules';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import Sky from '../ui/Sky';
import {StatusScrim} from '../ui/Scrims';
import {colors, G_EDGE, G_FILL} from '../theme';

const BEAM = require('../../assets/logo-mark.png');

// the look's few colours (on the panel: every text pair here is AA or better)
export const A = {
  text: '#eef1fa',
  dim: '#c2c7d6', // 10.9:1 on the panel
  faint: '#9aa1b5', // 6.6:1 — help lines
  label: '#d5d9e6',
  error: '#ffb4ab', // 9.1:1
  link: '#a9c4ff',
  fieldBg: 'rgba(255,255,255,0.06)',
  fieldEdge: 'rgba(255,255,255,0.16)',
  focus: '#8fa8ff',
  panel: 'rgba(16,18,36,0.72)',
  mint: '#3fd8a4',
};
export const R = {control: 12, panel: 24};

/** The person asked the phone for less motion: no press-in scale, nothing that slides. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(v => live && setReduced(!!v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', v => setReduced(!!v));
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

/** The screen: the sky, a scrolling column that the keyboard pushes up, the glass panel. */
export function AuthShell({children, footer}: {children: React.ReactNode; footer?: React.ReactNode}) {
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  const small = width < 360;
  return (
    <View style={s.root}>
      <Sky dim />
      <KeyboardAvoidingView behavior="height" style={s.root}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            s.body,
            {
              paddingTop: insets.top + (small ? 20 : 32),
              paddingBottom: insets.bottom + 24,
              paddingStart: Math.max(small ? 12 : 16, insets.left),
              paddingEnd: Math.max(small ? 12 : 16, insets.right),
            },
          ]}>
          <View style={[s.panel, small && s.panelSmall]}>
            <View style={s.brand} accessible accessibilityRole="header" accessibilityLabel="Aurora">
              <Image source={BEAM} style={s.beam} resizeMode="contain" />
              <Text style={s.brandText} allowFontScaling={false}>
                Aurora
              </Text>
            </View>
            {children}
          </View>
          {footer ? <View style={s.footer}>{footer}</View> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      {/* the clock stays readable over a form that scrolls under it */}
      <StatusScrim />
    </View>
  );
}

const uiIdOfTab = {left: 'phone.auth.tab.signin', right: 'phone.auth.tab.request'} as const;

/** "Sign in · Request access": a two-way switch at the top of the panel. */
export function Segmented({value, onChange, left, right}: {value: 'left' | 'right'; onChange: (v: 'left' | 'right') => void; left: string; right: string}) {
  const seg = (k: 'left' | 'right', label: string) => {
    const on = value === k;
    return (
      <Tap
        uiId={uiIdOfTab[k]}
        flat
        accessibilityRole="tab"
        accessibilityState={{selected: on}}
        accessibilityLabel={label}
        onPress={() => !on && onChange(k)}
        style={[s.seg, on && s.segOn]}>
        <Text style={[s.segText, on && s.segTextOn]} numberOfLines={1}>
          {label}
        </Text>
      </Tap>
    );
  };
  return (
    <View style={s.segs} accessibilityRole="tablist">
      {seg('left', left)}
      {seg('right', right)}
    </View>
  );
}

export function Title({children, line}: {children: string; line?: React.ReactNode}) {
  // a screen reader hears where the panel went (Request sent, Choose a new password…)
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(children);
  }, [children]);
  return (
    <View style={s.titleBox}>
      <Text style={s.title} accessibilityRole="header">
        {children}
      </Text>
      {line ? <Text style={s.line}>{line}</Text> : null}
    </View>
  );
}

type FieldProps = TextInputProps & {
  label: string;
  help?: string | null;
  error?: string | null;
  secret?: boolean;
  /** a link at the end of the label's row ("Forgot password?") */
  aside?: React.ReactNode;
  /** under the field, before the help (the strength hint) */
  below?: React.ReactNode;
};

/** A labelled field: the label above, the help (or the error, in its place) below. The
 *  password kind has Show / Hide. What was typed is never cleared by an error. */
export const AuthField = forwardRef<TextInput, FieldProps>(function AuthField({label, help, error, secret, aside, below, onFocus, onBlur, style, ...rest}, ref) {
  const [on, setOn] = useState(false);
  const [shown, setShown] = useState(false);
  const note = error || help || '';
  return (
    <View style={s.field}>
      <View style={s.labelRow}>
        <Text style={s.label} nativeID={undefined}>
          {label}
        </Text>
        {aside}
      </View>
      <View style={[s.box, on && s.boxOn, !!error && s.boxErr]}>
        <TextInput
          ref={ref}
          placeholderTextColor="rgba(154,161,181,0.7)"
          selectionColor={colors.accent}
          cursorColor={A.focus}
          accessibilityLabel={label}
          accessibilityHint={note || undefined}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={!!secret && !shown}
          {...rest}
          onFocus={e => {
            setOn(true);
            onFocus?.(e);
          }}
          onBlur={e => {
            setOn(false);
            onBlur?.(e);
          }}
          style={[s.input, style]}
        />
        {secret ? (
          <Tap
            uiId="phone.auth.reveal"
            flat
            onPress={() => setShown(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            style={s.reveal}>
            <Icon name={shown ? 'eyeOff' : 'eye'} size={18} color={A.dim} />
            <Text style={s.revealText}>{shown ? 'Hide' : 'Show'}</Text>
          </Tap>
        ) : null}
      </View>
      {below}
      {note ? (
        <Text style={[s.help, !!error && s.err]} accessibilityLiveRegion={error ? 'polite' : 'none'}>
          {note}
        </Text>
      ) : null}
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

/** The one primary button: the mint→violet sweep, dark words; busy = spinner + its words. */
export function MainButton({label, busyLabel, onPress, busy, disabled, uiId}: {label: string; busyLabel?: string; onPress: () => void; busy?: boolean; disabled?: boolean; uiId?: string}) {
  const reduced = useReducedMotion();
  return (
    <Tap
      uiId={uiId}
      flat={reduced}
      accessibilityRole="button"
      accessibilityLabel={busy && busyLabel ? busyLabel : label}
      accessibilityState={{disabled: !!(disabled || busy), busy: !!busy}}
      onPress={onPress}
      disabled={disabled || busy}
      rippleColor="rgba(0,0,0,0.12)"
      style={[s.main, (disabled || busy) && s.mainOff]}>
      {busy ? <ActivityIndicator color="#061310" size="small" /> : null}
      <Text style={s.mainText} numberOfLines={1}>
        {busy && busyLabel ? busyLabel : label}
      </Text>
    </Tap>
  );
}

/** Google's dark button (Google's own branding rules: #131314, a #8E918F edge, #E3E3E3). */
export function GoogleButton({label, onPress, busy, disabled, uiId}: {label: string; onPress: () => void; busy?: boolean; disabled?: boolean; uiId?: string}) {
  const reduced = useReducedMotion();
  return (
    <Tap
      uiId={uiId}
      flat={reduced}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: !!(disabled || busy), busy: !!busy}}
      onPress={onPress}
      disabled={disabled || busy}
      style={[s.google, (disabled || busy) && s.mainOff]}>
      {busy ? (
        <ActivityIndicator color="#E3E3E3" size="small" />
      ) : (
        <Svg width={18} height={18} viewBox="0 0 48 48">
          <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </Svg>
      )}
      <Text style={s.googleText} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/** A line with "or" between the password way and Google. */
export function Or() {
  return (
    <View style={s.or} importantForAccessibility="no-hide-descendants">
      <View style={s.orLine} />
      <Text style={s.orText}>or</Text>
      <View style={s.orLine} />
    </View>
  );
}

/** A text button (a link's look, a button's role and a 44 dp target). */
export function TextLink({label, onPress, uiId, style, compact}: {label: string; onPress: () => void; uiId?: string; style?: object; compact?: boolean}) {
  // compact (beside a label): drawn on the label's line, the 44 dp target made by hitSlop
  return (
    <Tap uiId={uiId} flat hitSlop={compact ? {top: 12, bottom: 12, left: 12, right: 12} : 8} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[compact ? s.linkCompact : s.linkTap, style]}>
      <Text style={s.link}>{label}</Text>
    </Tap>
  );
}

/** A tick box with its words (the whole row is the target). */
export function Check({label, help, value, onChange, uiId}: {label: string; help?: string; value: boolean; onChange: (v: boolean) => void; uiId?: string}) {
  return (
    <Tap uiId={uiId} flat accessibilityRole="checkbox" accessibilityState={{checked: value}} accessibilityLabel={label} accessibilityHint={help} onPress={() => onChange(!value)} style={s.check}>
      <View style={[s.tick, value && s.tickOn]}>
        {value ? (
          <Svg width={14} height={14} viewBox="0 0 24 24">
            <Path d="M20 6 9 17l-5-5" stroke="#061310" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        ) : null}
      </View>
      <View style={s.checkWords}>
        <Text style={s.checkLabel}>{label}</Text>
        {help ? <Text style={s.help}>{help}</Text> : null}
      </View>
    </Tap>
  );
}

/** One way to reset ("Use Google", "Ask the admin", …): a row with its line and a chevron. */
export function Choice({title, line, onPress, uiId, busy}: {title: string; line?: string; onPress: () => void; uiId?: string; busy?: boolean}) {
  return (
    <Tap uiId={uiId} flat accessibilityRole="button" accessibilityLabel={line ? `${title}. ${line}` : title} onPress={onPress} disabled={busy} style={s.choice}>
      <View style={s.choiceWords}>
        <Text style={s.choiceTitle}>{title}</Text>
        {line ? <Text style={s.choiceLine}>{line}</Text> : null}
      </View>
      {busy ? <ActivityIndicator color={A.dim} size="small" /> : <Icon name="chevronRight" size={20} color={A.dim} />}
    </Tap>
  );
}

/** An error about the whole form (no connection, too many tries), above the button. */
export function FormError({text}: {text?: string | null}) {
  if (!text) return null;
  return (
    <Text style={s.formErr} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      {text}
    </Text>
  );
}

/** A quiet notice (why the phone is back at sign-in: a kick, a sign-out elsewhere). */
export function Notice({text}: {text?: string | null}) {
  if (!text) return null;
  return (
    <Text style={s.notice} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

/** A row of foot links under the button ("Back to sign in"). */
export function Foot({children}: {children: React.ReactNode}) {
  return <View style={s.foot}>{children}</View>;
}

export const as = StyleSheet.create({
  gap: {height: 12},
  // a big code to read out or type elsewhere (the device-code way, a pairing code)
  codeBox: {marginTop: 4, marginBottom: 14, paddingVertical: 16, paddingHorizontal: 16, borderRadius: R.control, backgroundColor: A.fieldBg, borderWidth: 1, borderColor: A.fieldEdge},
  codeLabel: {color: A.dim, fontSize: 13, fontWeight: '700', letterSpacing: 0.4},
  code: {color: A.text, fontSize: 32, fontWeight: '800', letterSpacing: 5, marginVertical: 6, fontVariant: ['tabular-nums']},
  body: {color: A.dim, fontSize: 15, lineHeight: 22},
  strong: {color: A.text, fontWeight: '700'},
  waitRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 16},
});

const s = StyleSheet.create({
  root: {flex: 1},
  body: {flexGrow: 1, justifyContent: 'center', alignItems: 'center'},
  panel: {
    width: '100%',
    maxWidth: 440,
    borderRadius: R.panel,
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 24,
    backgroundColor: A.panel,
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
  },
  panelSmall: {paddingHorizontal: 18, paddingTop: 18, paddingBottom: 20},
  footer: {width: '100%', maxWidth: 440, marginTop: 14, paddingHorizontal: 8},
  brand: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20},
  beam: {width: 22, height: 22},
  brandText: {color: A.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.35},
  segs: {flexDirection: 'row', padding: 3, borderRadius: R.control, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', marginBottom: 20},
  seg: {flex: 1, minHeight: 40, borderRadius: R.control - 3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8},
  segOn: {backgroundColor: 'rgba(255,255,255,0.13)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)'},
  segText: {color: A.dim, fontSize: 14.5, fontWeight: '600'},
  segTextOn: {color: A.text, fontWeight: '700'},
  titleBox: {marginBottom: 18},
  title: {color: A.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, lineHeight: 31, textAlign: 'left'},
  line: {color: A.dim, fontSize: 15, lineHeight: 22, marginTop: 6, textAlign: 'left'},
  field: {marginBottom: 14},
  labelRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24, marginBottom: 6},
  label: {color: A.label, fontSize: 14, fontWeight: '600', flexShrink: 1},
  box: {minHeight: 50, borderRadius: R.control, flexDirection: 'row', alignItems: 'center', backgroundColor: A.fieldBg, borderWidth: 1, borderColor: A.fieldEdge},
  boxOn: {borderColor: A.focus, borderWidth: 2, backgroundColor: 'rgba(255,255,255,0.08)'},
  boxErr: {borderColor: A.error},
  input: {flex: 1, minWidth: 0, minHeight: 48, paddingHorizontal: 14, paddingVertical: 0, color: A.text, fontSize: 16, textAlign: 'left'},
  reveal: {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 12, justifyContent: 'center'},
  revealText: {color: A.dim, fontSize: 13.5, fontWeight: '600'},
  help: {color: A.faint, fontSize: 13.5, lineHeight: 19, marginTop: 6, textAlign: 'left'},
  err: {color: A.error},
  meter: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8},
  bars: {flex: 1, flexDirection: 'row', gap: 4},
  bar: {flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)'},
  meterText: {fontSize: 13, fontWeight: '600', minWidth: 64, textAlign: 'right'},
  main: {
    minHeight: 50,
    borderRadius: R.control,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginTop: 6,
    experimental_backgroundImage: 'linear-gradient(115deg, rgb(63,216,164) 0%, rgb(127,140,255) 90%)',
  },
  mainOff: {opacity: 0.6},
  mainText: {color: '#061310', fontSize: 16, fontWeight: '700'},
  google: {minHeight: 50, borderRadius: R.control, flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#131314', borderWidth: 1, borderColor: '#8E918F', paddingHorizontal: 16},
  googleText: {color: '#E3E3E3', fontSize: 15.5, fontWeight: '600'},
  or: {flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 16},
  orLine: {flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.12)'},
  orText: {color: A.faint, fontSize: 13.5},
  linkTap: {minHeight: 44, justifyContent: 'center'},
  linkCompact: {minHeight: 24, justifyContent: 'center'},
  link: {color: A.link, fontSize: 14.5, fontWeight: '600'},
  check: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8, marginBottom: 8},
  tick: {width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: A.dim, alignItems: 'center', justifyContent: 'center', marginTop: 1},
  tickOn: {backgroundColor: A.mint, borderColor: A.mint},
  checkWords: {flex: 1},
  checkLabel: {color: A.text, fontSize: 15, lineHeight: 22},
  choice: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, borderRadius: R.control, backgroundColor: A.fieldBg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', marginBottom: 10},
  choiceWords: {flex: 1},
  choiceTitle: {color: A.text, fontSize: 16, fontWeight: '700'},
  choiceLine: {color: A.dim, fontSize: 13.5, lineHeight: 19, marginTop: 2},
  formErr: {color: A.error, fontSize: 14.5, lineHeight: 21, marginBottom: 10, textAlign: 'left'},
  notice: {color: '#f0d39a', fontSize: 14.5, lineHeight: 21, marginBottom: 14, textAlign: 'left'},
  foot: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, marginTop: 10},
});
