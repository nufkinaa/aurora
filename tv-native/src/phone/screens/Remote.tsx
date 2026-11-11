// "Your TVs" on the phone — the website's remote (public/js/screens/remote.js, css/remote.css): a
// phone in the hand, the TV across the room. Full screen (no tab bar, as the site hides its nav),
// thumb-reachable, the same words:
//
//   top     close, the device picker ("Living room TV ▾") with its connection light, More
//           (rename the device, how it works, Sign in a TV); a banner under it when the line to
//           the server is down, the device went away, or its app is in the background
//   now     what plays: the artwork over a blur of itself, "Playing on …", the title and the
//           episode, a draggable scrub bar whose clock runs on between reports, ±10 / ±30, a big
//           play / pause that answers at once, Subtitles (with their timing −0.5 / +0.5 / Reset),
//           Audio, Next episode, Stop, Continue on this phone. Nothing playing: Continue
//           Watching, a tap plays it there. No device: how to get one.
//   pad     a touchpad (swipe = arrow, again every 70 dp; tap = OK; a ripple) or D-pad buttons
//           (Swipe / Buttons, remembered), Back, Play/Pause, Home
//   dock    Now playing / Touchpad, and the volume (− mute +, its level) when the device can
//
// Upright: one view at a time; sideways (and on a tablet): both side by side. The device picked
// last is remembered (else the one playing). Every press is a command over the app's one socket
// (remote/controller.ts), answered by the device; a light haptic tick under the thumb.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Image, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {StackActions, useRoute} from '@react-navigation/native';
import {api, artSrc, HeroItem} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {navRef} from '../../rootNav';
import {isOpen} from '../../realtime';
import {showToast} from '../../toast';
import {uiHit} from '../../telemetry';
import {command, Device, devicesHeard, getDevices, householdOn, playOn, useDevices, useDeviceState} from '../remote/controller';
import {continueHere} from '../remote/playOnTv'; // [play-on-tv]
import {PLAY_ON} from '../../remote/playOnWords'; // [play-on-tv]
import * as R from '../remote/remoteRules';
import RemoteIcon from '../remote/RemoteIcon';
import RemoteBackdrop from '../remote/RemoteBackdrop';
import RemoteSheet, {RmRow} from '../remote/RemoteSheet';
import Scrub from '../remote/Scrub';
import Touchpad from '../remote/Touchpad';
import {LIFT, PANE, RM} from '../remote/rmLook';
import Tap from '../ui/Tap';
import {PrimaryButton} from '../ui/Buttons';
import {phoneNative} from '../native';
import {pushPhone} from '../nav';
import {colors} from '../theme';

const LAST_KEY = 'aurora.phone.remote.last';
const VIEW_KEY = 'aurora.phone.remote.view';
const PAD_KEY = 'aurora.phone.remote.pad';
const store = {
  get: (k: string) => AsyncStorage.getItem(k).catch(() => null),
  set: (k: string, v: string) => {
    AsyncStorage.setItem(k, v).catch(() => {});
  },
};
const buzz = () => phoneNative.haptic('tick');

type Sheet = null | 'subs' | 'audio' | 'picker' | 'more' | 'rename';

/** A round glass button of the top row (close, More). */
function IconBtn({label, uiId, onPress, children}: {label: string; uiId: string; onPress: () => void; children: React.ReactNode}) {
  return (
    <Tap uiId={uiId} borderless accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={s.iconBtn}>
      {children}
    </Tap>
  );
}

/** A chip under the transport (.rm-chip). */
function Chip({label, icon, on, disabled, uiId, onPress}: {label: string; icon: React.ReactNode; on?: boolean; disabled?: boolean; uiId: string; onPress: () => void}) {
  return (
    <Tap
      uiId={uiId}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: !!disabled, selected: !!on}}
      disabled={disabled}
      onPress={() => {
        buzz();
        onPress();
      }}
      style={[s.chip, on && s.chipOn, disabled && s.dim]}>
      {icon}
      <Text style={s.chipText}>{label}</Text>
    </Tap>
  );
}

/** A segmented switch (.rm-seg): Now playing / Touchpad, Swipe / Buttons. */
function Seg<T extends string>({items, value, onPick, uiId, dock}: {items: [T, string][]; value: T; onPick: (v: T) => void; uiId: string; dock?: boolean}) {
  return (
    <View style={[s.seg, dock && s.segDock]} accessibilityRole="tablist">
      {items.map(([v, label]) => (
        <Tap key={v} uiId={uiId} flat accessibilityRole="tab" accessibilityState={{selected: v === value}} accessibilityLabel={label} onPress={() => onPick(v)} style={[s.segBtn, dock && s.segBtnDock, v === value && s.segOn]}>
          <Text style={[s.segText, v === value && s.segTextOn]} numberOfLines={1}>
            {label}
          </Text>
        </Tap>
      ))}
    </View>
  );
}

export default function Remote() {
  const insets = useSafeAreaInsets();
  const {width, height} = useWindowDimensions();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const list = useDevices();
  // [play-on-tv] opened by Play on TV (or a link): that device
  const asked = (useRoute().params as {deviceId?: string} | undefined)?.deviceId || null;
  const [deviceId, setDeviceId] = useState<string | null>(asked);
  const [last, setLast] = useState<string | null | undefined>(undefined); // undefined: not read yet
  const [view, setViewS] = useState<'now' | 'pad'>('now');
  const [pad, setPadS] = useState<'touch' | 'buttons'>('touch');
  const [online, setOnline] = useState(isOpen());
  const [sheet, setSheet] = useState<Sheet>(null);
  const [calm, setCalm] = useState(false);
  const [, setTick] = useState(0);
  const dev: Device | null = (deviceId && list.find(d => d.deviceId === deviceId)) || null;
  const st = useDeviceState(dev ? dev.deviceId : null);
  // (no device: nothing plays here — the hook keeps the last state it had for a device gone)
  const n = (dev && st?.now) || null;

  // ------------------------------------------------------------ remembered: device, view, pad
  useEffect(() => {
    let live = true;
    Promise.all([store.get(LAST_KEY), store.get(VIEW_KEY), store.get(PAD_KEY)]).then(([l, v, p]) => {
      if (!live) return;
      setLast(l || null);
      if (v === 'pad') setViewS('pad');
      if (p === 'buttons') setPadS('buttons');
    });
    AccessibilityInfo?.isReduceMotionEnabled?.()
      ?.then(v => live && setCalm(!!v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const setView = (v: 'now' | 'pad') => {
    setViewS(v);
    store.set(VIEW_KEY, v);
  };
  const setPad = (p: 'touch' | 'buttons') => {
    setPadS(p);
    store.set(PAD_KEY, p);
  };
  const select = useCallback((id: string) => {
    setDeviceId(id);
    store.set(LAST_KEY, id);
  }, []);
  // the device to show: kept while on; else the last one used, else the one playing, else the first
  useEffect(() => {
    if (last === undefined) return;
    const want = R.autoPick(list, deviceId, last, !!asked && deviceId === asked);
    if (want && want !== deviceId) select(want);
  }, [list, deviceId, last, asked, select]);

  // the line to the server (the banner and the light), looked at every 2 s as the site does
  useEffect(() => {
    const t = setInterval(() => setOnline(isOpen()), 2000);
    return () => clearInterval(t);
  }, []);

  // ------------------------------------------------------------ the clock
  // where the TV's clock is NOW: the last report moved on by the time since; a seek of ours holds
  // it for a moment (the TV's next report may still be from before it)
  const clock = useRef({position: 0, at: Date.now(), duration: 0, paused: true, buffering: false, nowId: null as string | null, holdUntil: 0, dragging: false});
  const [pendingPaused, setPendingPaused] = useState<boolean | null>(null);
  const [pendingMute, setPendingMute] = useState<boolean | null>(null);
  if (n) {
    const c = clock.current;
    const heardAt = getDevices().find(d => d.deviceId === dev?.deviceId)?.heardAt || Date.now();
    if (c.nowId !== n.id) {
      c.nowId = n.id;
      c.holdUntil = 0;
      c.position = n.position || 0;
      c.at = heardAt;
    } else if (Date.now() > c.holdUntil && !c.dragging) {
      c.position = n.position || 0;
      c.at = heardAt;
    }
    c.duration = n.duration || 0;
    c.buffering = !!n.buffering;
    c.paused = pendingPaused != null ? pendingPaused : !!n.paused;
  } else clock.current.nowId = null;
  const paused = n ? clock.current.paused : true;
  const pos = n ? R.livePos(clock.current, Date.now()) : 0;
  useEffect(() => {
    if (!n || paused) return;
    const t = setInterval(() => setTick(x => x + 1), 250);
    return () => clearInterval(t);
  }, [n, paused]);

  // ------------------------------------------------------------ talking to the device
  const cmd = useCallback(
    async (name: string, args: Record<string, unknown> = {}, o: {done?: string} = {}) => {
      if (!dev) {
        showToast('Pick a device first', '📺');
        return {ok: false} as {ok: boolean};
      }
      const r = await command(dev.deviceId, name, args);
      if (!r.ok) showToast(r.message || "That didn't work", r.error === 'slow-down' ? '✋' : '⚠️');
      else if (o.done) showToast(o.done, '📺');
      return r;
    },
    [dev],
  );
  const press = (key: string) => {
    buzz();
    cmd('key', {key});
  };
  const toggle = async () => {
    buzz();
    setPendingPaused(!paused);
    clock.current.position = pos;
    clock.current.at = Date.now();
    await cmd('toggle');
    setPendingPaused(null);
  };
  const skip = (by: number) => {
    buzz();
    clock.current.position = R.skipTo(pos, by, clock.current.duration);
    clock.current.at = Date.now();
    clock.current.holdUntil = Date.now() + 2500;
    setTick(x => x + 1);
    cmd('skip', {by});
  };
  const seek = (to: number) => {
    uiHit('remote.seek', 'touch');
    buzz();
    clock.current.position = to;
    clock.current.at = Date.now();
    clock.current.holdUntil = Date.now() + 3000;
    setTick(x => x + 1);
    cmd('seek', {to});
  };
  const vol = (dev && st?.volume) || null;
  const muted = pendingMute != null ? pendingMute : !!vol?.muted;
  const mute = async () => {
    buzz();
    setPendingMute(!muted);
    await cmd('mute', {on: !muted});
    setPendingMute(null);
  };

  // ------------------------------------------------------------ nothing playing: Continue Watching
  const [cw, setCw] = useState<HeroItem[] | null>(null);
  const [busyCw, setBusyCw] = useState<string | null>(null);
  const idleNow = !!dev && !n;
  useEffect(() => {
    if (!idleNow || cw || !profileId) return;
    let live = true;
    api
      .home(profileId)
      .then(h => live && setCw(R.idleItems(h.rows)))
      .catch(() => live && setCw([]));
    return () => {
      live = false;
    };
  }, [idleNow, cw, profileId]);
  const playCw = async (it: HeroItem) => {
    if (!dev) return;
    buzz();
    setBusyCw(it.id);
    const r = await playOn(dev, it as never, {position: R.cwPos(it)});
    setBusyCw(null);
    if (r.ok) setView('now');
  };

  // ------------------------------------------------------------ sheets
  const [delay, setDelay] = useState<number | null>(null);
  const nudge = async (by: number | 'reset') => {
    buzz();
    const cur = n?.subDelay || 0;
    const next = by === 'reset' ? 0 : R.nudged(delay != null ? delay : cur, by);
    setDelay(next);
    const r = await cmd('sub_delay', by === 'reset' ? {value: 0} : {by});
    if (!r.ok) setDelay(cur);
  };
  useEffect(() => setDelay(null), [n?.subDelay]);
  const [name, setName] = useState('');
  const saveName = async () => {
    const v = name.trim();
    setSheet(null);
    if (!dev || !v || v === dev.name) return;
    const r = await cmd('rename', {name: v});
    if (r.ok) showToast(`Renamed to ${v}`, '✏️');
  };

  const subRows: RmRow[] = n
    ? [
        {key: 'off', label: 'Off', on: !n.sub, onPress: () => (setSheet(null), cmd('sub', {id: null}, {done: 'Subtitles off'}))},
        ...n.subs.map(t => ({key: t.id, label: t.label || t.id, sub: t.lang ? t.lang.toUpperCase() : null, on: n.sub === t.id, onPress: () => (setSheet(null), cmd('sub', {id: t.id}, {done: 'Subtitles on'}))})),
      ]
    : [];
  const audioRows: RmRow[] = n
    ? n.audios.map(t => ({
        key: t.id,
        label: t.label || t.id,
        sub: t.lang ? t.lang.toUpperCase() : null,
        on: n.audio === t.id,
        onPress: () => {
          setSheet(null);
          if (t.id !== n.audio) cmd('audio', {id: t.id}, {done: 'Switching the audio…'});
        },
      }))
    : [];
  const pickRows: RmRow[] = list.map(d => ({
    key: d.deviceId,
    label: d.name,
    sub: R.pickerSub(d),
    icon: R.deviceKind(d),
    on: d.deviceId === dev?.deviceId,
    uiId: 'remote.device.pick',
    onPress: () => {
      setSheet(null);
      select(d.deviceId);
    },
  }));
  const moreRows: RmRow[] = [
    ...(dev ? [{key: 'rename', label: `Rename “${dev.name}”`, uiId: 'remote.rename', onPress: () => (setName(dev.name), setSheet('rename'))}] : []),
    {key: 'help', label: 'How it works', sub: 'Your phone controls the devices signed in to your profile', onPress: () => (setSheet(null), showToast(R.howItWorks(householdOn()), '📱'))},
    // a TV on its sign-in screen: its code, typed here (or its QR, scanned with the camera)
    {key: 'pair', label: 'Sign in a TV', sub: 'Type or scan the code on a TV’s screen', uiId: 'phone.remote.pair', onPress: () => (setSheet(null), pushPhone('PairTv', {code: null}))},
  ];

  // ------------------------------------------------------------ the frame
  const anyOn = list.length > 0;
  const state = R.stateOf(anyOn, n);
  const banner = R.bannerLine(online, deviceId, dev, anyOn);
  const dot = R.dotOf(online, dev);
  const land = width > height;
  const both = width >= 720 || (land && width >= 560);
  const short = land && height < 520;
  const steer = !dev || dev.caps?.navigate !== false;
  const volOk = R.volumeOk(dev);
  const close = () => {
    if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.pop());
  };
  const pic = n ? n.backdrop || n.poster || null : null;
  const artPic = n ? n.poster || n.backdrop || null : null;
  const wideArt = !!n && !n.poster && !!n.backdrop;
  const artH = Math.min(height * (short ? 0 : land ? 0.34 : height < 700 ? 0.24 : width <= 340 ? 0.18 : 0.34), 300);
  const pauseA = useRef(new Animated.Value(paused ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(pauseA, {toValue: paused ? 1 : 0, duration: calm ? 0 : 420, useNativeDriver: true}).start();
  }, [paused, calm, pauseA]);

  const playing = n && dev ? (
    <View style={[s.section, short && s.sectionShort]}>
      {short ? null : (
        <Animated.View
          style={[
            s.art,
            !artPic && s.artNone,
            wideArt ? {width: Math.min(width - 32, 420), aspectRatio: 16 / 9} : {height: artH, aspectRatio: 2 / 3},
            {transform: [{scale: pauseA.interpolate({inputRange: [0, 1], outputRange: [1, 0.94]})}]},
          ]}>
          {artPic ? <Image source={artSrc(artPic, wideArt ? Math.min(width - 32, 420) : (artH * 2) / 3).src || undefined} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Text style={s.artLetter}>{(n.showTitle || n.title || '?').trim().charAt(0).toUpperCase()}</Text>}
          <Animated.View style={[StyleSheet.absoluteFill, {backgroundColor: 'rgba(7,8,17,0.18)', opacity: pauseA}]} pointerEvents="none" />
        </Animated.View>
      )}
      <View style={s.meta}>
        <View style={s.eyebrow}>
          <View style={[s.eyeDot, paused && s.eyeDotPaused]} />
          <Text style={s.eyebrowText} numberOfLines={1}>
            {R.eyebrowOf({...n, paused}, dev).toUpperCase()}
          </Text>
        </View>
        <Text style={[s.title, short && s.titleShort]} numberOfLines={short ? 1 : 2} accessibilityRole="header">
          {n.showTitle || n.title || ''}
        </Text>
        {R.subOf(n) ? (
          <Text style={s.subtitle} numberOfLines={1}>
            {R.subOf(n)}
          </Text>
        ) : null}
      </View>
      <Scrub
        position={pos}
        duration={n.duration || 0}
        disabled={!n.canSeek || !n.duration}
        buffering={!!n.buffering}
        onDrag={held => (clock.current.dragging = held)}
        onSeek={seek}
      />
      <View style={s.transport}>
        <Tap uiId="remote.skip" borderless accessibilityRole="button" accessibilityLabel="Back 30 seconds" onPress={() => skip(-30)} style={[s.skip, short && s.skipShort]}>
          <RemoteIcon name="back" n={30} size={30} />
        </Tap>
        <Tap uiId="remote.skip" borderless accessibilityRole="button" accessibilityLabel="Back 10 seconds" onPress={() => skip(-10)} style={[s.skip, short && s.skipShort]}>
          <RemoteIcon name="back" n={10} size={30} />
        </Tap>
        <Tap uiId="remote.playpause" borderless accessibilityRole="button" accessibilityLabel={paused ? 'Play' : 'Pause'} onPress={toggle} style={[s.play, short && s.playShort]}>
          <RemoteIcon name={paused ? 'play' : 'pause'} size={short ? 32 : 38} color="#0b0c14" />
        </Tap>
        <Tap uiId="remote.skip" borderless accessibilityRole="button" accessibilityLabel="Forward 10 seconds" onPress={() => skip(10)} style={[s.skip, short && s.skipShort]}>
          <RemoteIcon name="fwd" n={10} size={30} />
        </Tap>
        <Tap uiId="remote.skip" borderless accessibilityRole="button" accessibilityLabel="Forward 30 seconds" onPress={() => skip(30)} style={[s.skip, short && s.skipShort]}>
          <RemoteIcon name="fwd" n={30} size={30} />
        </Tap>
      </View>
      <View style={s.chips}>
        <Chip uiId="remote.subtitles" label="Subtitles" icon={<RemoteIcon name="cc" size={20} />} on={!!n.sub} disabled={!n.subs.length} onPress={() => setSheet('subs')} />
        {n.audios.length > 1 ? <Chip uiId="remote.audio" label="Audio" icon={<RemoteIcon name="audio" size={20} />} onPress={() => setSheet('audio')} /> : null}
        {n.hasNext ? <Chip uiId="remote.next" label="Next episode" icon={<RemoteIcon name="next" size={20} />} onPress={() => cmd('next', {}, {done: 'Next episode'})} /> : null}
        <Chip uiId="remote.stop" label="Stop" icon={<RemoteIcon name="stop" size={18} />} onPress={() => cmd('stop', {}, {done: 'Stopped'})} />
        {/* [play-on-tv] the reverse: what the TV plays, on this phone, at its second */}
        <Chip uiId="remote.continuehere" label={PLAY_ON.continueHere('phone')} icon={<RemoteIcon name="cast" size={20} />} onPress={() => continueHere(dev, n)} />
      </View>
    </View>
  ) : null;

  const idle =
    dev && !n ? (
      <View style={[s.section, s.center]}>
        <View style={[s.glyph, short && s.glyphShort]}>
          <RemoteIcon name="tv" size={short ? 30 : 46} color="#b3a9ff" />
        </View>
        <Text style={[s.title, s.centerText]} numberOfLines={2}>{`Nothing playing on ${dev.name}`}</Text>
        <Text style={[s.subtitle, s.centerText]} numberOfLines={1}>
          {R.idleSub(dev)}
        </Text>
        {cw && cw.length ? (
          <>
            <Text style={s.cwHead}>CONTINUE WATCHING</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.cwRow} contentContainerStyle={s.cwRowIn} snapToInterval={short ? 150 : 178} decelerationRate="fast">
              {cw.map(it => {
                const pic2 = it.backdrop || it.cover || null;
                const p = it.progress;
                return (
                  <Tap key={it.id} uiId="remote.play" accessibilityRole="button" accessibilityLabel={`Play ${R.cwLabel(it)} on the TV`} onPress={() => playCw(it)} style={[s.cwCard, short && s.cwCardShort, busyCw === it.id && s.dim]}>
                    {pic2 ? <Image source={artSrc(pic2, short ? 140 : 168).src || undefined} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Text style={s.cwLetter}>{(it.showTitle || it.title || '?').charAt(0)}</Text>}
                    <View style={s.cwShade} pointerEvents="none" />
                    <Text style={s.cwLabel} numberOfLines={2}>
                      {R.cwLabel(it)}
                    </Text>
                    {p && p.duration ? (
                      <View style={s.cwBar}>
                        <View style={[s.cwBarIn, {width: `${R.share(p.position, p.duration) * 100}%`}]} />
                      </View>
                    ) : null}
                  </Tap>
                );
              })}
            </ScrollView>
          </>
        ) : null}
      </View>
    ) : null;

  const empty = !anyOn ? (
    <View style={[s.section, s.center]}>
      <View style={s.glyph}>
        <RemoteIcon name="remote" size={46} color="#b3a9ff" />
      </View>
      <Text style={[s.title, s.centerText]}>No TV is on</Text>
      <Text style={[s.subtitle, s.centerText, s.emptyText]}>{R.emptyLine(devicesHeard(), online, me?.name || '', householdOn())}</Text>
      {/* a TV on its sign-in screen: its code, typed here (or its QR, scanned with the camera) */}
      <Chip uiId="phone.remote.pair" label="Sign in a TV" icon={<RemoteIcon name="tv" size={20} />} onPress={() => pushPhone('PairTv', {code: null})} />
    </View>
  ) : null;

  const nowView = (
    <ScrollView style={s.view} contentContainerStyle={[s.viewIn, short && s.viewInShort]} showsVerticalScrollIndicator={false} key="now">
      {state === 'playing' ? playing : state === 'idle' ? idle : empty}
    </ScrollView>
  );

  // (sideways on a phone the Back / Play/Pause / Home row shares the height: a smaller ring)
  const dsize = Math.min(width * (both ? 0.4 : 0.78), 300, height * (short ? 0.4 : 0.4), short ? 230 : 300);
  const padView = (
    <View style={[s.view, s.padView, both && s.padViewBoth, short && s.padViewShort]} key="pad">
      {short ? null : <Seg uiId="remote.padmode" items={[['touch', 'Swipe'], ['buttons', 'Buttons']]} value={pad} onPick={setPad} />}
      <View style={[s.padArea, short && s.padAreaShort]}>
        {pad === 'touch' ? (
          <Touchpad onPress={k => (uiHit('remote.dpad', 'touch'), press(k))} steerable={steer} calm={calm} />
        ) : (
          <View style={[s.dpad, {width: dsize, height: dsize, borderRadius: dsize / 2}, !steer && s.dim]} pointerEvents={steer ? 'auto' : 'none'} accessibilityRole="none">
            <Tap uiId="remote.dpad" borderless accessibilityRole="button" accessibilityLabel="Up" onPress={() => press('up')} style={[s.dkey, {left: dsize / 3, top: 0, width: dsize / 3, height: dsize / 3}]}>
              <RemoteIcon name="arrow" deg={0} size={26} />
            </Tap>
            <Tap uiId="remote.dpad" borderless accessibilityRole="button" accessibilityLabel="Left" onPress={() => press('left')} style={[s.dkey, {left: 0, top: dsize / 3, width: dsize / 3, height: dsize / 3}]}>
              <RemoteIcon name="arrow" deg={-90} size={26} />
            </Tap>
            <Tap uiId="remote.dpad" borderless accessibilityRole="button" accessibilityLabel="OK" onPress={() => press('ok')} style={[s.ok, {left: dsize / 3 + dsize * 0.0267, top: dsize / 3 + dsize * 0.0267, width: dsize / 3 - dsize * 0.0533, height: dsize / 3 - dsize * 0.0533, borderRadius: dsize / 6}]}>
              <Text style={s.okText}>OK</Text>
            </Tap>
            <Tap uiId="remote.dpad" borderless accessibilityRole="button" accessibilityLabel="Right" onPress={() => press('right')} style={[s.dkey, {left: (2 * dsize) / 3, top: dsize / 3, width: dsize / 3, height: dsize / 3}]}>
              <RemoteIcon name="arrow" deg={90} size={26} />
            </Tap>
            <Tap uiId="remote.dpad" borderless accessibilityRole="button" accessibilityLabel="Down" onPress={() => press('down')} style={[s.dkey, {left: dsize / 3, top: (2 * dsize) / 3, width: dsize / 3, height: dsize / 3}]}>
              <RemoteIcon name="arrow" deg={180} size={26} />
            </Tap>
          </View>
        )}
      </View>
      <View style={s.keys}>
        <Tap uiId="remote.back" flat accessibilityRole="button" accessibilityLabel="Back" onPress={() => press('back')} style={[s.key, short && s.keyShort]}>
          <RemoteIcon name="backKey" size={22} />
          <Text style={s.keyText}>Back</Text>
        </Tap>
        <Tap uiId="remote.playpause" flat accessibilityRole="button" accessibilityLabel="Play or pause" onPress={toggle} style={[s.key, short && s.keyShort]}>
          <RemoteIcon name={paused ? 'play' : 'pause'} size={22} />
          <Text style={s.keyText}>Play/Pause</Text>
        </Tap>
        <Tap uiId="remote.home" flat accessibilityRole="button" accessibilityLabel="Home" onPress={() => press('home')} style={[s.key, short && s.keyShort]}>
          <RemoteIcon name="home" size={22} />
          <Text style={s.keyText}>Home</Text>
        </Tap>
      </View>
    </View>
  );

  const level = vol && typeof vol.level === 'number' ? vol.level : null;
  const volume = volOk ? (
    <View style={s.vol} accessibilityRole="none" accessibilityLabel="Volume" accessibilityHint={R.volumeScope(vol?.scope)}>
      <Tap uiId="remote.volume" borderless accessibilityRole="button" accessibilityLabel="Volume down" accessibilityHint={R.volumeScope(vol?.scope)} onPress={() => (buzz(), cmd('volume', {step: -1}))} onLongPress={() => showToast(R.volumeScope(vol?.scope), '🔊')} style={[s.volBtn, short && s.volBtnShort]}>
        <RemoteIcon name="volDown" size={22} />
      </Tap>
      <Tap uiId="remote.mute" borderless accessibilityRole="button" accessibilityLabel={muted ? 'Unmute' : 'Mute'} accessibilityState={{selected: muted}} onPress={mute} onLongPress={() => showToast(R.volumeScope(vol?.scope), '🔊')} style={[s.volBtn, short && s.volBtnShort, muted && s.volOn]}>
        <RemoteIcon name="mute" size={22} color={muted ? '#ffb0b0' : colors.text} />
      </Tap>
      <Tap uiId="remote.volume" borderless accessibilityRole="button" accessibilityLabel="Volume up" accessibilityHint={R.volumeScope(vol?.scope)} onPress={() => (buzz(), cmd('volume', {step: 1}))} onLongPress={() => showToast(R.volumeScope(vol?.scope), '🔊')} style={[s.volBtn, short && s.volBtnShort]}>
        <RemoteIcon name="volUp" size={22} />
      </Tap>
      {level != null ? (
        <View style={s.level} pointerEvents="none">
          <View style={[s.levelIn, {width: `${Math.round((muted ? 0 : level) * 100)}%`}]} />
        </View>
      ) : null}
    </View>
  ) : null;

  const showDock = state !== 'empty' && (!both || volOk);
  return (
    <View style={[s.root, {paddingLeft: insets.left, paddingRight: insets.right}]}>
      <RemoteBackdrop pic={pic} calm={calm} />
      <View style={[s.top, short && s.topShort, {paddingTop: insets.top + (short ? 4 : 8)}]}>
        <IconBtn uiId="remote.close" label="Close the remote" onPress={close}>
          <RemoteIcon name="down" size={22} />
        </IconBtn>
        <View style={s.pickWrap}>
        <Tap uiId="remote.device.open" accessibilityRole="button" accessibilityLabel={dev ? `Device: ${dev.name}. Choose another` : 'Choose a device'} onPress={() => list.length && setSheet('picker')} style={s.picker}>
          <RemoteIcon name={dev ? R.deviceKind(dev) : 'tv'} size={20} color="#b3a9ff" />
          <Text style={s.pickName} numberOfLines={1}>
            {dev ? dev.name : anyOn ? 'Choose a device' : 'Your TVs'}
          </Text>
          <View style={{opacity: 0.85, marginLeft: -2}}>
            <RemoteIcon name="down" size={16} />
          </View>
          <View style={[s.dot, dot === 'live' ? s.dotLive : dot === 'off' ? s.dotOff : null]} />
        </Tap>
        </View>
        <IconBtn uiId="remote.more" label="More" onPress={() => setSheet('more')}>
          <RemoteIcon name="more" size={22} />
        </IconBtn>
      </View>
      {banner ? (
        <View style={s.banner} accessibilityLiveRegion="polite">
          <Text style={s.bannerText}>{banner}</Text>
        </View>
      ) : null}
      <View style={[s.body, both && s.bodyBoth, state === 'empty' && both && s.bodyEmptyBoth]}>
        {both ? (
          <>
            <View style={{flex: 1.15}}>{nowView}</View>
            {state === 'empty' ? null : <View style={{flex: 1, alignItems: 'center'}}>{padView}</View>}
          </>
        ) : view === 'pad' && state !== 'empty' ? (
          padView
        ) : (
          nowView
        )}
      </View>
      {showDock ? (
        <View style={[s.dock, both && s.dockBoth, short && s.dockShort, {marginBottom: (short ? 6 : 10) + insets.bottom}]}>
          {both ? null : (
            <Seg
              dock
              uiId="remote.view"
              items={[
                ['now', 'Now playing'],
                ['pad', 'Touchpad'],
              ]}
              value={view}
              onPick={setView}
            />
          )}
          {volume}
        </View>
      ) : (
        <View style={{height: insets.bottom + 10}} />
      )}

      <RemoteSheet visible={sheet === 'subs'} title="Subtitles" rows={subRows} onClose={() => setSheet(null)}
        foot={
          n && n.sub ? (
            <View style={s.delay} accessibilityLabel="Subtitle timing">
              <Text style={s.delayLabel}>Timing</Text>
              <Tap uiId="remote.subdelay" accessibilityRole="button" accessibilityLabel="Subtitles earlier" onPress={() => nudge(-0.5)} style={s.delayBtn}>
                <Text style={s.delayBtnText}>−0.5</Text>
              </Tap>
              <Text style={s.delayVal}>{R.delayText(delay != null ? delay : n.subDelay || 0)}</Text>
              <Tap uiId="remote.subdelay" accessibilityRole="button" accessibilityLabel="Subtitles later" onPress={() => nudge(0.5)} style={s.delayBtn}>
                <Text style={s.delayBtnText}>+0.5</Text>
              </Tap>
              <Tap uiId="remote.subdelay" accessibilityRole="button" accessibilityLabel="Reset the timing" onPress={() => nudge('reset')} style={s.delayBtn}>
                <Text style={s.delayBtnText}>Reset</Text>
              </Tap>
            </View>
          ) : null
        }
      />
      <RemoteSheet visible={sheet === 'audio'} title="Audio" rows={audioRows} onClose={() => setSheet(null)} />
      <RemoteSheet visible={sheet === 'picker'} title="Your devices" rows={pickRows} closeLabel="Cancel" onClose={() => setSheet(null)} />
      <RemoteSheet visible={sheet === 'more'} title={dev ? dev.name : 'Remote'} rows={moreRows} onClose={() => setSheet(null)} />
      <RemoteSheet visible={sheet === 'rename'} title={`Name this ${dev && dev.kind === 'tv' ? 'TV' : 'device'}`} onClose={() => setSheet(null)}>
        <View style={s.rename}>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={40}
            autoFocus
            selectTextOnFocus
            autoComplete="off"
            accessibilityLabel="Name"
            returnKeyType="done"
            onSubmitEditing={saveName}
            style={s.input}
            placeholderTextColor={colors.textFaint}
          />
          <PrimaryButton uiId="remote.rename" label="Save" onPress={saveName} />
        </View>
      </RemoteSheet>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  dim: {opacity: 0.45},
  center: {alignItems: 'center'},
  centerText: {textAlign: 'center'},
  // top: close · the device · more (48 | 1fr | 48, 8 apart, 8 10 4)
  top: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingBottom: 4, minHeight: 60},
  topShort: {minHeight: 50},
  iconBtn: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', ...PANE},
  pickWrap: {flex: 1, minWidth: 0, alignItems: 'center'},
  picker: {flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingLeft: 12, paddingRight: 14, borderRadius: 999, maxWidth: '100%', ...LIFT},
  pickName: {color: colors.text, fontSize: 15.7, fontWeight: '700', flexShrink: 1},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: RM.amber},
  dotLive: {backgroundColor: RM.live, boxShadow: '0 0 6px rgba(61,220,151,0.55)'},
  dotOff: {backgroundColor: RM.off},
  banner: {marginTop: 4, marginHorizontal: 16, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 14, backgroundColor: 'rgba(240,180,74,0.16)', borderWidth: 1, borderColor: 'rgba(240,180,74,0.35)'},
  bannerText: {color: '#ffe2ad', fontSize: 13.8, fontWeight: '600', textAlign: 'center'},
  body: {flex: 1, minHeight: 0, paddingHorizontal: 16},
  bodyBoth: {flexDirection: 'row', gap: 24, paddingHorizontal: 24},
  bodyEmptyBoth: {justifyContent: 'center'},
  view: {flex: 1},
  viewIn: {flexGrow: 1, justifyContent: 'center', paddingTop: 8, paddingBottom: 12},
  section: {gap: 14},
  // sideways on a phone (.rm-view gap 10, 4 0 18): the chips stay above the dock
  sectionShort: {gap: 10},
  viewInShort: {paddingTop: 4, paddingBottom: 18},
  padViewShort: {gap: 10, paddingTop: 4, paddingBottom: 18},
  // now playing
  art: {alignSelf: 'center', borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', boxShadow: '0 30px 60px rgba(0,0,0,0.55)'},
  // no picture: the site's violet-to-teal tile with the title's letter
  artNone: {backgroundColor: 'rgba(139,123,255,0.4)', experimental_backgroundImage: 'linear-gradient(160deg, rgba(139,123,255,0.5) 0%, rgba(64,196,186,0.25) 100%)'},
  artLetter: {color: 'rgba(255,255,255,0.85)', fontSize: 64, fontWeight: '800'},
  meta: {alignItems: 'center'},
  eyebrow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4},
  eyeDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: RM.live, boxShadow: '0 0 10px rgba(61,220,151,0.8)'},
  eyeDotPaused: {backgroundColor: RM.amber, boxShadow: 'none'},
  eyebrowText: {color: 'rgba(255,255,255,0.78)', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.6},
  title: {color: colors.text, fontSize: 23, fontWeight: '800', lineHeight: 28, letterSpacing: -0.2, textAlign: 'center'},
  titleShort: {fontSize: 20, lineHeight: 25},
  subtitle: {color: colors.textDim, fontSize: 15.2, fontWeight: '600', marginTop: 4, textAlign: 'center'},
  transport: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12},
  skip: {width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', ...PANE},
  skipShort: {width: 46, height: 46, borderRadius: 23},
  play: {width: 84, height: 84, borderRadius: 42, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', boxShadow: '0 16px 36px rgba(0,0,0,0.45), 0 0 0 6px rgba(255,255,255,0.08)'},
  playShort: {width: 68, height: 68, borderRadius: 34},
  chips: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8},
  chip: {flexDirection: 'row', alignItems: 'center', gap: 7, height: 42, paddingHorizontal: 15, borderRadius: 999, ...PANE},
  chipOn: {backgroundColor: 'rgba(139,123,255,0.28)', experimental_backgroundImage: undefined, borderColor: 'rgba(139,123,255,0.6)'},
  chipText: {color: colors.text, fontSize: 14.4, fontWeight: '700'},
  // nothing playing / no device
  glyph: {width: 92, height: 92, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4, ...PANE, boxShadow: '0 20px 50px rgba(0,0,0,0.35)'},
  glyphShort: {width: 60, height: 60, borderRadius: 18},
  emptyText: {maxWidth: 300, lineHeight: 22},
  cwHead: {alignSelf: 'stretch', color: colors.textDim, fontSize: 12.5, fontWeight: '800', letterSpacing: 1.5, marginTop: 10},
  cwRow: {alignSelf: 'stretch', marginHorizontal: -16},
  cwRowIn: {gap: 10, paddingHorizontal: 16, paddingBottom: 10, paddingTop: 2},
  cwCard: {width: 168, aspectRatio: 16 / 10, borderRadius: 14, overflow: 'hidden', ...LIFT},
  cwCardShort: {width: 140},
  cwShade: {...StyleSheet.absoluteFill, experimental_backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.82) 100%)'},
  cwLetter: {...StyleSheet.absoluteFill, color: '#fff', fontSize: 32, fontWeight: '800', textAlign: 'center', textAlignVertical: 'center'},
  cwLabel: {position: 'absolute', left: 10, right: 10, bottom: 12, color: '#fff', fontSize: 12.8, fontWeight: '700', lineHeight: 15.4},
  cwBar: {position: 'absolute', left: 10, right: 10, bottom: 6, height: 3, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden'},
  cwBarIn: {height: '100%', backgroundColor: RM.accent},
  // the pad
  padView: {gap: 14, paddingTop: 8, paddingBottom: 12},
  padViewBoth: {maxWidth: 460, width: '100%', justifyContent: 'center'},
  padArea: {flex: 1, minHeight: 220, justifyContent: 'center'},
  padAreaShort: {minHeight: 120},
  dpad: {alignSelf: 'center', ...PANE, boxShadow: '0 24px 60px rgba(0,0,0,0.32)'},
  dkey: {position: 'absolute', alignItems: 'center', justifyContent: 'center', borderRadius: 999},
  ok: {position: 'absolute', alignItems: 'center', justifyContent: 'center', ...LIFT, boxShadow: '0 10px 22px rgba(0,0,0,0.42), 0 2px 5px rgba(0,0,0,0.3)'},
  okText: {color: colors.text, fontSize: 16.8, fontWeight: '800'},
  keys: {flexDirection: 'row', gap: 10},
  key: {flex: 1, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center', gap: 3, ...PANE},
  keyShort: {height: 50},
  keyText: {color: colors.text, fontSize: 11.8, fontWeight: '700'},
  // segmented switches
  seg: {flexDirection: 'row', alignSelf: 'center', padding: 4, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.28)', ...{borderWidth: 1, borderColor: 'rgba(255,255,255,0.075)', borderTopColor: 'rgba(255,255,255,0.36)'}},
  segDock: {backgroundColor: 'transparent', borderWidth: 0, padding: 0, flexShrink: 1},
  segBtn: {height: 36, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center'},
  segBtnDock: {height: 42, paddingHorizontal: 12},
  segOn: {...LIFT},
  segText: {color: RM.segOff, fontSize: 13.8, fontWeight: '700'},
  segTextOn: {color: colors.text},
  // the dock
  dock: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginHorizontal: 16, padding: 6, borderRadius: 999, ...PANE, boxShadow: '0 16px 40px rgba(0,0,0,0.35)'},
  dockBoth: {alignSelf: 'center', justifyContent: 'center', minWidth: 220},
  dockShort: {padding: 5},
  vol: {flexDirection: 'row', alignItems: 'center', gap: 2},
  volBtn: {width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)'},
  volBtnShort: {width: 38, height: 38},
  volOn: {backgroundColor: 'rgba(255,93,93,0.22)'},
  level: {position: 'absolute', left: 21, right: 21, bottom: -4, height: 3, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden'},
  levelIn: {height: '100%', backgroundColor: RM.accent},
  // sheets
  delay: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 24, marginTop: 6, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)'},
  delayLabel: {flex: 1, color: colors.textDim, fontSize: 13.8, fontWeight: '700'},
  delayBtn: {height: 38, minWidth: 52, paddingHorizontal: 10, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)'},
  delayBtnText: {color: colors.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums']},
  delayVal: {minWidth: 58, textAlign: 'center', color: colors.text, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums']},
  rename: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4},
  input: {flex: 1, minWidth: 0, height: 48, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(0,0,0,0.3)', color: colors.text, fontSize: 16},
});
