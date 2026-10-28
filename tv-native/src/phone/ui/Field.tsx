// A text field in the glass look (the website's .field): rounded, a hairline
// edge that lights up while typing, the system keyboard below it.
import React, {forwardRef, useState} from 'react';
import {StyleSheet, TextInput, TextInputProps} from 'react-native';
import {colors, radius} from '../theme';

const Field = forwardRef<TextInput, TextInputProps>(function Field({style, onFocus, onBlur, ...rest}, ref) {
  const [on, setOn] = useState(false);
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.textFaint}
      selectionColor={colors.accent}
      cursorColor={colors.accent}
      {...rest}
      onFocus={e => {
        setOn(true);
        onFocus?.(e);
      }}
      onBlur={e => {
        setOn(false);
        onBlur?.(e);
      }}
      style={[s.field, on && s.on, style]}
    />
  );
});

export default Field;

const s = StyleSheet.create({
  field: {
    height: 54,
    borderRadius: radius.l,
    paddingHorizontal: 16,
    fontSize: 17,
    color: colors.text,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: colors.glassEdge,
  },
  on: {borderColor: colors.accent, backgroundColor: 'rgba(139,123,255,0.10)'},
});
