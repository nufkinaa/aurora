// The app's canvas: the site's ambient background, baked.
//
// public/css/base.css paints three fixed layers behind EVERY page — a violet
// bloom leaking in from the top-right corner, a cooler one from the bottom-left,
// and a static film grain over both. That stack is what stops a dark screen
// reading as a void, and it is the most recognisable thing about the site.
//
// Mounted once, behind the whole navigator (see navigation.tsx), because on the
// site it belongs to `html`/`body` rather than to any screen — every screen gets
// it for free and none of them has to remember to.
//
// The blooms are baked by tools/gen_ambient.py, which transcribes the CSS
// exactly (including the `inset: -25%` that puts both bloom centres just off the
// corners). Read the note there before changing any number here: an earlier bake
// invented its own geometry and doubled the alphas, and measured against the
// live site it came out about three times too strong.
//
// The drift is deliberately not ported. The site animates each bloom on a
// 71s/97s loop, which costs a desktop GPU nothing; here it would keep the
// choreographer awake forever for a movement whose whole design goal is that you
// never catch it happening.
import React, {useCallback, useEffect, useState} from 'react';
import {View, Image, StyleSheet} from 'react-native';
import {dropWindowBackground, restoreWindowBackground} from '../perfTier';
import theme from '../theme';
import {exp} from '../exp';

const {colors} = theme;

const AMBIENT = require('../assets/ambient.png');
// The site's film-grain layer (body::before) is deliberately NOT drawn here
// any more. At 3% it is invisible on a monitor, but the Streamer upscales a
// 960dp frame to a 4K panel and the tile read as a speckled filter over every
// page — elia's "graininess". The blooms alone keep the canvas from being a void.

// StyleSheet.absoluteFillObject is missing from the tvos type defs.
const fill = {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0} as const;

// OVERDRAW. Under this opaque canvas sat three full-screen fills nobody ever
// saw once it had drawn: the window's background (android:windowBackground),
// the navigator's root colour and this view's own. Each is a full-screen pass
// of fill rate on every frame — on a Mali-G31 at 1080p that is real time.
// So the page colour is painted here only until the canvas has loaded (cold
// start still opens on the page colour, never a black frame), then dropped;
// one frame later the window's own background is dropped too, natively. The
// window gets it back when this unmounts (sign-out: the gate screens outside
// the navigator draw on the window's colour).
function Ambient() {
  const [drawn, setDrawn] = useState(false);
  const onLoad = useCallback(() => setDrawn(true), []);
  useEffect(() => {
    if (!drawn) return;
    // a frame after the canvas is on screen
    const raf = requestAnimationFrame(() => requestAnimationFrame(dropWindowBackground));
    return () => cancelAnimationFrame(raf);
  }, [drawn]);
  useEffect(() => () => restoreWindowBackground(), []);
  // LAB removal (src/exp.ts): no canvas at all — the window's own colour shows.
  if (exp('x_ambient')) return null;
  return (
    <View style={[styles.root, !drawn && styles.underlay]} pointerEvents="none">
      {/* "stretch", not "cover": the bloom positions are fractions of the frame,
          so they must follow its proportions rather than be cropped to preserve
          an aspect ratio a gradient does not have. */}
      <Image source={AMBIENT} style={styles.wash} resizeMode="stretch" fadeDuration={0} onLoad={onLoad} />
    </View>
  );
}

export default React.memo(Ambient);

const styles = StyleSheet.create({
  // ambient.png is fully opaque (RGB, no alpha) and drawn at exactly the
  // root's bounds (width/height 100%, FIT_XY), so there are no edges for a
  // colour underneath to show through once it has drawn.
  root: fill,
  underlay: {backgroundColor: colors.bg},
  wash: {...fill, width: '100%', height: '100%'},
});
