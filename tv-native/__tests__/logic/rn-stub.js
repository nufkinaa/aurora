// The little of react-native the logic tests touch. Host components are plain
// strings (react-test-renderer renders them as-is); Animated does nothing.
class Value {
  constructor(v) {
    this.v = v;
  }
  setValue(v) {
    this.v = v;
  }
  interpolate(cfg) {
    return {interpolated: cfg};
  }
}
const anim = () => ({start: cb => cb && cb({finished: true}), stop: () => {}});
module.exports = {
  PixelRatio: {get: () => 2},
  Platform: {OS: 'android', Version: 34, constants: {}},
  StyleSheet: {create: s => s, flatten: s => Object.assign({}, ...[].concat(s).flat(9).filter(Boolean)), absoluteFill: {}},
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  TVFocusGuideView: 'TVFocusGuideView',
  Animated: {Value, View: 'Animated.View', Image: 'Animated.Image', spring: anim, timing: anim, createAnimatedComponent: c => c},
  Easing: {bezier: () => t => t},
  AppState: {addEventListener: () => ({remove: () => {}}), currentState: 'active'},
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return {remove: () => {}};
    }
  },
  useWindowDimensions: () => ({width: 960, height: 540}),
  useTVEventHandler: () => {},
};
