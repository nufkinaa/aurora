package com.auroratv.ui.rail

import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Bezier
import com.auroratv.ui.anim.Interpolation
import kotlin.math.tan

/**
 * The nav rail's drawing arithmetic — every number of NavRail.tsx's strip, panel and hues
 * that AuroraRailPanelView draws or animates. Pure JVM; held to the JS by
 * tools/gen-rail-fixtures.js → src/test/resources/rail-fixtures.json → RailMathTest (the
 * generator reads the constants out of NavRail.tsx / theme.ts and refuses to write if an
 * expression changed).
 */
object RailMath {
  // theme.ts nav = {rail: 72, railOpen: 240}; NavRail.tsx FEATHER = 48
  const val RAIL = 72.0
  const val RAIL_OPEN = 240.0
  const val FEATHER = 48.0
  const val PANEL = RAIL_OPEN + FEATHER

  // ---- the slide: Animated.timing(slide, {duration: motion.med, easing: EASE}) -------------
  private val EASE = Bezier(0.2, 0.7, 0.2, 1.0)
  val SLIDE_FRAMES: DoubleArray = AuroraTiming.sample(280.0) { EASE.ease(it) }

  /** The panel's translateX, dp: `slide` [0, 1] → [-(railOpen + FEATHER), 0]. */
  fun panelTx(slide: Double): Double = Interpolation.segment(slide, 0.0, 1.0, -PANEL, 0.0)

  /** The strip's opacity: `slide` [0, 1] → [1, 0]. */
  fun stripAlpha(slide: Double): Double = Interpolation.segment(slide, 0.0, 1.0, 1.0, 0.0)

  // ---- the hues (RailHues) -----------------------------------------------------------------
  const val HUE_A_MS = 8000.0
  const val HUE_B_MS = 10500.0

  /** qa.ts FROZEN_PHASE: where `runLoop` holds both loops under `freeze on`. */
  const val FROZEN_PHASE = 0.37

  /** `Easing.sin`: `1 - Math.cos((t * Math.PI) / 2)`. */
  private fun sinEase(t: Double): Double = 1 - Math.cos((t * Math.PI) / 2)

  /** `Easing.inOut(Easing.sin)`: `t < 0.5 ? e(t * 2) / 2 : 1 - e((1 - t) * 2) / 2`. */
  fun sinInOut(t: Double): Double = if (t < 0.5) sinEase(t * 2) / 2 else 1 - sinEase((1 - t) * 2) / 2

  /** One leg of a loop (0 → 1 or 1 → 0), pre-sampled as RN's JS does for the native driver. */
  val HUE_A_FRAMES: DoubleArray by lazy { AuroraTiming.sample(HUE_A_MS) { sinInOut(it) } }
  val HUE_B_FRAMES: DoubleArray by lazy { AuroraTiming.sample(HUE_B_MS) { sinInOut(it) } }

  /** A glow at one instant: opacity, translate (dp), scale. */
  class Glow(val alpha: Double, val tx: Double, val ty: Double, val scale: Double)

  private fun seg(v: Double, from: Double, to: Double) = Interpolation.segment(v, 0.0, 1.0, from, to)

  /** hueViolet: opacity a→[0.26, 0.46], translateX a→[-14, 26], translateY b→[-10, 34], scale a→[1, 1.14]. */
  fun violet(a: Double, b: Double) = Glow(seg(a, 0.26, 0.46), seg(a, -14.0, 26.0), seg(b, -10.0, 34.0), seg(a, 1.0, 1.14))

  /** hueGreen: opacity b→[0.18, 0.36], translateX b→[22, -18], translateY a→[16, -30], scale b→[1.08, 0.96]. */
  fun green(a: Double, b: Double) = Glow(seg(b, 0.18, 0.36), seg(b, 22.0, -18.0), seg(a, 16.0, -30.0), seg(b, 1.08, 0.96))

  // styles.hueViolet {top: -150, left: -170, width: 440, height: 440, tintColor: '#6856e2'}
  const val VIOLET_LEFT = -170.0
  const val VIOLET_TOP = -150.0
  const val VIOLET_SIZE = 440.0
  const val VIOLET_TINT = 0xFF6856E2.toInt()

  // styles.hueGreen {bottom: -190, left: -150, width: 460, height: 460, tintColor: '#46c896'}
  const val GREEN_LEFT = -150.0
  const val GREEN_BOTTOM = -190.0
  const val GREEN_SIZE = 460.0
  const val GREEN_TINT = 0xFF46C896.toInt()

  // ---- colours -----------------------------------------------------------------------------
  // styles.panelBody: backgroundColor '#0a0b14' + linear-gradient(165deg,
  //   rgba(104,86,226,0.20) 0%, rgba(10,11,20,0) 46%, rgba(70,200,150,0.12) 100%)
  const val BODY_COLOR = 0xFF0A0B14.toInt()
  const val BODY_ANGLE = 165.0
  val BODY_COLORS = intArrayOf(0x336856E2, 0x000A0B14, 0x1F46C896)
  val BODY_STOPS = floatArrayOf(0f, 0.46f, 1f)

  // styles.huesEdge: width round(railOpen * 0.5), linear-gradient(90deg, rgba(10,11,20,0) 0%, rgba(10,11,20,1) 100%)
  const val EDGE = 120.0
  const val EDGE_ANGLE = 90.0
  val EDGE_COLORS = intArrayOf(0x000A0B14, 0xFF0A0B14.toInt())
  val EDGE_STOPS = floatArrayOf(0f, 1f)

  // Scrim: <Stop offset 0 #080910 stopOpacity 0.9 /> → <Stop offset 1 #080910 stopOpacity 0 />
  val SCRIM_COLORS = intArrayOf(svgStop(0x080910, 0.9), svgStop(0x080910, 0.0))
  val SCRIM_STOPS = floatArrayOf(0f, 1f)

  // The feather: #0a0b14 at 1 @0, 0.55 @0.45, 0 @1
  val FEATHER_COLORS = intArrayOf(svgStop(0x0A0B14, 1.0), svgStop(0x0A0B14, 0.55), svgStop(0x0A0B14, 0.0))
  val FEATHER_STOPS = floatArrayOf(0f, 0.45f, 1f)

  /**
   * A react-native-svg `<Stop>` as the Brush receives it: the colour's alpha is
   * `Math.round(stopOpacity * 255)` (lib/extract/extractGradient.ts), then
   * `Math.round(alpha * opacity)` with opacity 1 (Brush.parseGradientStops).
   */
  fun svgStop(rgb: Int, stopOpacity: Double): Int = (Math.round(stopOpacity * 255).toInt() shl 24) or (rgb and 0x00FFFFFF)

  /**
   * The gradient line of a CSS `linear-gradient(<angle>deg, …)` over a `width` × `height`
   * box: `[startX, startY, endX, endY]` — React Native's LinearGradient.kt
   * `endPointsFromAngle` (uimanager/style/LinearGradient.kt:185-221), float for float.
   */
  fun gradientLine(angle: Double, width: Float, height: Float): FloatArray {
    var adjustedAngle = angle % 360
    if (adjustedAngle < 0) adjustedAngle += 360
    when (adjustedAngle) {
      0.0 -> return floatArrayOf(0f, height, 0f, 0f)
      90.0 -> return floatArrayOf(0f, 0f, width, 0f)
      180.0 -> return floatArrayOf(0f, 0f, 0f, height)
      270.0 -> return floatArrayOf(width, 0f, 0f, 0f)
    }
    val slope = tan(Math.toRadians(90 - adjustedAngle)).toFloat()
    val perpendicularSlope = -1 / slope
    val halfHeight = height / 2
    val halfWidth = width / 2
    val cornerX: Float
    val cornerY: Float
    when {
      adjustedAngle < 90 -> { cornerX = halfWidth; cornerY = halfHeight }
      adjustedAngle < 180 -> { cornerX = halfWidth; cornerY = -halfHeight }
      adjustedAngle < 270 -> { cornerX = -halfWidth; cornerY = -halfHeight }
      else -> { cornerX = -halfWidth; cornerY = halfHeight }
    }
    val c = cornerY - perpendicularSlope * cornerX
    val endX = c / (slope - perpendicularSlope)
    val endY = perpendicularSlope * endX + c
    return floatArrayOf(halfWidth - endX, halfHeight + endY, halfWidth + endX, halfHeight - endY)
  }

  /** Yoga's pixel grid for an absolute edge: half up on the scaled value (01-architecture.md §8). */
  fun px(dp: Double, density: Double): Int = Math.floor(dp * density + 0.5).toInt()
}
