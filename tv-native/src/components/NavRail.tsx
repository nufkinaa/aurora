// The LEFT NAV RAIL — Deviation 1. Replaces the top bar on every screen except
// the profile gate.
//
// Structural, not cosmetic. A top bar had to share the UP key with "move a row",
// and that ambiguity is what sent focus to the nav for no reason. The rail owns
// its own axis: LEFT from the leftmost thing on the page opens it, RIGHT or Back
// closes it, and UP/DOWN never mean anything but "move a row".
//
// Two states, per SPEC/01-components.md §4.6:
//   collapsed 72dp — a PASSIVE strip. Nothing in it is focusable: the 26dp mark
//     and one dot per section, the active one filled.
//   expanded 240dp — the site's real word labels, drawn OVER the page. It does
//     not reflow content (PINS P1: a full relayout per D-pad press, and it would
//     move the focused item out from under the ring mid-animation).
//
// The LEFT gesture is bound HERE, once, at screen level — not per row. Screens
// only mark their leftmost focusables with `edgeLeft`; focus.ts turns that into
// the one fact this handler reads.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  Easing,
  BackHandler,
  TVFocusGuideView,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import Focusable from './Focusable';
import Icon, {IconName} from './Icon';
import {useApp} from '../AppContext';
import {imgSrc} from '../api';
import {atLeftEdge, captureFocus, clearRailOpener, focusJustMoved, noteRail, setRailOpener, useTVKeys} from '../focus';
import {goSection, useMe, useNewUnseen, NAV_SECTIONS, NavSection} from '../navSection';
import {isLite} from '../perfTier';
import theme from '../theme';

const {colors, focus, motion, nav, radius, spacing} = theme;

// `.nav-logo .logo-mark` — a conic gradient, so it is baked (tools/gen_logo.py).
// Two files per density (@1x-@4x), each rendered at exactly the pixels the
// rail draws - 34dp closed, 40dp open - so the TV never rescales the mark.
const LOGO = require('../assets/logo-mark.png');
const LOGO_OPEN = require('../assets/logo-mark-open.png');

const EASE = Easing.bezier(...(focus.ease as unknown as [number, number, number, number]));

// Vertical safe inset, 5% of a 540dp panel (PINS P2). Both states use it, so the
// mark sits at the same y whether the rail is open or shut.
const PAD_Y = 27;
// How far the panel's right edge bleeds into the page before it is gone.
const FEATHER = 48;
// `.nav-item` 0.95rem = 15.2px, reading tier x1.0 (components.css:53).
const ITEM_TEXT = 15;

type Item = {key: NavSection | 'profile'; label: string; icon?: IconName; iconSize?: number; withLabel?: boolean};

// One flat traversal order, so UP/DOWN and the wrap at both ends have a single
// list to index into. `.nav-spacer` is a <span> with no focusable class
// (index.html:65), so nothing sits between Games and the gear.
//
// The gear carries its word in the open panel, "Settings", in the same type as
// every other row — it used to be the only foot item drawn as a bare glyph
// (Mi TV, 2026-10-09).
const ITEMS: Item[] = [
  ...NAV_SECTIONS.map(s =>
    s.key === 'settings'
      ? {key: s.key, label: 'Settings', icon: s.icon, iconSize: s.iconSize, withLabel: true}
      : {key: s.key, label: s.label, icon: s.icon, iconSize: s.iconSize},
  ),
  {key: 'profile', label: 'Profile'},
];
const FOOT_FROM = NAV_SECTIONS.findIndex(s => s.foot);

type NodeRef = {requestTVFocus?: () => void} | null;

// The rail's hue, moving (elia, 2026-10-07: "make them move a bit and be
// dynamic"). Two soft glows — the violet high on the left, the green low —
// each one baked disc tinted and drifted by transforms on the native driver:
// a slow figure, 16 s and 21 s, so the two never repeat together. Nothing is
// repainted; the box composites two textures. Mounted only while the panel
// is, and still on a box the perf tier judged slow.
const GLOW = require('../assets/glow.png');
function RailHues() {
  const a = useRef(new Animated.Value(0)).current;
  const b = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isLite()) return;
    const run = (v: Animated.Value, ms: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {toValue: 1, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false}),
          Animated.timing(v, {toValue: 0, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false}),
        ]),
      );
    const la = run(a, 8000);
    const lb = run(b, 10500);
    la.start();
    lb.start();
    return () => {
      la.stop();
      lb.stop();
    };
  }, [a, b]);
  return (
    <View style={styles.hues} pointerEvents="none">
      <Animated.Image
        source={GLOW}
        fadeDuration={0}
        style={[
          styles.hueViolet,
          {
            opacity: a.interpolate({inputRange: [0, 1], outputRange: [0.26, 0.46]}),
            transform: [
              {translateX: a.interpolate({inputRange: [0, 1], outputRange: [-14, 26]})},
              {translateY: b.interpolate({inputRange: [0, 1], outputRange: [-10, 34]})},
              {scale: a.interpolate({inputRange: [0, 1], outputRange: [1, 1.14]})},
            ],
          },
        ]}
      />
      <Animated.Image
        source={GLOW}
        fadeDuration={0}
        style={[
          styles.hueGreen,
          {
            opacity: b.interpolate({inputRange: [0, 1], outputRange: [0.18, 0.36]}),
            transform: [
              {translateX: b.interpolate({inputRange: [0, 1], outputRange: [22, -18]})},
              {translateY: a.interpolate({inputRange: [0, 1], outputRange: [16, -30]})},
              {scale: b.interpolate({inputRange: [0, 1], outputRange: [1.08, 0.96]})},
            ],
          },
        ]}
      />
      {/* back to the panel's own colour at the right edge, so the feather
          beside it still melts into the page without a seam */}
      <View style={styles.huesEdge} />
    </View>
  );
}

export default function NavRail({
  active,
  disabled,
}: {
  active: NavSection;
  // A modal owns the screen. useTVEventHandler is GLOBAL — every mounted handler
  // hears every key — so without this the rail opened on a LEFT press from
  // inside a panel that was supposed to have focus trapped, and then took focus
  // itself. §5.8(a): while a modal is up, the rail is unreachable by design.
  disabled?: boolean;
}) {
  const navigation = useNavigation();
  const {profileId, switchProfile} = useApp();
  const me = useMe(profileId);
  const newUnseen = useNewUnseen();

  const [open, setOpen] = useState(false);
  // True while the panel is sliding OUT. It used to vanish in one frame —
  // "like a glitch" (elia) — because a departing panel still held the nav's
  // focusables and Android could focus-search into one mid-exit and strand
  // focus. The fix is not to skip the animation but to make the rows
  // unfocusable for the ride (Focusable.focusDisabled) and hand focus back
  // to the page BEFORE the slide starts.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const slide = useRef(new Animated.Value(0)).current;
  // Who had focus before the rail took it, so closing can give it straight back.
  const restore = useRef<(() => void) | null>(null);
  // The panel's focusables, for the wrap at either end.
  const items = useRef<NodeRef[]>([]);
  const at = useRef(0);
  // Switching profile SIGNS THE TV OUT (the unlock token is dropped, and every
  // profile needs its password typed on a remote to get back in) — too costly
  // for a single stray OK on the pill at the bottom of the rail, which sits one
  // wrap-around press from the top item. First press arms ("Press again"),
  // second press within the window switches. Anything else disarms.
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmSwitch = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirmSwitch(false);
  }, []);
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    disarmSwitch();
    // Focus goes home FIRST: the page owns the remote for the whole exit.
    restore.current?.();
    restore.current = null;
    Animated.timing(slide, {
      toValue: 0,
      duration: motion.med,
      easing: EASE,
      useNativeDriver: true,
      isInteraction: false,
    }).start(() => {
      closingRef.current = false;
      setClosing(false);
      setOpen(false);
    });
  }, [slide, disarmSwitch]);

  // The no-animation exits (navigating away, losing the screen): the panel
  // must not linger over a screen that is changing under it.
  const instantClose = useCallback(() => {
    closingRef.current = false;
    setClosing(false);
    setOpen(false);
    slide.setValue(0);
  }, [slide]);

  // Announce the open panel to focus.ts, so per-screen key handlers (the grid
  // up-escapes) go quiet while the rail owns the remote. Effect-based, so every
  // way the panel closes — RIGHT, Back, blur, navigation — retracts it.
  useEffect(() => {
    if (!open || closing) return;
    noteRail(true);
    return () => noteRail(false);
  }, [open, closing]);

  useEffect(() => {
    if (!open || closing) return;
    // Slides in over --t-med; close() runs the mirror image out.
    Animated.timing(slide, {
      toValue: 1,
      duration: motion.med,
      easing: EASE,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }, [open, slide]);

  const onTV = useCallback(
    (evt: {eventType: string}) => {
      const t = evt.eventType;
      if (closingRef.current) return;
      if (!open) {
        // LEFT from the leftmost focusable of the page. Anywhere else the press
        // is the page's own business and the platform has already moved focus.
        //
        // focusJustMoved: NOT if this very press is the one that carried focus
        // to the edge. The native focus move and this JS event race, and when
        // the focus event wins, `atLeftEdge()` is already true for the press
        // that landed there — so one press both moved a card AND opened the
        // rail (the reported "one press acts twice near the side panel"). A
        // press made FROM the edge moves no focus and passes untouched.
        // 120ms: wide enough to cover the native-focus-event → JS-key-event gap
        // of one press, narrow enough that a deliberate two-key sequence
        // (DOWN, then LEFT toward the rail) is not swallowed — and closing a
        // trap (picker, panel, the rail itself) restores focus, which also
        // stamps the clock, so a long window made LEFT briefly deaf after
        // every dismissal.
        if (t === 'left' && atLeftEdge() && !focusJustMoved(120)) {
          restore.current = captureFocus();
          setOpen(true);
        }
        return;
      }
      // RIGHT leaves the rail; the panel traps it so the platform cannot also
      // move focus into the page behind.
      if (t === 'right') {
        close();
        return;
      }
      // The two ends wrap (§5.4). The panel traps UP and DOWN, so at an end the
      // platform does nothing and this is the only thing that moves focus.
      //
      // NOT when this very press already moved focus. The native focus move and
      // this key event race, and when the focus event lands first an UP from
      // Home has already put focus on Search by the time we read `at` — so the
      // wrap fired on top of it and the press landed on the profile pill, with
      // Search reachable only by wrapping the other way (Mi TV, 2026-10-06).
      // A press made AT the end moves no focus and wraps as before.
      if (focusJustMoved(120)) return;
      if (t === 'up' && at.current === 0) items.current[ITEMS.length - 1]?.requestTVFocus?.();
      else if (t === 'down' && at.current === ITEMS.length - 1) items.current[0]?.requestTVFocus?.();
    },
    [open, close],
  );
  // The gates — this screen must be the live one and no trap may be up — belong
  // to useTVKeys, which every global handler in the app goes through.
  const live = useTVKeys(onTV, {deaf: disabled});

  // While this screen is live and the panel is closed, a screen handler may
  // open the rail by request (Home's hero: UP).
  useEffect(() => {
    if (!live || open || disabled) return;
    const fn = () => {
      restore.current = captureFocus();
      setOpen(true);
    };
    setRailOpener(fn);
    return () => clearRailOpener(fn);
  }, [live, open, disabled]);

  // Closing on blur matters: navigating from a rail item leaves this screen with
  // the rail still open behind it, and coming back would show it expanded with
  // focus somewhere else.
  useEffect(() => {
    if (!live && open) {
      restore.current = null;
      instantClose();
    }
  }, [live, open, instantClose]);


  useEffect(() => {
    if (!open || !live) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, live, close]);

  // Nothing at all while a modal owns the screen — not even the collapsed strip,
  // which would otherwise sit on top of the panel.
  if (disabled) return null;

  const go = (key: NavSection | 'profile') => {
    if (key === 'profile' && !confirmSwitch) {
      // Arm. The pill relabels itself; a second press inside the window is the
      // real switch, and moving anywhere else disarms.
      setConfirmSwitch(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmSwitch(false), 4000);
      return;
    }
    // Do NOT restore focus on the way out: this screen is being left. Restoring
    // would hand focus to an element that is about to unmount.
    restore.current = null;
    instantClose();
    disarmSwitch();
    if (key === 'profile') switchProfile();
    else goSection(navigation as never, active, key);
  };

  return (
    <>
      {/* Collapsed: passive artwork, no focus targets, fading out as the panel
          arrives so the two marks never both read at once. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.strip, {opacity: slide.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}>
        <Scrim width={nav.rail} />
        <Image source={LOGO} style={styles.mark} />
        <View style={styles.dots}>
          {NAV_SECTIONS.map(s => (
            <View key={s.key} style={[styles.dot, s.key === active && styles.dotOn]} />
          ))}
        </View>
      </Animated.View>

      {open ? (
        <Animated.View
          style={[
            styles.panel,
            {transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [-(nav.railOpen + FEATHER), 0]})}]},
          ]}>
          {/* The opaque body, then the feather that melts its edge into the
              page — the panel View itself paints nothing. */}
          <View style={styles.panelBody} />
          {/* The panel's body: its hue fades in on the same `slide` value that
              moves the panel (native driver), so it lands with the nav. */}
          <Animated.View pointerEvents="none" style={[styles.panelBody, {opacity: slide}]}>
            <RailHues />
          </Animated.View>
          <Svg pointerEvents="none" style={styles.panelFeather} width={FEATHER} height="100%">
            <Defs>
              <LinearGradient id="railFeather" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#0a0b14" stopOpacity="1" />
                <Stop offset="0.45" stopColor="#0a0b14" stopOpacity="0.55" />
                <Stop offset="1" stopColor="#0a0b14" stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={FEATHER} height="100%" fill="url(#railFeather)" />
          </Svg>
          {/* autoFocus alone is NOT enough — a focus guide only redirects focus
              that is already entering it, it does not claim focus on mount. The
              claim below lands on the active section, which is both the site's
              "you are here" and the most useful place to start. */}
          <TVFocusGuideView
            autoFocus
            trapFocusLeft
            trapFocusRight
            trapFocusUp
            trapFocusDown
            style={styles.panelInner}>
            {/* `.nav-logo` — not focusable (index.html:52). */}
            <View style={styles.logo}>
              <Image source={LOGO_OPEN} style={[styles.mark, styles.markOpen]} />
              <Text style={styles.wordmark}>Aurora</Text>
            </View>
            {ITEMS.map((it, i) => {
              const row = (
                <NavItem
                  key={it.key}
                  label={it.label}
                  icon={it.icon}
                  iconSize={it.iconSize}
                  withLabel={it.withLabel}
                  dot={it.key === 'new' && newUnseen}
                  focusDisabled={closing}
                  profile={it.key === 'profile' ? me?.avatar || '🍿' : undefined}
                  profileImage={it.key === 'profile' ? me?.avatarImage || null : undefined}
                  profileColor={it.key === 'profile' ? me?.color : undefined}
                  name={
                    it.key === 'profile'
                      ? confirmSwitch
                        ? 'Press again'
                        : me?.name || 'Profile'
                      : undefined
                  }
                  on={it.key === active}
                  claimFocus={it.key === active}
                  ref={(n: NodeRef) => {
                    items.current[i] = n;
                  }}
                  onFocused={f => {
                    if (!f) return;
                    at.current = i;
                    // Focus moved to ANOTHER item: an armed switch disarms.
                    if (it.key !== 'profile' && confirmTimer.current) disarmSwitch();
                  }}
                  onPress={() => go(it.key)}
                />
              );
              // `.nav-spacer { flex: 1 }` — on a rail it pushes the gear and the
              // profile pill to the bottom.
              return i === FOOT_FROM ? (
                <React.Fragment key={`${it.key}-foot`}>
                  <View style={styles.spacer} />
                  {row}
                </React.Fragment>
              ) : (
                row
              );
            })}
          </TVFocusGuideView>
        </Animated.View>
      ) : null}
    </>
  );
}

// `.nav`'s scrim (components.css:15-19), the same two stops with the axis rotated
// 90°: it has to fade away from the edge it hangs on.
function Scrim({width}: {width: number}) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id="railScrim" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#080910" stopOpacity="0.9" />
          <Stop offset="1" stopColor="#080910" stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width={width} height="100%" fill="url(#railScrim)" />
    </Svg>
    </View>
  );
}

// `.nav-item:focus { color: #0b0c14; background: #fff }` — a focused item does
// not merely get a ring, it INVERTS. That is the most recognisable thing about
// the site's nav, and it needs the label colour to flip, so this holds focus
// state. Eight items that live as long as the panel; the no-re-render rule is
// about the ninety cards in a shelf.
function NavItem({
  label,
  icon,
  iconSize,
  withLabel,
  profile,
  profileImage,
  profileColor,
  name,
  on,
  claimFocus,
  focusDisabled,
  dot,
  onFocused,
  onPress,
  ref,
}: {
  label: string;
  icon?: IconName;
  iconSize?: number;
  // Draw the label beside the icon instead of the icon alone.
  withLabel?: boolean;
  // A small accent dot after the label — "there is something new here".
  dot?: boolean;
  profile?: string;
  profileImage?: string | null;
  profileColor?: string | null;
  name?: string;
  on?: boolean;
  claimFocus?: boolean;
  focusDisabled?: boolean;
  onFocused: (focused: boolean) => void;
  onPress: () => void;
  ref?: (node: NodeRef) => void;
}) {
  const [focused, setFocused] = useState(false);
  // `.nav-profile` is a --surface pill with a plain white ring on focus
  // (components.css:77-95) — it does not invert.
  if (profile != null) {
    return (
      <Focusable
        round
        ref={ref as never}
        edgeLeft
        focusDisabled={focusDisabled}
        accessibilityLabel={name}
        hasTVPreferredFocus={claimFocus}
        onFocusChange={onFocused}
        onPress={onPress}
        style={styles.profile}>
        <View style={[styles.avatar, {backgroundColor: profileColor || colors.surfaceHover}]}>
          {profileImage ? (
            <Image
              source={imgSrc(profileImage) || undefined}
              style={styles.avatarImg}
              resizeMode="cover"
              fadeDuration={0}
            />
          ) : (
            <Text style={styles.avatarGlyph}>{profile}</Text>
          )}
        </View>
        <Text style={styles.profileName} numberOfLines={1}>
          {name}
        </Text>
      </Focusable>
    );
  }
  // Unfocused labels used to take colors.textDim (#9aa1b5), which read fine
  // on flat black but went muddy over the aurora glow (elia). Near-white with
  // a hair of hierarchy below the active item's pure white, plus a dark cast
  // shadow (below) to lift the glyphs off the brightest bands.
  const fg = focused ? colors.bg : on ? colors.text : 'rgba(255,255,255,0.92)';
  return (
    <Focusable
      round
      ref={ref as never}
      focusDisabled={focusDisabled}
      // Every item in the rail is at the screen's left edge, so LEFT from any of
      // them is a no-op rather than a page press.
      edgeLeft
      // A focused item is a WHITE fill, so the ring takes the 3dp --bg gap
      // (§4.1) rather than being dropped. NavBar used ring="none" here, which
      // cost the separation shadow the white-on-white case needs. Always on
      // rather than conditional: its opacity is what fades, and swapping ring
      // type on the same frame focus lands is a flicker.
      light
      accessibilityLabel={label}
      hasTVPreferredFocus={claimFocus}
      highlightColor={colors.white}
      onFocusChange={f => {
        setFocused(f);
        onFocused(f);
      }}
      onPress={onPress}
      style={[styles.item, on && !focused && styles.itemOn]}>
      {icon && !withLabel ? <Icon name={icon} size={iconSize || 18} color={fg} /> : null}
      {icon && !withLabel ? null : (
        <View style={styles.itemRow}>
          {icon ? <Icon name={icon} size={iconSize || 18} color={fg} /> : null}
          <Text
            style={[styles.itemText, {color: fg}, !focused && styles.itemTextLift]}
            numberOfLines={1}>
            {label}
          </Text>
          {dot ? <View style={[styles.newDot, focused && styles.newDotOnLight]} /> : null}
        </View>
      )}
    </Focusable>
  );
}

const styles = StyleSheet.create({
  // `.nav` is position: fixed with z-index 100 (components.css:3-12); the
  // governing dimension becomes a width.
  strip: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: nav.rail,
    paddingTop: PAD_Y,
    alignItems: 'center',
    zIndex: 100,
  },
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    // railOpen of opaque body + the feather that bleeds it into the page.
    width: nav.railOpen + FEATHER,
    zIndex: 101,
  },
  // `.nav.solid` (components.css:25-26), rotated onto the edge the rail hangs
  // on. OPAQUE rather than 0.97: measured on the Streamer, 3% of a 243-white
  // shelf heading still reads as ghost text on a near-black panel. The 1px
  // hairline the site draws is gone — instead of a hard cut the body hands
  // off to `panelFeather`, a gradient that melts the edge into the app
  // (elia: "fade into and blend into the rest, for a clean look").
  panelBody: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: nav.railOpen,
    backgroundColor: '#0a0b14',
    // The room's hue instead of the moving aurora curtains (elia,
    // 2026-10-07: "ditch our attempt of the aurora effect and just add the
    // hues we put in other places"): the menus' violet from the top-left and
    // green from the foot, still — nothing animates, nothing to pay for. The
    // first layer brings the right edge back to the panel's own colour so the
    // feather beside it still melts into the page without a seam.
    experimental_backgroundImage:
      'linear-gradient(165deg, rgba(104,86,226,0.20) 0%, rgba(10,11,20,0) 46%, rgba(70,200,150,0.12) 100%)',
    overflow: 'hidden',
  },
  // the moving glows live inside the body and are clipped to it
  hues: {position: 'absolute', top: 0, left: 0, bottom: 0, width: nav.railOpen},
  huesEdge: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: Math.round(nav.railOpen * 0.5),
    experimental_backgroundImage: 'linear-gradient(90deg, rgba(10,11,20,0) 0%, rgba(10,11,20,1) 100%)',
  },
  hueViolet: {position: 'absolute', top: -150, left: -170, width: 440, height: 440, tintColor: '#6856e2'},
  hueGreen: {position: 'absolute', bottom: -190, left: -150, width: 460, height: 460, tintColor: '#46c896'},
  panelFeather: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: nav.railOpen,
    width: FEATHER,
  },
  // Expanded insets its content to the 48dp safe edge, so no label and nothing
  // focusable is ever inside the action-safe band (§4.6).
  panelInner: {
    flex: 1,
    width: nav.railOpen, // not the panel's — nothing focusable in the feather
    paddingLeft: 48,
    paddingRight: 16,
    paddingVertical: PAD_Y,
    gap: 4,
  },
  // 26dp icon box, P18 x1.0 (components.css:39-41). Centred in the 72dp strip,
  // so it spans x = 23-49.
  // Drawn larger than the site's 26px (elia, 2026-10-08: it read as low-res —
  // 52 physical pixels on a 1080p panel). Each size has its own pixel-exact
  // asset per density (see LOGO above); the radius keeps the tile's 8/26 proportion.
  // The bare mark on a transparent square (docs/brand/tools/build.py), as the
  // site's `.logo-mark` - no tile behind it, so no radius and no box glow
  // (elia, 2026-10-09: "the logo should be just it").
  mark: {width: 34, height: 34},
  markOpen: {width: 40, height: 40},
  // `.nav-logo { margin-right: 20px }` becomes a margin-bottom on a rail; gap 10
  // is the site's own (components.css:32,36).
  logo: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10},
  // 1.3rem = 20.8px -> the --fs-row slot, 20dp (00-tokens §3.1(ii); the spec's
  // own table says 21, which its verifier finding 7 corrects to 20).
  wordmark: {color: colors.text, fontSize: 23, fontWeight: '800', letterSpacing: 0.4},
  // One dot per section, the active one filled — the vertical form of the
  // capsule's mark-over-dots. Redundant wayfinding: the screen itself says where
  // you are, which is why losing them to overscan costs nothing.
  dots: {marginTop: 10, gap: spacing.sm, alignItems: 'center'},
  // Like the hero's dots (elia, 2026-10-07): the active one is a lit pill,
  // taller since the rail runs down the screen, with the same soft glow.
  dot: {width: 5, height: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.3)'},
  dotOn: {height: 16, backgroundColor: '#ffffff', boxShadow: '0 0 10px rgba(255,255,255,0.5)'},
  // `.nav-item { padding: 8px 16px }` at x1.0, with the 48dp focus floor: the
  // site's own item computes to 38.8px, so the floor bites.
  item: {
    alignSelf: 'stretch',
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
  },
  // `.nav-item.active { color: --text; background: --surface }`.
  itemOn: {backgroundColor: colors.surface},
  itemText: {fontSize: ITEM_TEXT, fontWeight: '600'},
  itemRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  newDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent},
  newDotOnLight: {backgroundColor: colors.accentStrong},
  // The cast shadow that keeps unfocused labels legible over the aurora.
  // Dropped while focused: dark-on-white with a dark halo looks smudged.
  itemTextLift: {
    textShadowColor: 'rgba(8,9,16,0.9)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 6,
  },
  spacer: {flex: 1},
  // `.nav-profile { padding: 5px 14px 5px 6px; gap: 10px }` at x1.0.
  profile: {
    alignSelf: 'stretch',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 5,
    paddingLeft: 6,
    paddingRight: 14,
    backgroundColor: colors.surface,
  },
  // `.avatar` 30px — an icon box, fixed at x1.0 (P18), with a 16dp glyph.
  avatar: {width: 30, height: 30, borderRadius: 999, alignItems: 'center', justifyContent: 'center'},
  avatarGlyph: {fontSize: 16},
  avatarImg: {width: '100%', height: '100%', borderRadius: 999},
  // `.nav-profile` 0.9rem = 14.4px, at the 14dp reading floor.
  profileName: {color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1},
});
