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
  stopAnimation(cb) {
    if (cb) cb(this.v);
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
  Animated: {
    Value,
    View: 'Animated.View',
    Image: 'Animated.Image',
    Text: 'Animated.Text',
    spring: anim,
    timing: anim,
    // (the play kit: groups of animations end at once here, like the single ones)
    loop: anim,
    sequence: anim,
    parallel: anim,
    stagger: anim,
    delay: anim,
    createAnimatedComponent: c => c,
  },
  Easing: {bezier: () => t => t, linear: t => t, cubic: t => t, quad: t => t, out: f => f, in: f => f, inOut: f => f, back: () => t => t},
  AccessibilityInfo: {isReduceMotionEnabled: () => Promise.resolve(false), addEventListener: () => ({remove: () => {}})},
  AppState: {addEventListener: () => ({remove: () => {}}), currentState: 'active'},
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return {remove: () => {}};
    }
  },
  useWindowDimensions: () => ({width: 960, height: 540}),
  useTVEventHandler: () => {},
  // the Fabric specs (src/specs): a host component is its name; commands do nothing
  codegenNativeComponent: name => name,
  codegenNativeCommands: ({supportedCommands}) => Object.fromEntries((supportedCommands || []).map(c => [c, () => {}])),
  DeviceEventEmitter: {addListener: () => ({remove: () => {}})},
  // a stable number per colour string (Card.tsx's `cardtext` decor; the real one packs ARGB)
  processColor: c => (c == null ? c : [...String(c)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)),
};
