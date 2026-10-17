package com.horcrux.svg;

import android.graphics.Path;

/**
 * render switch `cardtext` (com.auroratv.ui.card.CardStamps): react-native-svg's OWN path
 * parser, so the card's kind icon is the exact Path an RNSVGPath with the same `d` builds
 * (arcs included). PathParser is package-private in react-native-svg, hence this class in its
 * package. PathParser.mScale is a static that every RNSVG PathView sets right before parsing
 * (PathView.setD); this does the same, on the UI thread like them.
 */
public final class AuroraSvgPaths {
  private AuroraSvgPaths() {}

  public static Path parse(String d, float scale) {
    PathParser.mScale = scale;
    return PathParser.parse(d);
  }
}
