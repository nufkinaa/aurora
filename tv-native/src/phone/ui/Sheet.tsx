// A bottom sheet (Material's, in Aurora's dark glass): slides up over a dimmed
// page, a handle on top, Back or a tap outside closes it. Its content scrolls
// when it is taller than ~80% of the screen.
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {colors, GUTTER, radius} from '../theme';

export default function Sheet({
  visible,
  onClose,
  title,
  sub,
  children,
  scroll = true,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  sub?: string;
  children?: React.ReactNode;
  scroll?: boolean;
}) {
  const y = useRef(new Animated.Value(1)).current;
  const insets = useSafeAreaInsets();
  const {height, width} = useWindowDimensions();
  useEffect(() => {
    if (visible) {
      y.setValue(1);
      Animated.timing(y, {toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    }
  }, [visible, y]);
  const maxW = Math.min(width, 640);
  const Body = scroll ? ScrollView : View;
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <Animated.View
        style={[
          s.sheet,
          {
            width: maxW,
            alignSelf: 'center',
            maxHeight: height * 0.86,
            paddingBottom: insets.bottom + 12,
            transform: [{translateY: y.interpolate({inputRange: [0, 1], outputRange: [0, 400]})}],
          },
        ]}>
        <View style={s.handle} />
        {title ? (
          <Text style={s.title} numberOfLines={2}>
            {title}
          </Text>
        ) : null}
        {sub ? <Text style={s.sub}>{sub}</Text> : null}
        <Body style={scroll ? {flexGrow: 0} : undefined} contentContainerStyle={scroll ? {paddingBottom: 4} : undefined}>
          {children}
        </Body>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)'},
  sheet: {
    position: 'absolute',
    bottom: 0,
    backgroundColor: '#141629',
    experimental_backgroundImage: 'linear-gradient(180deg, #1b1d36 0%, #121327 100%)',
    borderTopLeftRadius: radius.xl + 6,
    borderTopRightRadius: radius.xl + 6,
    borderWidth: 1,
    borderColor: colors.glassEdge,
    borderBottomWidth: 0,
    paddingTop: 10,
  },
  handle: {alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.28)', marginBottom: 12},
  title: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: GUTTER + 4, marginBottom: 4},
  sub: {color: colors.textDim, fontSize: 14, paddingHorizontal: GUTTER + 4, marginBottom: 10},
});
