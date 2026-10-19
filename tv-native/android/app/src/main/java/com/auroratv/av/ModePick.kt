package com.auroratv.av

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * WHICH SCREEN MODE SHOWS A FILM WITHOUT JUDDER (TV round 2026-10-19,
 * refresh-rate matching). Pure: AvModule.kt hands it the display's modes,
 * the JVM tests (ModePickTest.kt) hold it to its rules.
 *
 * A film at `fps` shows smoothly on a refresh rate that is a whole multiple of
 * it: 23.976 on 23.976 / 47.952 / 119.88 Hz, 25 on 50, 29.97 on 59.94. Near is
 * a rate 0.1 % off (24 Hz for 23.976, 60 for 59.94): one repeated frame every
 * 40 seconds or so, far better than the 3:2 judder of 23.976 on 60 Hz, but
 * worth leaving only for an exact one.
 *
 *  - the RESOLUTION never changes (a 4K panel stays 4K; only the rate moves);
 *  - a screen that already shows the film exactly is left alone (30 fps on
 *    60 Hz, 25 on 50: no blink for nothing);
 *  - exact beats near; among equals, the lowest multiple (the film's own rate
 *    first, then twice it…), and nothing under 23 Hz;
 *  - near is taken only when the screen is not near already.
 */
object ModePick {
  data class Mode(val id: Int, val w: Int, val h: Int, val hz: Float)

  /** How a refresh rate fits a frame rate: 0 exact, 1 near, -1 not at all. */
  fun fit(hz: Float, fps: Float): Int {
    if (fps <= 0f || hz <= 0f) return -1
    val k = (hz / fps).roundToInt()
    if (k < 1) return -1
    val off = abs(hz - k * fps) / hz
    return when {
      off < EXACT -> 0
      off < NEAR -> 1
      else -> -1
    }
  }

  /** The mode to switch to, or null when the screen should stay as it is. */
  fun choose(current: Mode, modes: List<Mode>, fps: Float): Mode? {
    if (fps < 10f || fps > 121f) return null
    val now = fit(current.hz, fps)
    if (now == 0) return null
    val same = modes.filter { it.w == current.w && it.h == current.h && it.hz >= 23f }
    val ranked = same
      .map { it to fit(it.hz, fps) }
      .filter { (_, f) -> f >= 0 }
      .sortedWith(compareBy({ it.second }, { (it.first.hz / fps).roundToInt() }, { it.first.id }))
    val best = ranked.firstOrNull() ?: return null
    if (best.second == 1 && now == 1) return null // near already: not worth the blink
    return if (best.first.id == current.id) null else best.first
  }

  /** Relative error under which a rate counts as exact (23.976 vs 24000/1001: 0.00002). */
  const val EXACT = 0.0005f
  /** …and as near (24 vs 23.976: 0.001). */
  const val NEAR = 0.0015f
}
