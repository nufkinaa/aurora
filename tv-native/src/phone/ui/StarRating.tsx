// "Your rating" — the website's 1–5 stars on a title page (components.js starRating):
// stored per profile on the server (/api/profiles/:id/rating, keyed by the IMDb id, else the
// library id — the site's key), so the website and this phone show the same stars. Tapping
// the lit star again clears it. The website's words for each.
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {api} from '../../api';
import {showToast} from '../../toast';
import Tap from './Tap';
import {colors} from '../theme';
import {nextRating, RATING_QUIPS} from '../words';

export default function StarRating({profileId, rateKey}: {profileId: string; rateKey: string | null | undefined}) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!rateKey) return;
    let live = true;
    api
      .state(profileId)
      .then(st => live && setVal(Number((st.ratings || {})[rateKey]) || 0))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId, rateKey]);
  if (!rateKey) return null;
  const rate = async (i: number) => {
    const before = val;
    const next = nextRating(val, i);
    setVal(next);
    try {
      await api.rate(profileId, rateKey, next);
      showToast(next ? `${next}★ — ${RATING_QUIPS[next]}` : 'Rating wiped. We saw nothing.', '⭐');
    } catch {
      setVal(before);
      showToast("Couldn't save that — try again in a moment", '⚠️');
    }
  };
  return (
    <View style={s.row} accessibilityRole="radiogroup" accessibilityLabel="Your rating">
      <Text style={s.label}>Your rating</Text>
      {[1, 2, 3, 4, 5].map(i => (
        <Tap key={i} uiId="rating.star" borderless onPress={() => rate(i)} accessibilityRole="button" accessibilityLabel={`${i} star${i > 1 ? 's' : ''}`} accessibilityState={{selected: i <= val}} style={s.star}>
          <Text style={[s.glyph, i <= val && s.on]}>★</Text>
        </Tap>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', marginTop: 10},
  label: {color: colors.textDim, fontSize: 15, fontWeight: '700', marginRight: 6},
  star: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  glyph: {fontSize: 26, color: 'rgba(255,255,255,0.28)'},
  on: {color: '#f5c542'},
});
