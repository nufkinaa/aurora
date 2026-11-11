// "Save to this device — which size?" — the website's size sheet (offlinePicker.js,
// docs/offline-look.md §6) on the phone: the sound when the copy has more than one (chips),
// one row per size with its note and size ("≈" when estimated), the room left, for a title the
// server does not have yet "And every new episode of season N" / "…of this show" (one at most),
// "Always use the size I pick", and Not now. One sheet for every place that saves.
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Sheet from '../ui/Sheet';
import Tap from '../ui/Tap';
import {colors, GUTTER, radius} from '../theme';
import {fmtSize, Option, sizeText, Sound, soundLabel} from './rules';
import {MINT} from './Mark';

export type SizeAsk = {
  /** the title's name, shown in quotes under the heading */
  name: string;
  /** the sentence under it (a title not on the server yet says so) */
  lead?: string;
  options: Option[];
  sounds?: Sound[];
  chosenAudio?: number;
  /** free room on this device (0: unknown) */
  free?: number;
  /** one more choice at most: a season / a whole show (a wish) */
  scopes?: {scope: 'season' | 'show'; label: string}[];
};
export type SizeAnswer = {quality: string; audio: number; always: boolean; scope: 'season' | 'show' | null};

let current: (SizeAsk & {resolve: (a: SizeAnswer | null) => void}) | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const fn of [...subs]) fn();
};

/** Open the sheet; resolves the choice, or null for Not now / Back. */
export const askSize = (o: SizeAsk): Promise<SizeAnswer | null> =>
  new Promise(resolve => {
    current?.resolve(null);
    current = {...o, resolve};
    emit();
  });
const close = (a: SizeAnswer | null) => {
  const c = current;
  current = null;
  emit();
  c?.resolve(a);
};

const Tick = () => (
  <View style={s.tick}>
    <Text style={s.tickMark}>✓</Text>
  </View>
);

export default function SizeSheet() {
  const [, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN(n => n + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  const o = current;
  const [audio, setAudio] = useState(0);
  const [always, setAlways] = useState(false);
  const [scope, setScope] = useState<'season' | 'show' | null>(null);
  useEffect(() => {
    setAudio(o?.chosenAudio || 0);
    setAlways(false);
    setScope(null);
  }, [o]);
  const sounds = o?.sounds && o.sounds.length > 1 ? o.sounds : [];
  const pick = (quality: string) => close({quality, audio: sounds.length ? audio : 0, always, scope});
  return (
    <Sheet visible={!!o} onClose={() => close(null)} title="Save to this device — which size?" sub={o ? `“${o.name}”` : undefined}>
      {o ? (
        <View style={{paddingBottom: 4}}>
          <Text style={s.lead}>{o.lead || 'It will be kept inside Aurora on this device and play with no server in reach.'}</Text>
          {sounds.length ? (
            <View accessibilityRole="radiogroup" accessibilityLabel="Sound">
              <Text style={s.label}>Sound</Text>
              <View style={s.chips}>
                {sounds.map((t, i) => {
                  const on = i === audio;
                  return (
                    <Tap key={i} uiId="offline.sound.pick" onPress={() => setAudio(i)} style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{checked: on}} accessibilityLabel={soundLabel(t)}>
                      {on ? <Tick /> : null}
                      <Text style={s.chipText}>{soundLabel(t)}</Text>
                    </Tap>
                  );
                })}
              </View>
            </View>
          ) : null}
          {o.options.map(opt => {
            const tooBig = !!o.free && opt.sizeBytes > 0 && opt.sizeBytes * 1.05 > o.free;
            const note = [opt.detail, opt.note, tooBig ? 'more than the room left' : null].filter(Boolean).join(' — ');
            return (
              <Tap key={opt.quality} uiId="offline.size.pick" flat onPress={() => pick(opt.quality)} style={s.opt} accessibilityRole="button" accessibilityLabel={`${opt.label}${opt.sizeBytes ? `, ${sizeText(opt)}` : ''}${note ? `, ${note}` : ''}`}>
                <View style={{flex: 1}}>
                  <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
                    <Text style={s.optLabel}>{opt.label}</Text>
                    {opt.instant ? <Text style={s.tag}>FAST</Text> : null}
                  </View>
                  {note ? <Text style={[s.optNote, tooBig && {color: '#ffb3b3'}]}>{note}</Text> : null}
                </View>
                <Text style={s.optSize}>{sizeText(opt)}</Text>
              </Tap>
            );
          })}
          {o.free ? <Text style={s.room}>{`Room on this device: ≈ ${fmtSize(o.free)}`}</Text> : null}
          {(o.scopes || []).map(c => {
            const on = scope === c.scope;
            return (
              <Tap key={c.scope} uiId="offline.scope.pick" onPress={() => setScope(on ? null : c.scope)} style={[s.scope, on && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{checked: on}} accessibilityLabel={c.label}>
                <View style={[s.ring, on && s.ringOn]}>{on ? <Text style={s.ringTick}>✓</Text> : null}</View>
                <Text style={s.scopeText}>{c.label}</Text>
              </Tap>
            );
          })}
          <View style={s.foot}>
            <Tap uiId="offline.always" onPress={() => setAlways(a => !a)} style={[s.chip, always && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{checked: always}} accessibilityLabel="Always use the size I pick">
              {always ? <Tick /> : null}
              <Text style={s.chipText}>Always use the size I pick</Text>
            </Tap>
            <Tap uiId="offline.notnow" onPress={() => close(null)} style={s.btn} accessibilityRole="button" accessibilityLabel="Not now">
              <Text style={s.btnText}>Not now</Text>
            </Tap>
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

const s = StyleSheet.create({
  lead: {color: colors.textDim, fontSize: 14.4, lineHeight: 21, paddingHorizontal: GUTTER + 4, marginBottom: 10},
  label: {color: colors.text, fontSize: 14, fontWeight: '800', paddingHorizontal: GUTTER + 4, marginTop: 2, marginBottom: 6},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: GUTTER, marginBottom: 10},
  chip: {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.chipEdge},
  // a chosen chip says so twice: the mint tint with a mint ring inside, and a tick before its words
  chipOn: {backgroundColor: 'rgba(110,231,183,0.16)', borderColor: MINT, borderWidth: 1.5},
  chipText: {color: colors.text, fontSize: 14.4, fontWeight: '700'},
  tick: {width: 14, height: 14, alignItems: 'center', justifyContent: 'center'},
  tickMark: {color: MINT, fontSize: 13, fontWeight: '900', lineHeight: 15},
  opt: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, marginHorizontal: GUTTER, marginBottom: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  optLabel: {color: colors.text, fontSize: 16, fontWeight: '800'},
  optNote: {color: colors.textDim, fontSize: 13, marginTop: 2, lineHeight: 18},
  optSize: {color: colors.text, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums']},
  tag: {color: MINT, fontSize: 11, fontWeight: '900', letterSpacing: 1},
  room: {color: colors.textDim, fontSize: 13.5, paddingHorizontal: GUTTER + 4, marginTop: 4, marginBottom: 8},
  scope: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, marginHorizontal: GUTTER, marginBottom: 6, paddingHorizontal: 14, borderRadius: radius.l, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.chipEdge},
  ring: {width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center'},
  ringOn: {backgroundColor: MINT, borderColor: MINT},
  ringTick: {color: '#0b0c14', fontSize: 11, fontWeight: '900', lineHeight: 13},
  scopeText: {color: colors.text, fontSize: 14.4, fontWeight: '700', flexShrink: 1},
  foot: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: GUTTER, marginTop: 8},
  btn: {minHeight: 44, paddingHorizontal: 18, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassEdge},
  btnText: {color: colors.text, fontSize: 15, fontWeight: '800'},
});
