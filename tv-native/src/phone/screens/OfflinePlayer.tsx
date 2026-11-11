// Playing a copy SAVED ON THIS DEVICE — no server needed: the file, its
// subtitles beside it (every track the title has), and the phone's own controls (the same PhoneChrome and
// gestures as the full player). Where you are is kept on the phone and sent to
// your profile when the server answers (store.ts noteOfflineProgress), so the
// TV and the website pick up where the phone left off. Up next is the next
// saved episode of the show: it starts at the end when the person's "play the
// next episode" setting is on; off, the end says what is next and waits for
// Play now.
//
// The view (OfflinePlayerView) is also what the "Can't reach Aurora" screen plays a copy with
// (offline/OfflineHome.tsx) — before any profile is in and with no navigator: it is handed the
// copy's profile and what to do on Back / Next.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Video, {SelectedTrackType, TextTrackType, VideoRef} from 'react-native-video';
import {useRoute, RouteProp} from '@react-navigation/native';
import {replacePhone, usePNav} from '../nav';
import PhoneChrome from '../player/PhoneChrome';
import PhoneGestures from '../player/PhoneGestures';
import {phoneNative} from '../native';
import {flushOfflineProgress, noteOfflinePlayed, noteOfflineProgress, offlineForProfile} from '../offline/store';
import {getActiveProfile} from '../../api';
import {reportActivity} from '../../realtime';
import {createWatchClock} from '../../watchClock';
import {nextSaved} from '../offline/rules';
import {personNow} from '../../personSync';
import {loadPrefs} from '../../storage';
import {showToast} from '../../toast';
import {openActions} from '../../overlay';
import Tap from '../ui/Tap';
import {colors} from '../theme';

type Params = {OfflinePlayer: {id: string}};

export default function OfflinePlayer() {
  const route = useRoute<RouteProp<Params, 'OfflinePlayer'>>();
  const navigation = usePNav();
  return (
    <OfflinePlayerView
      id={route.params.id}
      profileId={getActiveProfile()}
      onBack={() => navigation.goBack()}
      onNext={id => replacePhone('OfflinePlayer', {id})}
      orient={o => navigation.setOptions({orientation: o} as never)}
      pickSubs
    />
  );
}

export function OfflinePlayerView({
  id,
  profileId,
  onBack,
  onNext,
  orient,
  pickSubs = false,
}: {
  id: string;
  profileId: string | null;
  onBack: () => void;
  onNext: (id: string) => void;
  orient: (o: 'landscape' | 'portrait') => void;
  /** a sheet lists the subtitle tracks (in the app); without one, the CC button steps through them */
  pickSubs?: boolean;
}) {
  const {width, height} = useWindowDimensions();
  const mineHere = offlineForProfile(profileId);
  const it = mineHere.find(x => x.id === id && x.state === 'done') || null;
  const ref = useRef<VideoRef>(null);
  const [paused, setPaused] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(it?.duration || 0);
  const [controls, setControls] = useState(true);
  const [locked, setLocked] = useState(false);
  const [fit, setFit] = useState<'fit' | 'fill'>('fit');
  const [landscape, setLandscape] = useState(true);
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  const curRef = useRef(0);
  const lastSave = useRef(0);
  const next = it ? nextSaved(mineHere, it) : null;
  // the person's "play the next episode" (personSync when the server was
  // heard this run, else the setting kept on the phone)
  const autoplayKept = useRef(true);
  useEffect(() => {
    loadPrefs()
      .then(p => (autoplayKept.current = p.autoplayNext !== false))
      .catch(() => {});
  }, []);
  // the end of an episode with autoplay off: what is next, and Play now
  const [endCard, setEndCard] = useState(false);

  // Real watch time (docs/watch-time.md): what this copy really played. With
  // the server there it is reported live, like the streaming player; without,
  // it is kept on the phone and sent when the server answers (store.ts).
  const clock = useMemo(() => createWatchClock(), []);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const sitting = useRef(`s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const label = it ? (it.showTitle && it.season != null && it.episode != null ? `${it.showTitle} S${it.season}E${it.episode}` : it.title) : '';
  const report = useCallback(
    (state?: 'playing' | 'paused' | 'ended') => {
      if (!it) return;
      const played = clock.take();
      const position = curRef.current || 0;
      const duration = dur || it.duration || 0;
      const st = state || (pausedRef.current ? 'paused' : 'playing');
      const live = reportActivity('Watching', label, {position, duration, played, state: st, rate: 1, visible: AppState.currentState === 'active', saved: true});
      if (!live) {
        const who = it.profileId || getActiveProfile();
        if (who) noteOfflinePlayed({sitting: sitting.current, profileId: who, label, position, duration}, played);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dur, label],
  );
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    const iv = setInterval(() => reportRef.current(), 5000);
    const sub = AppState.addEventListener('change', () => reportRef.current());
    return () => {
      clearInterval(iv);
      sub.remove();
    };
  }, []);
  useEffect(() => {
    reportRef.current();
  }, [paused]);

  const show = useCallback(() => {
    setControls(true);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => setControls(false), 4000);
  }, []);
  useEffect(() => {
    phoneNative.setKeepAwake(true);
    phoneNative.setImmersive(true);
    orient('landscape');
    show();
    // the person's subtitle language, when a saved track has it
    const want = personNow()?.subLang;
    if (it && it.subs.length && personNow()?.subsDefault !== false) {
      const i = it.subs.findIndex(s => s.lang && want && want !== 'any' && s.lang.startsWith(want));
      setSubIdx(i >= 0 ? i : 0);
    }
    return () => {
      reportRef.current(); // the last seconds played
      reportActivity('Browsing');
      flushOfflineProgress(); // (what was kept, with the device named)
      if (it) noteOfflineProgress(it.id, curRef.current, dur || it.duration || 0, it.profileId);
      phoneNative.setKeepAwake(false);
      phoneNative.setImmersive(false);
      phoneNative.setPip(false);
      phoneNative.setBrightness(-1);
      phoneNative.setOrientation('auto');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    phoneNative.setPip(!paused, 16, 9);
  }, [paused]);
  if (!it || !it.file) {
    return (
      <View style={s.center}>
        <Text style={s.msg}>This copy isn't on this device any more.</Text>
        <Tap uiId="player.back" onPress={onBack} style={[s.cardBtn, {marginTop: 16, alignSelf: 'center'}]} accessibilityRole="button">
          <Text style={s.cardBtnText}>Back</Text>
        </Tap>
      </View>
    );
  }
  const seek = (t: number) => {
    const to = Math.max(0, Math.min(dur ? dur - 1 : t, t));
    ref.current?.seek(to);
    curRef.current = to;
    setCur(to);
  };
  const title = it.showTitle || it.title;
  const sub = it.season != null && it.episode != null ? `S${it.season} E${it.episode}${it.title && !/^Episode \d+$/.test(it.title) ? ` · ${it.title}` : ''}` : it.year ? String(it.year) : '';
  return (
    <View style={s.root}>
      <Video
        ref={ref}
        source={{uri: `file://${it.file}`}}
        style={StyleSheet.absoluteFill}
        resizeMode={fit === 'fill' ? 'cover' : 'contain'}
        paused={paused}
        progressUpdateInterval={1000}
        textTracks={it.subs.map((t, i) => ({title: t.label || `Subtitles ${i + 1}`, language: (t.lang || 'und') as never, type: TextTrackType.VTT, uri: `file://${t.file}`}))}
        selectedTextTrack={subIdx == null ? {type: SelectedTrackType.DISABLED} : {type: SelectedTrackType.TITLE, value: it.subs[subIdx]?.label || `Subtitles ${subIdx + 1}`}}
        onLoad={d => {
          setDur(d.duration || it.duration || 0);
          // again once the video is there: react-native-video sets the window's picture-in-picture
          // rules itself when its view comes up (auto-enter off), and Home then stopped the film
          // instead of shrinking it (measured on the emulator; the streaming player does this too)
          phoneNative.setPip(!paused, d.naturalSize?.width || 16, d.naturalSize?.height || 9);
          if (it.position && it.position > 10 && (!d.duration || it.position < d.duration - 20)) seek(Math.max(0, it.position - 4));
        }}
        onProgress={p => {
          curRef.current = p.currentTime;
          clock.tick(p.currentTime, {playing: !pausedRef.current, rate: 1});
          if (preview == null) setCur(p.currentTime);
          if (Date.now() - lastSave.current > 15000) {
            lastSave.current = Date.now();
            noteOfflineProgress(it.id, p.currentTime, dur || it.duration || 0, it.profileId);
          }
        }}
        onEnd={() => {
          reportRef.current('ended');
          noteOfflineProgress(it.id, dur, dur, it.profileId);
          if (!next) onBack();
          else if (personNow()?.autoplayNext ?? autoplayKept.current) onNext(next.id);
          else {
            setPaused(true);
            setEndCard(true);
          }
        }}
        onError={() => showToast("This copy didn't play — try saving it again", '⚠')}
      />
      <PhoneGestures
        width={width}
        height={height}
        now={() => curRef.current}
        duration={() => dur}
        armed
        locked={locked}
        onTap={() => (controls ? setControls(false) : show())}
        onSkip={d => {
          show();
          seek(curRef.current + d * 10);
        }}
        onSeek={t => {
          show();
          seek(t);
        }}
        onFit={f => setFit(f)}
      />
      {controls ? (
        <PhoneChrome
          title={title}
          subtitle={sub}
          badges={['ON THIS DEVICE']}
          paused={paused}
          shown={preview != null ? preview : cur}
          duration={dur}
          bufPct={100}
          marks={[]}
          band={null}
          locked={locked}
          fit={fit}
          landscape={landscape}
          hasSubs={it.subs.length > 0}
          subsOff={subIdx == null}
          rate={1}
          party={null}
          next={next ? `S${next.season} E${next.episode}` : null}
          pip={phoneNative.pipSupported()}
          simple
          onBack={onBack}
          onToggle={() => {
            setPaused(p => !p);
            show();
          }}
          onSkip={d => {
            show();
            seek(curRef.current + d * 10);
          }}
          onScrub={t => {
            if (hide.current) clearTimeout(hide.current);
            setPreview(t);
          }}
          onSeek={t => {
            setPreview(null);
            seek(t);
            show();
          }}
          onMenu={m => {
            if (m === 'cc' && it.subs.length && pickSubs && it.subs.length > 2) {
              // every track the copy carries, by name, and Off
              openActions({
                title: 'Subtitles',
                sub: `${it.subs.length} saved with this copy`,
                items: [
                  ...it.subs.map((t, i) => ({label: `${t.label || `Subtitles ${i + 1}`}${i === subIdx ? '  ✓' : ''}`, uiId: 'player.subtitles.pick', onPress: () => setSubIdx(i)})),
                  {label: `Off${subIdx == null ? '  ✓' : ''}`, uiId: 'player.subtitles.pick', onPress: () => setSubIdx(null)},
                ],
              });
              show();
            } else if (m === 'cc' && it.subs.length) {
              // cycle: each saved track, then off
              setSubIdx(i => (i == null ? 0 : i + 1 < it.subs.length ? i + 1 : null));
              show();
            } else showToast(m === 'cc' ? 'No subtitles were saved with this copy' : 'Not on a saved copy', 'ℹ️');
          }}
          onXray={() => showToast('X-Ray needs the server', 'ℹ️')}
          onNext={() => next && onNext(next.id)}
          onLock={on => {
            setLocked(on);
            show();
          }}
          onFit={() => setFit(f => (f === 'fill' ? 'fit' : 'fill'))}
          onRotate={() => {
            const n = !landscape;
            setLandscape(n);
            orient(n ? 'landscape' : 'portrait');
          }}
          onPip={() => phoneNative.enterPip()}
          onTouch={show}
        />
      ) : null}
      {endCard && next ? (
        <View style={s.card}>
          <Text style={s.cardKicker}>NEXT EPISODE</Text>
          <Text style={s.cardTitle} numberOfLines={2}>
            {`S${next.season} E${next.episode}${next.title && !/^Episode \d+$/.test(next.title) ? ` · ${next.title}` : ''}`}
          </Text>
          <Tap uiId="player.upnext.play" onPress={() => onNext(next.id)} style={s.cardBtn} accessibilityRole="button">
            <Text style={s.cardBtnText}>▶  Play now</Text>
          </Tap>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#000'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg},
  msg: {color: colors.text, fontSize: 16},
  // the end card (the streaming player's Up next card, smaller)
  card: {position: 'absolute', right: 16, bottom: 104, maxWidth: 360, padding: 16, borderRadius: 16, backgroundColor: 'rgba(13,14,24,0.97)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)'},
  cardKicker: {color: colors.accent, fontSize: 13, fontWeight: '900', letterSpacing: 2},
  cardTitle: {color: colors.text, fontSize: 17, fontWeight: '800', marginVertical: 8},
  cardBtn: {alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, backgroundColor: colors.accent, overflow: 'hidden'},
  cardBtnText: {color: '#fff', fontSize: 15, fontWeight: '800'},
});
