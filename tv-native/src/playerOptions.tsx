// [player-options] 2026-10-19 — the pieces the player and Settings share:
//   CueText          a cue drawn in the person's look (subStyle.ts): colour,
//                    weight, and the background — none, a drop shadow, an
//                    outline (eight dark copies under the text: Android draws
//                    one shadow per Text) or a box at its opacity
//   SubStylePreview  the live sample (Settings, the player's subtitle menu):
//                    an English line and a Hebrew one, drawn by CueText
//   useAudioFx       the person's night mode / dialogue boost handed to the
//                    native side (audioFx.ts), and why they cannot apply here
//                    right now (passthrough, Android < 9, no native side)
// Hebrew stays right: each line is its own Text, so Android's bidi lays the
// Hebrew right to left exactly as on a real cue (cues.ts keeps the files'
// own direction marks).
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, TextStyle, View} from 'react-native';
import {CueLook, cueLook, OUTLINE_OFFSETS, SubStyle} from './subStyle';
import {AudioFxStatus, audioFxStatus, fxReason, onAudioFxStatus, setAudioFx} from './audioFx';

export const CueText = React.memo(function CueText({
  text,
  sizePx,
  look,
}: {
  text: string;
  sizePx: number;
  look: CueLook;
}) {
  const base: TextStyle = {
    fontSize: sizePx,
    lineHeight: Math.round(sizePx * 1.4),
    fontWeight: look.fontWeight,
  };
  return (
    <View style={styles.wrap}>
      {look.outline
        ? OUTLINE_OFFSETS.map(([x, y], i) => (
            <Text
              key={i}
              // the dark copies sit exactly under the text, moved by (x, y)
              style={[styles.text, base, styles.copy, {color: '#000', transform: [{translateX: x}, {translateY: y}]}]}>
              {text}
            </Text>
          ))
        : null}
      <Text
        style={[
          styles.text,
          base,
          {color: look.color},
          look.backgroundColor ? {backgroundColor: look.backgroundColor} : null,
          look.shadow ? styles.shadow : null,
        ]}>
        {text}
      </Text>
    </View>
  );
});

/** The sample: what the player's cues look like with this style. */
export const SubStylePreview = React.memo(function SubStylePreview({
  style,
  sizePx,
  compact,
}: {
  style: Partial<SubStyle>;
  sizePx: number;
  compact?: boolean;
}) {
  const look = cueLook(style);
  return (
    <View
      style={[styles.preview, compact && styles.previewCompact, style.subPos === 'raised' && styles.previewRaised]}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      <View style={styles.sky} />
      <View style={styles.sun} />
      <CueText text="This is how subtitles look" sizePx={sizePx} look={look} />
      <CueText text="כך נראות הכתוביות" sizePx={sizePx} look={look} />
    </View>
  );
});

/** Hands the person's two switches to the native side whenever they change,
 *  and answers why they cannot apply right now (null: they do). */
export const useAudioFx = (
  nightMode: boolean,
  dialogueBoost: boolean,
  {perFilm = true}: {perFilm?: boolean} = {},
): string | null => {
  const [status, setStatus] = useState<AudioFxStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    audioFxStatus().then(s => live && setStatus(s));
    const off = onAudioFxStatus(s => live && setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  useEffect(() => {
    setAudioFx({nightMode, dialogueBoost});
  }, [nightMode, dialogueBoost]);
  // (undefined: still asking — nothing is greyed out for that instant)
  if (status === undefined) return null;
  // perFilm false (Settings): what this TV can do, not what the last film's
  // sound happened to be (a passthrough track greys them in the player only)
  return fxReason(status && !perFilm ? {...status, passthrough: false, offload: false} : status);
};

const styles = StyleSheet.create({
  wrap: {alignItems: 'center', justifyContent: 'center'},
  text: {
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingVertical: 2,
    overflow: 'hidden',
    borderRadius: 4,
  },
  // the eight copies: out of the layout, on top of each other under the text,
  // exactly as wide as it (so a long cue wraps the same way in every copy)
  copy: {position: 'absolute', left: 0, right: 0, top: 0},
  shadow: {
    textShadowColor: 'rgba(0,0,0,0.95)',
    textShadowOffset: {width: 0, height: 2},
    textShadowRadius: 8,
  },
  preview: {
    height: 150,
    borderRadius: 10,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 14,
    backgroundColor: '#7aa7c7',
  },
  previewCompact: {height: 96, paddingBottom: 8},
  previewRaised: {justifyContent: 'center', paddingBottom: 0},
  // a bright frame behind the sample (subtitles have to survive one)
  sky: {position: 'absolute', left: 0, right: 0, bottom: 0, top: '35%', backgroundColor: '#d9c8a0', opacity: 0.55},
  sun: {position: 'absolute', left: '42%', top: '20%', width: '30%', height: '70%', borderRadius: 999, backgroundColor: '#f4efe4', opacity: 0.8},
});
