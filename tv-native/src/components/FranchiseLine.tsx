// [franchise] The title page's franchise line (TV): "Part of the Marvel
// Cinematic Universe · 12 of 34" and Watch in order, as ONE focusable pill
// under the icon row — DOWN from My List / Trailer reaches it, OK opens the
// franchise page. Nothing is drawn until the server answers with a franchise
// (useFranchise.ts asks after the page's first paint), and it never takes
// focus by itself: Play keeps the page's first focus.
import React from 'react';
import {Text, StyleSheet, View} from 'react-native';
import Focusable from './Focusable';
import {useFranchiseFor} from '../useFranchise';
import {FR_WORDS} from '../franchiseRules';
import theme from '../theme';

const {colors, fontSize, radius} = theme;

function FranchiseLine({
  imdbId,
  type,
  profileId,
  onOpen,
  onFocused,
}: {
  imdbId: string | null | undefined;
  type: 'movie' | 'series';
  profileId: string | null | undefined;
  onOpen: (f: {id: string; name: string}) => void;
  /** the page scrolls back to its top when a lockup control takes focus (Detail's ToTop) */
  onFocused?: () => void;
}) {
  const fr = useFranchiseFor(imdbId, type, profileId);
  if (!fr) return null;
  return (
    <View style={styles.wrap}>
      <Focusable
        uiId="detail.franchise"
        round
        edgeLeft
        holdLeft
        highlightColor={colors.surfaceHover}
        onFocusChange={f => f && onFocused?.()}
        onPress={() => onOpen({id: fr.id, name: fr.name})}
        accessibilityLabel={`${fr.line}. ${fr.action || FR_WORDS.action}`}
        style={styles.pill}>
        <Text style={styles.line} numberOfLines={1}>
          {fr.line}
        </Text>
        <Text style={styles.action} numberOfLines={1}>
          {`${fr.action || FR_WORDS.action}  ›`}
        </Text>
      </Focusable>
    </View>
  );
}

export default React.memo(FranchiseLine);

const styles = StyleSheet.create({
  wrap: {flexDirection: 'row', marginTop: 10},
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    maxWidth: 620,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  line: {color: colors.textDim, fontSize: fontSize.small + 1, fontWeight: '700', flexShrink: 1},
  action: {color: colors.text, fontSize: fontSize.small + 1, fontWeight: '800'},
});
