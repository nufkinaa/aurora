// The website's search field (screens.css + glass.css .search-box): a 58 dp glass
// pill, the magnifier 22 dp in the dim grey, the words 20/600, a round ✕ to clear
// it and, where there is one, the round mic inside the pill on the right.
import React, {forwardRef} from 'react';
import {StyleSheet, Text, TextInput, TextInputProps, View} from 'react-native';
import Icon from './Icon';
import Tap from './Tap';
import {colors, G_EDGE, G_FILL} from '../theme';

type Props = TextInputProps & {
  onClear?: () => void;
  /** the mic: shown when given */
  onMic?: () => void;
  listening?: boolean;
  micLabel?: string;
  /** [analytics] the ✕'s id (the site's: search.clear on Search, browse.filter.clear on a grid) */
  uiIdClear?: string;
};

const SearchBox = forwardRef<TextInput, Props>(function SearchBox({value, onClear, onMic, listening, micLabel, uiIdClear = 'search.clear', style, ...rest}, ref) {
  return (
    <View style={[s.box, style]}>
      <Icon name="search" size={22} color={colors.textDim} />
      <TextInput
        ref={ref}
        value={value}
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        style={s.input}
        {...rest}
      />
      {value && onClear ? (
        <Tap uiId={uiIdClear} borderless hitSlop={8} onPress={onClear} style={s.clear} accessibilityRole="button" accessibilityLabel="Clear search">
          <Text style={s.clearX}>✕</Text>
        </Tap>
      ) : null}
      {onMic ? (
        <Tap uiId="search.voice" borderless onPress={onMic} style={[s.mic, listening && s.micOn]} accessibilityRole="button" accessibilityLabel={micLabel || 'Search by voice'}>
          <Icon name="mic" size={20} color={listening ? '#fff' : colors.textDim} />
        </Tap>
      ) : null}
    </View>
  );
});

export default SearchBox;

const s = StyleSheet.create({
  box: {
    height: 58,
    borderRadius: 29,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingLeft: 22,
    paddingRight: 12,
    backgroundColor: 'rgba(60,64,160,0.22)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
  },
  input: {flex: 1, minWidth: 0, height: 56, padding: 0, color: colors.text, fontSize: 20, fontWeight: '600'},
  clear: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)'},
  clearX: {color: colors.textDim, fontSize: 15.2, fontWeight: '800'},
  mic: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)'},
  micOn: {backgroundColor: colors.accent},
});
