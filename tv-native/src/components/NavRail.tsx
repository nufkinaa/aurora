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
//
// TWO IMPLEMENTATIONS OF THE DRAWING (render.ts `nativeOn.rail`, off by default;
// docs/qa/native-lab/). Read once at startup, it picks either today's JS — the
// two Animated.Views below with the SVG scrim, untouched but for the QA hooks
// (inert outside a QA variant) — or the Fabric component AuroraRailPanel
// mounted in the same two places (src/specs/AuroraRailPanelNativeComponent.ts →
// AuroraRailPanelView.kt): it draws the strip's scrim itself and runs the
// 280 ms slide on the UI thread, from this component's own `open` / `closing`
// state. The open panel's glass pane is the same RN child in both (`pane`
// below). EVERYTHING ELSE IS THIS
// FILE IN BOTH: the key logic (LEFT-at-edge, RIGHT, the wrap, focusJustMoved),
// the traps, focus capture / restore, arm-to-switch, and the items — the same
// `NavItem`s inside the same focus guide, the same mark and dots.
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
import {atLeftEdge, captureFocus, clearRailOpener, focusJustMoved, noteOwnFocusMove, noteRail, pressMovedFocus, setRailOpener, useTVKeys} from '../focus';
import {goSection, useMe, useNewUnseen, NAV_SECTIONS, NavSection} from '../navSection';
import {isLite} from '../perfTier';
import {isMid, traceValue} from '../qa';
import {traceDerived, useTraces} from '../qaExtra';
import {nativeOn} from '../render';
import AuroraRailPanel, {SlideEndEvent} from '../specs/AuroraRailPanelNativeComponent';
import {CHOSEN_WEIGHT, glassPane, ink, well} from '../glass';
import theme from '../theme';

const {colors, focus, motion, nav, radius, spacing} = theme;

// `.nav-logo .logo-mark` — a conic gradient, so it is baked (tools/gen_logo.py).
// Two files per density (@1x-@4x), each rendered at exactly the pixels the
// rail draws - 28dp closed, 36dp open - so the TV never rescales the mark.
const LOGO = require('../assets/logo-mark.png');
const LOGO_OPEN = require('../assets/logo-mark-open.png');

const EASE = Easing.bezier(...(focus.ease as unknown as [number, number, number, number]));

// Vertical safe inset, 5% of a 540dp panel (PINS P2). Both states use it, so the
// mark sits at the same y whether the rail is open or shut.
const PAD_Y = 27;
// The room beside the 240 dp of rows for the pane's shadow to fall into the
// page (it was the feather's 48 - the panel is still 288 wide, RailMath.PANEL).
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

// nativeOn.rail: one link per mounted rail, shared by its strip and its panel.
let railLinks = 0;

// THE OPEN PANEL IS A PANE OF GLASS (glass.ts, docs/glass-tv.md): a floating
// dark capsule with a rim of light, the chosen section in a well inside it -
// the tvOS tab bar, stood on its side. It is ONE plain view, the first child of
// the sliding panel in both implementations (the native panel view paints
// nothing of its own any more), so the two cannot drift apart.
//
// Before, the panel was a flat near-black body from the screen's edge with the
// room's violet and green drifting in it (two glows on the native driver) and a
// 48 dp feather into the page. The hues were asked for (elia, 2026-10-07) when
// the rail was the only place that carried them; the new material is neutral on
// purpose - the page and the pictures bring the colour, and white words read
// the same over all of it. Nothing in the pane moves: the two loops are gone.
//
// Everything of the glass but its body is ONE baked picture laid over the pane
// (tools/gen_glass_edge.py): the soft shadow outside it, and inside it the rim,
// the glow under the rim and the sheen. The panel slides in over the page, and
// a blurred boxShadow, a stack of gradients and a three-colour round border are
// all drawn again on every frame of that; a round box and a picture are not.
// 48 dp of shadow on every side of the pane; what falls off the screen is never
// drawn.
//
// The pane STANDS ON THE SCREEN'S FOOT (it floated 11 dp above it): in those
// 11 dp and round its two foot corners the page went on - the tops of the next
// row of posters, "My downloads" - right under the profile pill (two judges,
// 2026-11-10). A mask in the page's colour would have been a new layer and a
// visible band (the page is a gradient there); the pane running to the foot is
// the same one box and the same one picture, a little shorter.
const PANE_EDGE = require('../assets/glass-pane-edge.png');
// The pane inside the 240 dp panel: 16 dp round the rows (which sit at 48..224
// and from PAD_Y down), so its corner (38) is concentric with a row's (22).
const PANE_X = 32;
const PANE_Y = 11; // from the top only
const SHADOW_ROOM = 48;

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
  // QA traces (tools/tv-bench/tv-pixel-diff/PROTOCOL.md §4): `[anim] … rail.slide / rail.strip`
  // while the receiver has tracing on. With nativeOn.rail the native strip writes them.
  useTraces(
    () => (nativeOn.rail ? [] : [traceValue('rail.slide', slide), traceDerived('rail.strip', slide, v => 1 - v)]),
    [slide],
  );
  const link = useRef(`rail-${++railLinks}`).current;
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
    // (nativeOn.rail: the native strip runs the slide out from `closing`, then onSlideEnd)
    if (nativeOn.rail) return;
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

  // nativeOn.rail: what the timing's callback above does, when the native slide has run out.
  const onSlideEnd = useCallback((e: {nativeEvent: SlideEndEvent}) => {
    if (e.nativeEvent.open || !closingRef.current) return;
    closingRef.current = false;
    setClosing(false);
    setOpen(false);
  }, []);

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
    // (nativeOn.rail: the native strip runs the slide in from `open`)
    if (nativeOn.rail) return;
    // Slides in over --t-med; close() runs the mirror image out.
    // (QA `freeze on,mid`: the slide in stops half way, to be captured still)
    if (isMid()) {
      Animated.timing(slide, {toValue: 0.5, duration: motion.med, easing: EASE, useNativeDriver: true, isInteraction: false}).start();
      return;
    }
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
        // pressMovedFocus: the same, for a key held longer than 120ms — JS
        // only hears the key come UP, the focus engine moved on its way down.
        if (t === 'left' && atLeftEdge() && !focusJustMoved(120) && !pressMovedFocus()) {
          restore.current = captureFocus();
          noteOwnFocusMove();
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
      if (focusJustMoved(120) || pressMovedFocus()) return;
      const to = t === 'up' && at.current === 0 ? ITEMS.length - 1 : t === 'down' && at.current === ITEMS.length - 1 ? 0 : -1;
      if (to < 0 || !items.current[to]?.requestTVFocus) return;
      noteOwnFocusMove();
      items.current[to]?.requestTVFocus?.();
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
      noteOwnFocusMove();
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

  // The strip's mark and dots, and the panel's focus guide with the items: the
  // same elements in both implementations; only the views that hold them differ.
  const marks = (
    <>
      <Image source={LOGO} style={styles.mark} />
      <View style={styles.dots}>
        {NAV_SECTIONS.map(s => (
          <View key={s.key} style={[styles.dot, s.key === active && styles.dotOn]} />
        ))}
      </View>
    </>
  );
  // autoFocus alone is NOT enough — a focus guide only redirects focus
  // that is already entering it, it does not claim focus on mount. The
  // claim below lands on the active section, which is both the site's
  // "you are here" and the most useful place to start.
  const guide = (
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
            uiId={NAV_UI[it.key]}
            label={it.label}
            icon={it.icon}
            iconSize={it.iconSize}
            withLabel={it.withLabel}
            dot={it.key === 'new' && newUnseen}
            // ...and not focusable while the panel is shut either: at a cold
            // start Android's first focus search ran before Home's hero had
            // mounted, found these rows (off-screen but focusable), and the
            // rail came up open on its own (lab build, 2026-10-09 - a race
            // the real app can lose too). LEFT-at-edge and the hero's UP open
            // the panel by state, then `claimFocus` lands on a row.
            focusDisabled={closing || !open}
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
  );

  // The glass: the pane's body, then its baked edge over it. Under the rows,
  // and nothing in it takes a key or a touch.
  const pane = (
    <>
      <View style={styles.pane} pointerEvents="none" />
      <Image source={PANE_EDGE} resizeMode="stretch" fadeDuration={0} style={styles.paneEdge} />
    </>
  );

  if (nativeOn.rail) {
    return (
      <>
        <AuroraRailPanel part="strip" link={link} open={open} closing={closing} onSlideEnd={onSlideEnd} pointerEvents="none" style={[styles.strip]}>
          {marks}
        </AuroraRailPanel>
        {open ? (
          <AuroraRailPanel part="panel" link={link} lite={isLite()} style={styles.panel}>
            {pane}
            {guide}
          </AuroraRailPanel>
        ) : null}
      </>
    );
  }

  return (
    <>
      {/* Collapsed: passive artwork, no focus targets, fading out as the panel
          arrives so the two marks never both read at once. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.strip, {opacity: slide.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}>
        <Scrim width={nav.rail} />
        {marks}
      </Animated.View>

      {open ? (
        <Animated.View
          style={[
            styles.panel,
            {transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [-(nav.railOpen + FEATHER), 0]})}]},
          ]}>
          {/* The glass pane, then the rows — the panel View itself paints nothing. */}
          {pane}
          {guide}
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
//
// Three states, and they do not share a colour:
//   focused  the white fill with dark words and the ring (unchanged)
//   chosen   the section this screen is: a WELL pressed into the glass, its word
//            and icon full white and heavier (ink.chosen, CHOSEN_WEIGHT) - on the
//            darker well the brightest words in the pane at rest. They were
//            ink.on, the accent mixed with white, and read as switched off
//            beside the resting white labels (two judges, 2026-11-10).
//   resting  white words on the glass
// [analytics] which control each rail item is — uiId (docs/analytics.md)
const NAV_UI: Record<string, string> = {search: 'nav.search', home: 'nav.home', movies: 'nav.movies', shows: 'nav.shows', list: 'nav.mylist'}; // uiId
Object.assign(NAV_UI, {ai: 'nav.ai', settings: 'nav.settings', profile: 'nav.profile'}); // uiId
NAV_UI.calendar = 'nav.calendar'; // uiId (the Calendar, after AI)
function NavItem({
  uiId,
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
  uiId?: string;
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
        uiId={uiId}
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
  // White words on the glass (16.6:1); the chosen one white too, heavier, in its
  // well. The cast shadow the labels carried over the old moving hues is gone
  // with the hues.
  const fg = focused ? colors.bg : on ? ink.chosen : ink.text;
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
      uiId={uiId}
      onPress={onPress}
      style={styles.item}>
      {on && !focused ? <View style={styles.well} pointerEvents="none" /> : null}
      {icon && !withLabel ? <Icon name={icon} size={iconSize || 18} color={fg} /> : null}
      {icon && !withLabel ? null : (
        <View style={styles.itemRow}>
          {icon ? <Icon name={icon} size={iconSize || 18} color={fg} /> : null}
          <Text
            style={[styles.itemText, on && !focused && styles.itemTextChosen, {color: fg}]}
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
    // railOpen for the rows + the room the pane's shadow falls into the page.
    width: nav.railOpen + FEATHER,
    zIndex: 101,
  },
  // The glass pane. OPAQUE, not the recipe's 94 %: there is no blur behind a TV
  // panel and nothing dims the page under the rail, and measured on the
  // Streamer 3 % of a 243-white shelf heading already read as ghost text under
  // the labels. Its edge is a rim of light and a soft shadow now, where the old
  // body handed off to a feather.
  pane: {
    position: 'absolute',
    top: PANE_Y,
    bottom: 0,
    left: PANE_X,
    width: nav.railOpen - PANE_X,
    borderTopLeftRadius: 38,
    borderTopRightRadius: 38,
    ...glassPane,
  },
  // 48 dp outside the pane at its top and its sides (the file is 304 dp wide:
  // 208 + 2 x 48), and cut where the screen ends
  paneEdge: {
    position: 'absolute',
    top: PANE_Y - SHADOW_ROOM,
    bottom: 0,
    left: PANE_X - SHADOW_ROOM,
    width: nav.railOpen - PANE_X + 2 * SHADOW_ROOM,
    height: undefined,
  },
  // Expanded insets its content to the 48dp safe edge, so no label and nothing
  // focusable is ever inside the action-safe band (§4.6).
  panelInner: {
    flex: 1,
    width: nav.railOpen, // not the panel's — nothing focusable in the feather
    paddingLeft: 48,
    paddingRight: 16,
    paddingVertical: PAD_Y,
    // 3, and the rows' 44 floor below (were 4 and 48): with Calendar the panel holds
    // nine rows, and 27+46+9x48+10x4+27 = 572dp ran off a 540dp panel — the gear and
    // the profile pill went under its foot. 27+46+9x44+10x3+27 = 526.
    gap: 3,
  },
  // 26dp icon box, P18 x1.0 (components.css:39-41). Centred in the 72dp strip,
  // so it spans x = 23-49.
  // Drawn larger than the site's 26px (elia, 2026-10-08: it read as low-res —
  // 52 physical pixels on a 1080p panel). Each size has its own pixel-exact
  // asset per density (see LOGO above); the radius keeps the tile's 8/26 proportion.
  // The bare mark on a transparent square (docs/brand/tools/build.py), as the
  // site's `.logo-mark` - no tile behind it, so no radius and no box glow
  // (elia, 2026-10-09: "the logo should be just it").
  // Optically centred over the dots: the beam's mass sits on its flat left
  // side, so a box-centred mark read as standing left of them (measured on
  // the Mi TV: box centre 71.5 of 72, mass ~62). Nudged a seventh of its width.
  mark: {width: 28, height: 28, transform: [{translateX: 4}]},
  // Open: no nudge (nothing to centre over) - the mark's left edge sits on the
  // rows' text edge instead, see `logo`.
  markOpen: {width: 36, height: 36, transform: [{translateX: 0}]},
  // `.nav-logo { margin-right: 20px }` becomes a margin-bottom on a rail; gap 10
  // is the site's own (components.css:32,36). marginLeft 16 = the rows' own
  // paddingHorizontal, so the mark lines up with "Home", "Movies"... (elia,
  // 2026-10-09: "when the navbar is open the logo should be aligned with the
  // other elements").
  logo: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10, marginLeft: 16},
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
    minHeight: 44, // (see panelInner's gap: nine rows on 540dp)
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
  },
  // `.nav-item.active`: the chosen section's well (it was a --surface fill).
  well,
  itemText: {fontSize: ITEM_TEXT, fontWeight: '600'},
  itemTextChosen: {fontWeight: CHOSEN_WEIGHT},
  itemRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  newDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent},
  newDotOnLight: {backgroundColor: colors.accentStrong},
  spacer: {flex: 1},
  // `.nav-profile { padding: 5px 14px 5px 6px; gap: 10px }` at x1.0.
  // marginTop 6: the focused Settings row's ring (scaled, 3dp outside the row) sat ON
  // the pill's top edge (Mi TV, 2026-11-10). The spacer above Settings gives it.
  profile: {
    alignSelf: 'stretch',
    marginTop: 6,
    minHeight: 44,
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
