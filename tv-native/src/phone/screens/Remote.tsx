// "Your TVs" on the phone — the website's #/remote ("unique look, cool and
// very usable", elia): pick a TV, then
//
//   what is on        the title, where it is, play / pause, ±10 s, Next
//   the pad           a round glass D-pad with OK in the middle, Back and Home
//   the sound         − / + and mute (the TV's own volume)
//   the tracks        subtitles and audio, as the TV lists them
//
// Every press is a command over the app's one socket (remote/controller.ts),
// answered by the TV; a press the TV refuses says why. A light haptic tick
// confirms each press, as a real remote's click would.
import React, {useEffect, useState} from 'react';
import {Image, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {imgSrc} from '../../api';
import {openActions} from '../../overlay';
import {showToast} from '../../toast';
import {command, Device, useDevices, useDeviceState} from '../remote/controller';
import {BackBar} from '../ui/PageHead';
import {ChipButton} from '../ui/Buttons';
import Tap from '../ui/Tap';
import Icon, {PhoneIconName} from '../ui/Icon';
import {Bar} from '../ui/Cards';
import {phoneNative} from '../native';
import {colors, GUTTER, radius} from '../theme';

const fmt = (s: number) => {
  const a = Math.max(0, Math.floor(s));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(a % 60).padStart(2, '0')}`;
};

function Key({icon, label, onPress, size = 64, filled}: {icon: PhoneIconName; label: string; onPress: () => void; size?: number; filled?: boolean}) {
  return (
    <Tap borderless accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[s.key, {width: size, height: size, borderRadius: size / 2}, filled && s.keyOn]}>
      <Icon name={icon} size={Math.round(size * 0.42)} color={filled ? colors.bg : colors.text} />
    </Tap>
  );
}

export default function Remote() {
  const insets = useSafeAreaInsets();
  const list = useDevices();
  const [pick, setPick] = useState<string | null>(null);
  const dev: Device | null = list.find(d => d.deviceId === pick) || list[0] || null;
  const st = useDeviceState(dev ? dev.deviceId : null);
  useEffect(() => {
    if (!pick && list.length) setPick(list[0].deviceId);
  }, [list, pick]);
  const go = async (cmd: string, args: Record<string, unknown> = {}) => {
    if (!dev) return;
    phoneNative.haptic('tick');
    const r = await command(dev.deviceId, cmd, args);
    if (!r.ok && r.message) showToast(r.message, '⚠️');
  };
  const key = (k: string) => go('key', {key: k});
  const now = st?.now || null;
  const vol = st?.volume || null;
  const tracks = (kind: 'sub' | 'audio') => {
    if (!now) return;
    const items = kind === 'sub' ? now.subs : now.audios;
    openActions({
      title: kind === 'sub' ? 'Subtitles' : 'Audio',
      sub: dev?.name,
      items: [
        ...(kind === 'sub' ? [{label: 'Off', tag: now.sub == null ? 'on now' : undefined, onPress: () => go('sub', {id: null})}] : []),
        ...items.map(t => ({label: t.label, tag: (kind === 'sub' ? now.sub : now.audio) === t.id ? 'on now' : undefined, onPress: () => go(kind, {id: t.id})})),
      ],
    });
  };
  const poster = now?.poster ? imgSrc(now.poster) : null;
  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{paddingTop: insets.top + 70, paddingBottom: insets.bottom + 40, paddingHorizontal: GUTTER}}>
        <Text style={s.h1}>Your TVs</Text>
        {!list.length ? (
          <View style={s.empty}>
            <Icon name="remote" size={44} color={colors.textFaint} />
            <Text style={s.emptyText}>No TV is on right now. Open Aurora on a TV signed in to this profile, and it shows up here.</Text>
          </View>
        ) : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.devs}>
              {list.map(d => (
                <ChipButton key={d.deviceId} icon="series" label={d.mine === false && d.profile?.name ? `${d.name} · ${d.profile.name}` : d.name} active={d.deviceId === dev?.deviceId} onPress={() => setPick(d.deviceId)} />
              ))}
            </ScrollView>

            <View style={s.now}>
              {now ? (
                <>
                  <View style={s.nowTop}>
                    <View style={s.poster}>{poster ? <Image source={poster} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}</View>
                    <View style={{flex: 1}}>
                      <Text style={s.nowTitle} numberOfLines={2}>
                        {now.showTitle || now.title}
                      </Text>
                      {now.season != null ? <Text style={s.nowSub}>{`S${now.season} E${now.episode}${now.epTitle ? ` · ${now.epTitle}` : ''}`}</Text> : null}
                      <Text style={s.nowSub}>{now.buffering ? 'Loading…' : now.paused ? 'Paused' : 'Playing'}</Text>
                    </View>
                  </View>
                  <Bar f={now.duration ? Math.min(1, now.position / now.duration) : 0} style={{marginTop: 14}} />
                  <View style={s.times}>
                    <Text style={s.time}>{fmt(now.position)}</Text>
                    <Text style={s.time}>{now.duration ? `-${fmt(now.duration - now.position)}` : ''}</Text>
                  </View>
                  <View style={s.transport}>
                    <Key icon="back10" label="Back 10 seconds" onPress={() => go('skip', {by: -10})} size={56} />
                    <Key icon={now.paused ? 'play' : 'pause'} label={now.paused ? 'Play' : 'Pause'} onPress={() => go('toggle')} size={72} filled />
                    <Key icon="forward10" label="Forward 10 seconds" onPress={() => go('skip', {by: 10})} size={56} />
                    {now.hasNext ? <Key icon="next" label={`Next — ${now.nextLabel || 'episode'}`} onPress={() => go('next')} size={56} /> : null}
                  </View>
                  <View style={s.trackRow}>
                    {now.subs.length ? <ChipButton icon="cc" label="Subtitles" onPress={() => tracks('sub')} /> : null}
                    {now.audios.length > 1 ? <ChipButton icon="volume" label="Audio" onPress={() => tracks('audio')} /> : null}
                    <ChipButton icon="close" label="Stop" onPress={() => go('stop')} />
                  </View>
                </>
              ) : (
                <Text style={s.nowSub}>{dev ? `${dev.name} · ${st?.screen ? `on ${st.screen}` : 'nothing playing'}` : ''}</Text>
              )}
            </View>

            <View style={s.pad}>
              <View style={s.ring}>
                <Tap borderless style={[s.arrow, {alignSelf: 'center'}]} onPress={() => key('up')} accessibilityLabel="Up">
                  <Icon name="chevronUp" size={34} color={colors.text} />
                </Tap>
                <View style={s.mid}>
                  <Tap borderless style={s.arrow} onPress={() => key('left')} accessibilityLabel="Left">
                    <Icon name="chevronLeft" size={34} color={colors.text} />
                  </Tap>
                  <Tap borderless style={s.ok} onPress={() => key('ok')} accessibilityLabel="OK">
                    <Text style={s.okText}>OK</Text>
                  </Tap>
                  <Tap borderless style={s.arrow} onPress={() => key('right')} accessibilityLabel="Right">
                    <Icon name="chevronRight" size={34} color={colors.text} />
                  </Tap>
                </View>
                <Tap borderless style={[s.arrow, {alignSelf: 'center'}]} onPress={() => key('down')} accessibilityLabel="Down">
                  <Icon name="chevronDown" size={34} color={colors.text} />
                </Tap>
              </View>
              <View style={s.side}>
                <Key icon="back" label="Back" onPress={() => key('back')} />
                <Key icon="home" label="Home" onPress={() => key('home')} />
              </View>
            </View>

            {vol?.supported ? (
              <View style={s.vol}>
                <Key icon="volumeOff" label={vol.muted ? 'Unmute' : 'Mute'} onPress={() => go('mute', {on: !vol.muted})} size={52} filled={!!vol.muted} />
                <Key icon="minus" label="Volume down" onPress={() => go('volume', {step: -1})} size={52} />
                <Text style={s.volText}>{vol.level != null ? `${Math.round(vol.level * 100)}` : ''}</Text>
                <Key icon="plus" label="Volume up" onPress={() => go('volume', {step: 1})} size={52} />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      <BackBar />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 32, fontWeight: '900'},
  empty: {alignItems: 'center', padding: 30, gap: 14},
  emptyText: {color: colors.textDim, fontSize: 16, textAlign: 'center', lineHeight: 22},
  devs: {gap: 8, paddingVertical: 14},
  now: {padding: 16, borderRadius: radius.xl, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  nowTop: {flexDirection: 'row', gap: 14, alignItems: 'center'},
  poster: {width: 60, height: 90, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)'},
  nowTitle: {color: colors.text, fontSize: 18, fontWeight: '800'},
  nowSub: {color: colors.textDim, fontSize: 14, marginTop: 3},
  times: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 6},
  time: {color: colors.textDim, fontSize: 12, fontWeight: '700'},
  transport: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 18, marginTop: 12},
  trackRow: {flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap'},
  pad: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 24},
  ring: {width: 230, height: 230, borderRadius: 115, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: colors.glassEdge, justifyContent: 'center'},
  mid: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6},
  arrow: {width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', position: 'relative'},
  ok: {width: 92, height: 92, borderRadius: 46, backgroundColor: 'rgba(139,123,255,0.35)', borderWidth: 1, borderColor: 'rgba(190,170,255,0.5)', alignItems: 'center', justifyContent: 'center'},
  okText: {color: '#fff', fontSize: 20, fontWeight: '900'},
  side: {gap: 18},
  key: {backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: colors.glassEdge, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  keyOn: {backgroundColor: '#fff', borderColor: '#fff'},
  vol: {flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 16, marginTop: 24},
  volText: {color: colors.text, fontSize: 18, fontWeight: '800', minWidth: 36, textAlign: 'center'},
});
