// Aurora Play on the phone — a title's picture (or a drawn stand-in with its name) and the
// back of a play card: the pieces Wrapped, Pick for me and Pick together share. No
// react-native-svg here, so the light screens do not load it.
import React, {useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {artSrc} from '../ui/Cards';
import {Star} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {hashHue} from './storyWords';

// ---------- a title's picture, or a drawn stand-in with its name ----------
export function Poster({name, poster, w, h, radius = 14, gold, style}: {name: string; poster?: string | null; w: number; h: number; radius?: number; gold?: boolean; style?: object}) {
  const {src} = artSrc(poster || null, w);
  const [failed, setFailed] = useState(false);
  const hue = hashHue(name);
  return (
    <View style={[{width: w, height: h, borderRadius: radius, overflow: 'hidden', backgroundColor: PLAY.tile}, gold && pp.gold, style]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, pp.drawn, {experimental_backgroundImage: `linear-gradient(160deg, hsl(${hue}, 60%, 34%) 0%, hsl(${(hue + 60) % 360}, 70%, 14%) 100%)`}]}>
          <Text style={[pp.drawnName, {fontSize: Math.max(11, Math.min(18, w / 7))}]} numberOfLines={4}>
            {name}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------- the card back (the reel, the fan, the collectible's back) ----------
export function CardBack({w, h, q, word = true, radius = 16, reel}: {w: number; h: number; q?: boolean; word?: boolean; radius?: number; reel?: boolean}) {
  const ring = Math.round(Math.min(w, h) * 0.34);
  if (reel) {
    // the reel's plate (the website's .pg-reel-back): the violet card and its big star
    return (
      <View style={[pp.reelBack, {width: w, height: h, borderRadius: radius}]}>
        <Star size={Math.round(w * 0.36)} color="#8b7bff" />
      </View>
    );
  }
  return (
    <View style={[pp.back, {width: w, height: h, borderRadius: radius}]}>
      <View style={[pp.backRing, {width: ring, height: ring, borderRadius: ring / 2}]}>
        <Star size={Math.round(ring * 0.42)} color={PLAY.gold} />
      </View>
      {word ? <Text style={[pp.backWord, {fontSize: Math.max(8, Math.round(w * 0.045))}]}>AURORA WRAPPED</Text> : null}
      {q ? <Text style={[pp.backQ, {fontSize: Math.round(w * 0.13)}]}>?</Text> : null}
    </View>
  );
}

const pp = StyleSheet.create({
  gold: {borderWidth: 2.5, borderColor: PLAY.gold},
  drawn: {justifyContent: 'flex-end', padding: 10},
  drawnName: {color: 'rgba(255,255,255,0.92)', fontWeight: '900', lineHeight: 20},
  reelBack: {alignItems: 'center', justifyContent: 'center', backgroundColor: '#2a2470', experimental_backgroundImage: 'radial-gradient(circle at 50% 50%, #3a3196 0%, #262063 55%, #1b1748 100%)', borderBottomWidth: 1, borderColor: 'rgba(160,131,255,0.35)'},
  back: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255,209,102,0.55)',
    backgroundColor: '#1a1546',
    experimental_backgroundImage: 'radial-gradient(circle at 50% 42%, #2d2470 0%, #171339 60%, #0e0c26 100%)',
    overflow: 'hidden',
  },
  backRing: {alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,209,102,0.7)', backgroundColor: 'rgba(255,209,102,0.06)'},
  backWord: {color: PLAY.gold, fontWeight: '900', letterSpacing: 1.6},
  backQ: {color: PLAY.ink, fontWeight: '900', marginTop: -2},
});
