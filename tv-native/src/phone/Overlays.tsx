// The phone app's app-wide sheets and toasts, above every screen — the same
// overlay.ts / toast.ts the TV's components/Overlays.tsx draws, drawn the
// phone's way (bottom sheets, toasts over the tab bar).
import React, {useEffect, useRef} from 'react';
import {Animated, Linking, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {closeOverlay, useOverlay} from '../overlay';
import {useToasts} from '../toast';
import Sheet from './ui/Sheet';
import ListRow from './ui/Row';
import {colors, GUTTER, radius, TAB_H, TAB_INSET} from './theme';
import {tabBottom} from './ui/TabBar';
import XraySheet from './sheets/XraySheet';
import ReplaceSheet from './sheets/ReplaceSheet';
import RecommendSheet from './sheets/RecommendSheet';
import {JoinPartySheet, ReportSheet} from './sheets/SmallSheets';
import UpdateSheet from './sheets/UpdateSheet';
import ProfileMenu from './ui/ProfileMenu';

export default function PhoneOverlays() {
  const o = useOverlay();
  // a trailer: the YouTube app (or the browser) plays it — a phone has one
  useEffect(() => {
    if (o?.kind !== 'trailer') return;
    const id = o.ids[0];
    closeOverlay();
    if (id) {
      Linking.openURL(`vnd.youtube:${id}`).catch(() => Linking.openURL(`https://www.youtube.com/watch?v=${id}`).catch(() => {}));
    } else {
      const q = encodeURIComponent(`${o.title} ${o.year || ''} trailer`);
      Linking.openURL(`https://www.youtube.com/results?search_query=${q}`).catch(() => {});
    }
  }, [o]);
  return (
    <>
      <Sheet
        visible={o?.kind === 'actions'}
        onClose={closeOverlay}
        title={o?.kind === 'actions' ? o.title : undefined}
        sub={o?.kind === 'actions' ? o.sub : undefined}>
        {o?.kind === 'actions' ? (
          <>
            {o.body ? <Text style={s.body}>{o.body}</Text> : null}
            {o.items.map((it, i) => (
              <ListRow
                uiId={it.uiId || 'actions.pick'}
                key={`${i}-${it.label}`}
                title={it.label}
                detail={it.tag}
                danger={it.danger}
                onPress={() => {
                  closeOverlay();
                  // after the sheet has gone: an action that opens a sheet of its own must find none up
                  setTimeout(it.onPress, 0);
                }}
              />
            ))}
          </>
        ) : null}
      </Sheet>
      {o?.kind === 'replace' ? <ReplaceSheet libraryId={o.libraryId} title={o.title} context={o.context} onClose={() => {
        closeOverlay();
        o.onClose?.();
      }} /> : null}
      {o?.kind === 'xray' ? <XraySheet query={o.query} title={o.title} onClose={() => {
        closeOverlay();
        o.onClose?.();
      }} /> : null}
      {o?.kind === 'recommend' ? <RecommendSheet title={o.title} imdbId={o.imdbId || null} onClose={closeOverlay} /> : null}
      {o?.kind === 'join' ? <JoinPartySheet onClose={closeOverlay} /> : null}
      {o?.kind === 'report' ? <ReportSheet hint={o.hint} onClose={closeOverlay} /> : null}
      <UpdateSheet />
      <ProfileMenu />
      <Toasts />
    </>
  );
}

function Toasts() {
  const list = useToasts();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="none" style={[s.toasts, {bottom: tabBottom(insets.bottom) + TAB_H + TAB_INSET + 8}]}>
      {list.map(t => (
        <ToastPill key={t.id} text={t.text} glyph={t.glyph} />
      ))}
    </View>
  );
}

function ToastPill({text, glyph}: {text: string; glyph?: string}) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, {toValue: 1, duration: 200, useNativeDriver: true}).start();
  }, [a]);
  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={[s.toast, {opacity: a, transform: [{translateY: a.interpolate({inputRange: [0, 1], outputRange: [12, 0]})}]}]}>
      {glyph ? <Text style={s.glyph}>{glyph}</Text> : null}
      <Text style={s.toastText}>{text}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  body: {color: colors.textDim, fontSize: 15, lineHeight: 21, paddingHorizontal: GUTTER + 4, marginBottom: 8},
  toasts: {position: 'absolute', left: GUTTER, right: GUTTER, alignItems: 'center', gap: 8},
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 520,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radius.l,
    backgroundColor: 'rgba(22,24,44,0.96)',
    borderWidth: 1,
    borderColor: colors.glassEdge,
    elevation: 8,
  },
  glyph: {fontSize: 18},
  toastText: {color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1},
});
