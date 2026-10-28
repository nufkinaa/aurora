// Playing a copy SAVED ON THIS PHONE — no server needed: the file, its
// subtitles beside it, and the phone's own controls (the same PhoneChrome and
// gestures as the full player). Where you are is kept on the phone and sent to
// your profile when the server answers (store.ts noteOfflineProgress), so the
// TV and the website pick up where the phone left off. Up next is the next
// saved episode of the show.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Video, {SelectedTrackType, TextTrackType, VideoRef} from 'react-native-video';
import {useRoute, RouteProp} from '@react-navigation/native';
import {replacePhone, usePNav} from '../nav';
import PhoneChrome from '../player/PhoneChrome';
import PhoneGestures from '../player/PhoneGestures';
import {phoneNative} from '../native';
import {listOffline, noteOfflineProgress, offlineFor} from '../offline/store';
import {nextSaved} from '../offline/rules';
import {personNow} from '../../personSync';
import {showToast} from '../../toast';
import {colors} from '../theme';

type Params = {OfflinePlayer: {id: string}};

export default function OfflinePlayer() {
  const route = useRoute<RouteProp<Params, 'OfflinePlayer'>>();
  const navigation = usePNav();
  const {width, height} = useWindowDimensions();
  const it = offlineFor(route.params.id);
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
  const next = it ? nextSaved(listOffline(), it) : null;

  const show = useCallback(() => {
    setControls(true);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => setControls(false), 4000);
  }, []);
  useEffect(() => {
    phoneNative.setKeepAwake(true);
    phoneNative.setImmersive(true);
    navigation.setOptions({orientation: 'landscape'} as never);
    show();
    // the person's subtitle language, when a saved track has it
    const want = personNow()?.subLang;
    if (it && it.subs.length && personNow()?.subsDefault !== false) {
      const i = it.subs.findIndex(s => s.lang && want && want !== 'any' && s.lang.startsWith(want));
      setSubIdx(i >= 0 ? i : 0);
    }
    return () => {
      if (it) noteOfflineProgress(it.id, curRef.current, dur || it.duration || 0);
      phoneNative.setKeepAwake(false);
      phoneNative.setImmersive(false);
      phoneNative.setPip(false);
      phoneNative.setBrightness(-1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    phoneNative.setPip(!paused, 16, 9);
  }, [paused]);
  if (!it || !it.file) {
    return (
      <View style={s.center}>
        <Text style={s.msg}>This copy is not on the phone any more.</Text>
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
          if (it.position && it.position > 10 && (!d.duration || it.position < d.duration - 20)) seek(Math.max(0, it.position - 4));
        }}
        onProgress={p => {
          curRef.current = p.currentTime;
          if (preview == null) setCur(p.currentTime);
          if (Date.now() - lastSave.current > 15000) {
            lastSave.current = Date.now();
            noteOfflineProgress(it.id, p.currentTime, dur || it.duration || 0);
          }
        }}
        onEnd={() => {
          noteOfflineProgress(it.id, dur, dur);
          if (next) replacePhone('OfflinePlayer', {id: next.id});
          else navigation.goBack();
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
          badges={['ON THIS PHONE']}
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
          onBack={() => navigation.goBack()}
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
            if (m === 'cc' && it.subs.length) {
              // cycle: each saved track, then off
              setSubIdx(i => (i == null ? 0 : i + 1 < it.subs.length ? i + 1 : null));
              show();
            } else showToast(m === 'cc' ? 'No subtitles were saved with this copy' : 'Not on a saved copy', 'ℹ️');
          }}
          onXray={() => showToast('X-Ray needs the server', 'ℹ️')}
          onNext={() => next && replacePhone('OfflinePlayer', {id: next.id})}
          onLock={on => {
            setLocked(on);
            show();
          }}
          onFit={() => setFit(f => (f === 'fill' ? 'fit' : 'fill'))}
          onRotate={() => {
            const n = !landscape;
            setLandscape(n);
            navigation.setOptions({orientation: n ? 'landscape' : 'portrait'} as never);
          }}
          onPip={() => phoneNative.enterPip()}
          onTouch={show}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#000'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg},
  msg: {color: colors.text, fontSize: 16},
});
