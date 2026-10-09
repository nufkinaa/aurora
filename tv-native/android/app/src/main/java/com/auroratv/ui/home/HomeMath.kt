package com.auroratv.ui.home

import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Bezier
import com.auroratv.ui.anim.Interpolation

/**
 * Home's column and billboard arithmetic — the Kotlin twin of src/homeMath.ts, which
 * restates Home.tsx's inline expressions. Pure JVM; held to the JS by
 * tools/gen-home-fixtures.js → src/test/resources/home-fixtures.json → HomeMathTest.
 *
 * The column's resting offsets are NOT derived here: Home.tsx measures its rows and hands
 * the finished targets over (`targets` prop). What is decided natively is which target a
 * focus change selects ([markerOf] + [targetFor]) and how the art follows the column
 * ([artFade], [dim], [scrolledAlpha]).
 */
object HomeMath {
  /** Any value > 0 in `targets`: "this row has not been measured yet" (a real target is <= 0). */
  const val NO_TARGET = 1.0

  /** [markerOf]: not one of the column's marked children. */
  const val NONE = -2

  /** [markerOf]: the hero block — the column's top (`toHero`, Home.tsx). */
  const val TOP = -1

  const val TOP_ID = "aurora-col-top"
  const val ROW_ID_PREFIX = "aurora-col-row-"

  /** The nativeID Home.tsx puts on the hero block and on each shelf's wrapper → TOP, the row's index, or NONE. */
  fun markerOf(nativeId: String?): Int {
    if (nativeId == null) return NONE
    if (nativeId == TOP_ID) return TOP
    if (!nativeId.startsWith(ROW_ID_PREFIX)) return NONE
    val n = nativeId.substring(ROW_ID_PREFIX.length)
    if (n.isEmpty() || n.length > 6) return NONE
    for (ch in n) if (ch < '0' || ch > '9') return NONE
    return n.toInt()
  }

  /**
   * Where the column goes when focus lands on `marker`: 0 for the hero (`ty.to(0)`), the
   * row's measured target, or NaN — no slide — for an unmeasured row (`if (y == null) return`)
   * and for anything unmarked.
   */
  fun targetFor(targets: DoubleArray, marker: Int): Double {
    if (marker == TOP) return 0.0
    if (marker < 0 || marker >= targets.size) return Double.NaN
    val t = targets[marker]
    return if (t.isNaN() || t > 0.0) Double.NaN else t
  }

  /**
   * Home.tsx toRow, for the fixtures only (the app passes finished targets):
   * `-Math.min(Math.max(0, y - spacing.pageY), Math.max(0, colH - height))`.
   */
  fun rowTarget(y: Double, colH: Double, height: Double, pageY: Double): Double =
    -Math.min(Math.max(0.0, y - pageY), Math.max(0.0, colH - height))

  /**
   * The art's opacity for a column offset (Home.tsx artFade): `ty` interpolated
   * `[fadeOutAt, fadeInAt, 0] → [0, 1, 1]`, clamped; the two stops are
   * `-round(heroH * 0.9)` and `-round(heroH * 0.3)`, computed by Home.tsx.
   */
  fun artFade(offset: Double, fadeOutAt: Double, fadeInAt: Double): Double =
    Interpolation.clamp(offset, doubleArrayOf(fadeOutAt, fadeInAt, 0.0), ART_FADE_OUT)

  /** HeroArt's dim: `atTop` `[0, 1] → [SCROLLED.dim, REST.dim]`. */
  fun dim(atTop: Double, scrolledDim: Double, restDim: Double): Double =
    Interpolation.segment(atTop, 0.0, 1.0, scrolledDim, restDim)

  /** HeroArt's scrolled layer: `atTop` `[0, 1] → [1, 0]`. */
  fun scrolledAlpha(atTop: Double): Double = Interpolation.segment(atTop, 0.0, 1.0, 1.0, 0.0)

  private val ART_FADE_OUT = doubleArrayOf(0.0, 1.0, 1.0)

  // Home.tsx:72 EASE = bezier(0.2, 0.7, 0.2, 1); setTop's `duration: motion.med` (280 ms)
  private val EASE = Bezier(0.2, 0.7, 0.2, 1.0)

  /** `Animated.timing(atTop, {duration: 280, easing: EASE})`, pre-sampled as RN's JS does. */
  val AT_TOP_FRAMES: DoubleArray = AuroraTiming.sample(280.0) { EASE.ease(it) }

  /** Home.tsx:154 — `fadeDuration={260}` on the rest layer (Fresco's own fade). */
  const val REST_FADE_MS = 260
}
