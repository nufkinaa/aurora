// "On this device" — the place, as the website draws it (docs/offline-look.md §5,
// public/js/screens/saved.js + devicejobs.js), at phone size:
//   1. the heading, "Plays right here — even with no connection"; with the server out of reach
//      one amber line first, with Try again
//   2. Saving now — one row per save: its head in the row's tone, one line, a thin bar, and the
//      buttons that fit the state (Pause · Cancel / Resume · Cancel / Retry · Dismiss)
//   3. Waiting for the server's copy — this device's wishes (Cancel / Dismiss)
//   4. Saved for offline (N): the room, Remove watched (Undo), then the titles — a film a row,
//      a show one group with its episodes (Next up / Watched / Kept ready)
//   5. the foot: Keep the next episode ready
// Empty: the mark in a mint ring and the site's three lines.
import React, {useEffect, useMemo, useState} from 'react';
import {Image, StyleSheet, Switch, Text, View} from 'react-native';
import type {OfflineWish} from '../../api';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import {artSrc} from '../ui/Cards';
import {colors, GUTTER, radius} from '../theme';
import Mark, {AMBER, INK, MINT, RED} from './Mark';
import {cancelOffline, dismissOffline, offlinePrefs, onOfflineLanded, onOfflinePrefs, pauseOffline, removeOffline, resumeOffline, Saved, setOfflinePrefs} from './store';
import {copyName, fmtSize, jobLook, markOf, MOVING_STATES, pctOf, Tone} from './rules';
import {copyLine, groupSaved, isWatched, roomLine, showLine, watchedCopies} from './storage';
import {removeWish} from './wishes';
import {wishLook, wishName} from './wishRules';
import {showToast} from '../../toast';

const TONE: Record<Tone, string> = {busy: MINT, wait: AMBER, bad: RED, ok: MINT};

export function Btn({label, onPress, primary, uiId, small}: {label: string; onPress: () => void; primary?: boolean; uiId: string; small?: boolean}) {
  return (
    <Tap uiId={uiId} onPress={onPress} style={[s.btn, primary && s.btnPrimary, small && {paddingHorizontal: 12}]} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[s.btnText, primary && {color: INK}]}>{label}</Text>
    </Tap>
  );
}

const Poster = ({uri, children}: {uri?: string | null; children?: React.ReactNode}) => {
  const src = uri ? artSrc(uri, 60).src : null;
  return <View style={s.pic}>{src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" /> : children || <Icon name="film" size={22} color={colors.textFaint} />}</View>;
};
const Thin = ({pct, tone, idle}: {pct: number; tone: Tone; idle?: boolean}) => (
  <View style={s.track}>
    <View style={[s.fill, {width: `${Math.max(2, pctOf(pct))}%`, backgroundColor: idle ? 'rgba(245,197,66,0.62)' : TONE[tone]}]} />
  </View>
);

/** One save on its way (or resting, or one that needs you). */
export function JobRow({c}: {c: Saved}) {
  const l = jobLook(c);
  const name = copyName(c);
  const moving = MOVING_STATES.includes(c.state) && c.state !== 'paused';
  return (
    <View style={s.row} accessibilityLabel={`${name}, ${l.head}${l.line ? `, ${l.line}` : ''}`}>
      <Poster uri={c.cover} />
      <View style={{flex: 1}}>
        <Text style={s.title} numberOfLines={2}>
          {name}
        </Text>
        <View style={s.headRow}>
          <Mark state={markOf(c)} pct={c.pct} size={16} />
          <Text style={[s.head, {color: TONE[l.tone]}]} numberOfLines={2}>
            {l.head}
          </Text>
        </View>
        {l.line ? <Text style={s.line}>{l.line}</Text> : null}
        {l.bar ? <Thin pct={c.pct} tone={l.tone} idle={l.idle} /> : null}
        <View style={s.actions}>
          {moving ? <Btn uiId="saved.job.pause" label="Pause" onPress={() => pauseOffline(c.id)} /> : null}
          {c.state === 'paused' ? <Btn uiId="saved.job.resume" label="Resume" primary onPress={() => resumeOffline(c.id)} /> : null}
          {c.state === 'failed' ? <Btn uiId="saved.job.retry" label="Retry" primary onPress={() => resumeOffline(c.id)} /> : null}
          {c.state === 'failed' ? <Btn uiId="saved.job.dismiss" label="Dismiss" onPress={() => dismissOffline(c.id)} /> : <Btn uiId="saved.job.cancel" label="Cancel" onPress={() => cancelOffline(c.id)} />}
        </View>
      </View>
    </View>
  );
}

/** What this device waits for that the server does not have yet. */
export function WishRow({w}: {w: OfflineWish}) {
  const l = wishLook(w);
  const name = wishName(w);
  const failed = w.state === 'failed';
  return (
    <View style={s.row} accessibilityLabel={`${name}, ${l.head}${l.line ? `, ${l.line}` : ''}`}>
      {w.poster ? (
        <Poster uri={w.poster} />
      ) : (
        <View style={[s.pic, s.wishPic, failed && s.wishPicBad]}>
          <Mark state={failed ? 'failed' : 'waiting'} size={26} />
        </View>
      )}
      <View style={{flex: 1}}>
        <Text style={s.title} numberOfLines={2}>
          {name}
        </Text>
        <View style={s.headRow}>
          <Mark state={failed ? 'failed' : w.state === 'ready' ? 'preparing' : 'waiting'} size={16} />
          <Text style={[s.head, {color: TONE[l.tone]}]} numberOfLines={2}>
            {l.head}
          </Text>
        </View>
        {l.line ? <Text style={s.line}>{l.line}</Text> : null}
        <View style={s.actions}>
          {failed ? (
            <Btn uiId="saved.wish.dismiss" label="Dismiss" onPress={() => removeWish(w.id)} />
          ) : (
            <Btn
              uiId="saved.wish.cancel"
              label="Cancel"
              onPress={() => {
                removeWish(w.id);
                showToast(`“${name}” won't be saved to this device`, '📱');
              }}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const Tag = ({text, tone}: {text: string; tone?: 'mint' | 'dim'}) => (
  <View style={[s.tag, tone === 'mint' && {borderColor: 'rgba(110,231,183,0.5)'}]}>
    <Text style={[s.tagText, tone === 'mint' && {color: MINT}]}>{text}</Text>
  </View>
);

/** The titles on this device: films as rows, each show one group. */
export function SavedTitles({copies, onPlay, canRemove = true, landed}: {copies: Saved[]; onPlay: (c: Saved) => void; canRemove?: boolean; landed?: string | null}) {
  const groups = useMemo(() => groupSaved(copies), [copies]);
  return (
    <>
      {groups.map(g => {
        if (g.kind === 'film') {
          const c = g.copy;
          const started = !isWatched(c) && (c.position || 0) > 10;
          return (
            <View key={`f-${c.id}`} style={s.row}>
              <Poster uri={c.cover} />
              <View style={{flex: 1}}>
                <View style={s.headRow}>
                  <Mark state="saved" size={16} landed={landed === c.id} />
                  <Text style={[s.title, {flex: 1}]} numberOfLines={2}>
                    {c.title}
                  </Text>
                </View>
                <Text style={s.line}>{copyLine(c, fmtSize)}</Text>
                <View style={s.actions}>
                  <Btn uiId="saved.play" label={started ? 'Resume' : 'Play'} primary onPress={() => onPlay(c)} />
                  {canRemove ? <Btn uiId="saved.remove" label="Remove" onPress={() => removeOffline(c.id)} /> : null}
                </View>
              </View>
            </View>
          );
        }
        const next = g.next || g.episodes[0];
        return (
          <View key={`s-${g.showId}`} style={s.group}>
            <View style={s.groupHead}>
              <Poster uri={g.episodes[0]?.cover} />
              <View style={{flex: 1}}>
                <Text style={s.title} numberOfLines={2}>
                  {g.showTitle}
                </Text>
                <Text style={s.line}>{showLine(g, fmtSize)}</Text>
                <View style={s.actions}>
                  <Btn uiId="saved.play.next" label={`Play S${next.season} E${next.episode}`} primary onPress={() => onPlay(next)} />
                  {canRemove ? (
                    <Tap uiId="saved.remove.show" onPress={() => removeOffline(g.episodes.map(e => e.id), `Removed “${g.showTitle}” from this device`)} style={s.bin} accessibilityRole="button" accessibilityLabel={`Remove ${g.showTitle} from this device`}>
                      <Icon name="trash" size={20} color={colors.textDim} />
                    </Tap>
                  ) : null}
                </View>
              </View>
            </View>
            {g.episodes.map(e => {
              const watched = isWatched(e);
              const isNext = g.next && e.id === g.next.id;
              return (
                <Tap key={e.id} uiId="saved.play" flat onPress={() => onPlay(e)} style={[s.ep, watched && {opacity: 0.62}]} accessibilityRole="button" accessibilityLabel={`Play ${copyName(e)}${watched ? ', watched' : ''}`}>
                  <Mark state="saved" size={16} landed={landed === e.id} />
                  <View style={{flex: 1}}>
                    <Text style={s.epTitle} numberOfLines={1}>
                      {`S${e.season} E${e.episode}${e.title && !/^Episode \d+$/.test(e.title) && e.title !== g.showTitle ? ` · ${e.title}` : ''}`}
                    </Text>
                    <View style={{flexDirection: 'row', gap: 6, marginTop: 3, flexWrap: 'wrap'}}>
                      {isNext ? <Tag text="Next up" tone="mint" /> : null}
                      {watched ? <Tag text="✓ Watched" /> : null}
                      {e.kept === 'next' ? <Tag text="Kept ready" /> : null}
                      <Text style={s.epMeta}>{[e.sizeBytes ? fmtSize(e.sizeBytes) : null, e.quality === 'original' ? 'Original' : e.quality ? `${e.quality}p` : null].filter(Boolean).join(' · ')}</Text>
                    </View>
                  </View>
                  {canRemove ? (
                    <Tap uiId="saved.remove" onPress={() => removeOffline(e.id)} style={s.bin} accessibilityRole="button" accessibilityLabel={`Remove ${copyName(e)} from this device`}>
                      <Icon name="trash" size={18} color={colors.textFaint} />
                    </Tap>
                  ) : null}
                </Tap>
              );
            })}
          </View>
        );
      })}
    </>
  );
}

/** Nothing saved yet (the site's empty state). */
export function EmptyPlace({free, moving}: {free: number; moving: boolean}) {
  if (moving) return <Text style={s.quiet}>Nothing saved for offline yet — what is on its way lands here.</Text>;
  return (
    <View style={s.empty}>
      <View style={s.emptyRing}>
        <Mark state="none" size={34} color={MINT} />
      </View>
      <Text style={s.emptyTitle}>Nothing saved for offline yet</Text>
      <Text style={s.emptyText}>
        Press <Text style={s.inlineBtn}> Save to this device </Text> on a film or an episode and it lands here.
      </Text>
      <Text style={s.emptyText}>Then it plays anywhere — a flight, a train, the middle of nowhere.</Text>
      {free > 0 ? <Text style={s.emptyRoom}>{`Room on this device: ≈ ${fmtSize(free)}`}</Text> : null}
    </View>
  );
}

/** Keep the next episode ready — the switch, and what it last did. */
export function SmartNextFoot({copies}: {copies: Saved[]}) {
  const [on, setOn] = useState(offlinePrefs().keepNext);
  useEffect(() => onOfflinePrefs(p => setOn(p.keepNext)), []);
  const last = copies.filter(c => c.kept === 'next' && c.state === 'done').sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
  return (
    <View style={s.foot}>
      <Tap uiId="saved.smartnext" flat onPress={() => setOfflinePrefs({keepNext: !on})} style={s.footRow} accessibilityRole="switch" accessibilityState={{checked: on}} accessibilityLabel="Keep the next episode ready">
        <View style={{flex: 1}}>
          <Text style={s.footTitle}>Keep the next episode ready</Text>
          <Text style={s.line}>When you finish a saved episode, the next one saves itself. Nothing is removed.</Text>
        </View>
        <Switch value={on} onValueChange={v => setOfflinePrefs({keepNext: v})} trackColor={{false: 'rgba(255,255,255,0.22)', true: MINT}} thumbColor={on ? '#fff' : '#d8dae4'} />
      </Tap>
      {on && last ? (
        <View style={[s.headRow, {paddingHorizontal: 14, paddingBottom: 12}]}>
          <Mark state="saved" size={15} />
          <Text style={[s.line, {marginTop: 0}]}>{`Saved by itself: ${copyName(last)}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The room, and Remove watched (one press, Undo on the toast). */
export function RoomBlock({copies, free, profileId}: {copies: Saved[]; free: number; profileId: string | null}) {
  const done = copies.filter(c => c.state === 'done');
  const bytes = done.reduce((n, c) => n + (c.sizeBytes || 0), 0);
  const watched = profileId ? watchedCopies(copies, profileId) : [];
  const wBytes = watched.reduce((n, c) => n + (c.sizeBytes || 0), 0);
  const total = bytes + free;
  return (
    <View style={{paddingHorizontal: GUTTER, marginBottom: 12}}>
      <Text style={s.room}>{roomLine(bytes, free, fmtSize)}</Text>
      {total > 0 ? (
        <View style={[s.track, {marginTop: 6}]}>
          <View style={[s.fill, {width: `${Math.max(1, Math.round((bytes / total) * 100))}%`, backgroundColor: MINT}]} />
        </View>
      ) : null}
      {watched.length ? (
        <View style={[s.actions, {marginTop: 10}]}>
          <Btn uiId="saved.clear.watched" label={`Remove watched · ${watched.length} · ${fmtSize(wBytes)}`} onPress={() => removeOffline(watched.map(c => c.id))} />
        </View>
      ) : null}
    </View>
  );
}

/** The amber line when the server is out of reach (the site's). */
export function NoServerLine({onRetry}: {onRetry: () => void}) {
  return (
    <View style={s.amber}>
      <Text style={s.amberText}>Can't reach the Aurora server — the saved titles still play.</Text>
      <Btn uiId="saved.rest.retry" label="Try again" small onPress={onRetry} />
    </View>
  );
}

/** Which copy just landed (the mark's swell), for a moment. */
export function useLanded(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onOfflineLanded(it => {
      setId(it.id);
      if (t) clearTimeout(t);
      t = setTimeout(() => setId(null), 1500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  return id;
}

export const s = StyleSheet.create({
  h2: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: GUTTER, marginTop: 22},
  h3: {color: colors.textDim, fontSize: 13, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: GUTTER, marginTop: 14, marginBottom: 8},
  sub: {color: colors.textDim, fontSize: 14, paddingHorizontal: GUTTER, marginTop: 4, marginBottom: 10},
  row: {flexDirection: 'row', gap: 12, marginHorizontal: GUTTER, marginBottom: 8, padding: 10, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  pic: {width: 52, height: 78, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  wishPic: {backgroundColor: 'rgba(245,197,66,0.07)', borderWidth: 1, borderColor: 'rgba(245,197,66,0.2)'},
  wishPicBad: {backgroundColor: 'rgba(255,122,122,0.07)', borderColor: 'rgba(255,122,122,0.22)'},
  title: {color: colors.text, fontSize: 15, fontWeight: '800'},
  headRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4},
  head: {fontSize: 13.5, fontWeight: '800', flexShrink: 1},
  line: {color: colors.textDim, fontSize: 13, marginTop: 3, lineHeight: 18},
  track: {height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', marginTop: 8},
  fill: {height: 4, borderRadius: 2},
  actions: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10},
  btn: {minHeight: 44, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassEdge},
  btnPrimary: {backgroundColor: MINT, borderColor: MINT},
  btnText: {color: colors.text, fontSize: 14.4, fontWeight: '800'},
  group: {marginHorizontal: GUTTER, marginBottom: 8, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge, overflow: 'hidden'},
  groupHead: {flexDirection: 'row', gap: 12, padding: 10},
  ep: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.glassEdge},
  epTitle: {color: colors.text, fontSize: 14.4, fontWeight: '700'},
  epMeta: {color: colors.textFaint, fontSize: 12},
  bin: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22},
  tag: {paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)'},
  tagText: {color: colors.textDim, fontSize: 11, fontWeight: '800'},
  quiet: {color: colors.textDim, fontSize: 14.4, paddingHorizontal: GUTTER, paddingVertical: 10},
  empty: {alignItems: 'center', paddingHorizontal: GUTTER * 2, paddingVertical: 24},
  emptyRing: {width: 72, height: 72, borderRadius: 36, borderWidth: 1.5, borderColor: 'rgba(110,231,183,0.5)', alignItems: 'center', justifyContent: 'center', marginBottom: 14},
  emptyTitle: {color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 6, textAlign: 'center'},
  emptyText: {color: colors.textDim, fontSize: 14.4, lineHeight: 21, textAlign: 'center', marginTop: 2},
  inlineBtn: {color: colors.text, fontWeight: '800', backgroundColor: colors.glassStrong},
  emptyRoom: {color: colors.textFaint, fontSize: 13, marginTop: 12},
  foot: {marginHorizontal: GUTTER, marginTop: 14, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  footRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14},
  footTitle: {color: colors.text, fontSize: 15, fontWeight: '800'},
  room: {color: colors.textDim, fontSize: 13.5},
  amber: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: GUTTER, marginBottom: 12, padding: 12, borderRadius: radius.l, backgroundColor: 'rgba(245,197,66,0.08)', borderWidth: 1, borderColor: 'rgba(245,197,66,0.32)'},
  amberText: {color: '#f3dc9a', fontSize: 14, fontWeight: '600', flex: 1, lineHeight: 19},
});
