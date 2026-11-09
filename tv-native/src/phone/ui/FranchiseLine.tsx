// [franchise] The title page's franchise line on the phone: "Part of the
// Marvel Cinematic Universe · 12 of 34" and Watch in order, one tappable glass
// line under the actions — it opens the franchise page. Drawn only once the
// server answers with a franchise (useFranchise.ts asks after the first paint).
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import Tap from './Tap';
import Icon from './Icon';
import {useFranchiseFor} from '../../useFranchise';
import {FR_WORDS} from '../../franchiseRules';
import {colors, radius} from '../theme';

function FranchiseLine({
  imdbId,
  type,
  profileId,
  onOpen,
}: {
  imdbId: string | null | undefined;
  type: 'movie' | 'series';
  profileId: string | null | undefined;
  onOpen: (f: {id: string; name: string}) => void;
}) {
  const fr = useFranchiseFor(imdbId, type, profileId);
  if (!fr) return null;
  const action = fr.action || FR_WORDS.action;
  return (
    <Tap uiId="detail.franchise" flat onPress={() => onOpen({id: fr.id, name: fr.name})} style={s.line} accessibilityRole="button" accessibilityLabel={`${fr.line}. ${action}`}>
      <Text style={s.text} numberOfLines={2}>
        {fr.line}
      </Text>
      <Text style={s.action} numberOfLines={1}>
        {action}
      </Text>
      <Icon name="chevronRight" size={16} color={colors.text} />
    </Tap>
  );
}

export default React.memo(FranchiseLine);

const s = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.l,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassEdge,
  },
  text: {flex: 1, color: colors.textDim, fontSize: 13.5, fontWeight: '700'},
  action: {color: colors.text, fontSize: 13.5, fontWeight: '800'},
});
