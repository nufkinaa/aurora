// The shared empty and error states.
//
// `components.css:1093-1102` gives `.empty` a glyph, a message and NO focusable
// element. On a TV that is a dead remote, so the deviation §6.2 states is applied:
// both states take a REQUIRED action button, it carries `hasTVPreferredFocus`, and
// it registers as the screen's focus fallback so anything that unmounts the
// focused element lands here rather than nowhere.
//
// `components.css` has no error primitive at all — verified, there is no `.error`,
// `.failed` or `.retry` rule. §6.3 constructs one from the two pieces the site
// does have: `.pw-error`'s colour and weight (`components.css:880-884`), and the
// API client's convention of surfacing the server's own message
// (`public/js/api.js:13-19`) rather than a status line.
import React, {useRef} from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Btn from './Btn';
import {useFocusFallback} from '../focus';
import theme from '../theme';

const {colors, spacing} = theme;

export function Empty({
  glyph,
  message,
  detail,
  actionLabel,
  onAction,
  edgeLeft = true,
  claimFocus = true,
}: {
  glyph: string;
  message: string;
  // a second, quieter line under it (the message then reads as its heading — the site's h2 + p)
  detail?: string;
  // false: the button does not take focus as it appears (a panel that owns focus is
  // open beside it — Browse's filters); it is still where focus goes if it is lost
  claimFocus?: boolean;
  actionLabel: string;
  onAction: () => void;
  // Default true because every screen that has a rail wants LEFT to reach it.
  // The profile gate has NO rail, and there `edgeLeft` would claim a press that
  // should stay on the page — so it passes false.
  edgeLeft?: boolean;
}) {
  const action = useRef(null);
  useFocusFallback(action);
  return (
    <View style={styles.wrap}>
      <Text style={styles.glyph}>{glyph}</Text>
      <Text style={detail ? styles.heading : styles.message}>{message}</Text>
      {detail ? <Text style={styles.message}>{detail}</Text> : null}
      <Btn uiId="state.action" ref={action} label={actionLabel} hasTVPreferredFocus={claimFocus} edgeLeft={edgeLeft} onPress={onAction} />
    </View>
  );
}

export function ErrorState({
  message,
  detail,
  actionLabel = 'Retry',
  onAction,
  edgeLeft = true,
}: {
  message: string;
  // The server's own `error` string when it sent one: routes reject with a
  // message written for the viewer, which is far more use than "400 /api/home".
  detail?: string;
  actionLabel?: string;
  onAction: () => void;
  edgeLeft?: boolean;
}) {
  const action = useRef(null);
  useFocusFallback(action);
  return (
    <View style={styles.wrap}>
      <Text style={styles.glyph}>⚠️</Text>
      <Text style={styles.error}>{message}</Text>
      {detail ? <Text style={styles.message}>{detail}</Text> : null}
      <Btn uiId="state.action" ref={action} label={actionLabel} hasTVPreferredFocus edgeLeft={edgeLeft} onPress={onAction} />
    </View>
  );
}

const styles = StyleSheet.create({
  // `.empty { padding: 90px var(--page-x); text-align: center }` → 45dp vertical
  // (×0.505, it is page rhythm rather than a control) and the safe inset
  // horizontally. The button sits 14dp below the message.
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 45,
    paddingHorizontal: spacing.pageX,
    gap: 14,
  },
  // `.empty .glyph { font-size: 3rem }` = 48px → 35dp at the display factor; it is
  // artwork, not reading-tier type.
  glyph: {fontSize: 35, marginBottom: -2},
  message: {color: colors.textDim, fontSize: 16, textAlign: 'center'},
  heading: {color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center'},
  // `.pw-error`'s #ff7a7a at weight 700, raised to the 16dp reading tier.
  error: {color: '#ff7a7a', fontSize: 16, fontWeight: '700', textAlign: 'center'},
});
