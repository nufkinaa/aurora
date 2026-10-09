package com.auroratv.ui.row

import com.auroratv.ui.anim.AuroraSpring

/**
 * The shelf's arithmetic — the Kotlin twin of src/rowMath.ts, which restates Row.tsx's
 * inline expressions. Pure JVM; held to the JS by tools/gen-row-fixtures.js →
 * src/test/resources/row-fixtures.json → RowMathTest.
 *
 * P3 uses [slideTarget], [indexOfLeft] and the spring constants (AuroraRowView). [nextAnchor] and [windowRange]
 * are the mounted-window rule, still decided in JS in P3; they are here, tested, for the
 * step that moves the window into the native row.
 */
object RowMath {
  const val LEAD = 1
  const val VISIBLE_AHEAD = 5
  const val VISIBLE_BEHIND = 3
  const val WINDOW_SLACK = 3

  // motion.ts SLIDE_SPRING {speed: 12, bounciness: 0} through RN's SpringConfig.js
  // → stiffness 342.1 / damping 36.93 (mass 1), critically damped (01-architecture.md §6.3).
  private val SLIDE = AuroraSpring.fromBouncinessAndSpeed(0.0, 12.0)
  val SLIDE_STIFFNESS: Double = SLIDE.first
  val SLIDE_DAMPING: Double = SLIDE.second

  /** Row.tsx focusCard: `-Math.max(0, (index - LEAD) * step)` — dp, no far-end clamp. */
  fun slideTarget(index: Int, step: Double, lead: Int = LEAD): Double = -Math.max(0.0, (index - lead) * step)

  /** Row.tsx focusCard's setAnchor: `Math.abs(index - prev) >= WINDOW_SLACK ? index : prev`. */
  fun nextAnchor(prev: Int, index: Int, slack: Int = WINDOW_SLACK): Int =
    if (Math.abs(index - prev) >= slack) index else prev

  /** Row.tsx from/to: the mounted slice `[from, to)`, packed as `from to`. */
  fun windowRange(anchor: Int, count: Int, behind: Int = VISIBLE_BEHIND, ahead: Int = VISIBLE_AHEAD): IntArray =
    intArrayOf(Math.max(0, anchor - behind), Math.min(count, anchor + ahead + 1))

  /**
   * Which card a direct child of the track is, from its laid-out left edge in dp (slots sit
   * at `contentLeft + index * step`). Rounded half-up; clamped to `[0, count)` when the
   * count is known (> 0).
   */
  fun indexOfLeft(left: Double, contentLeft: Double, step: Double, count: Int): Int {
    if (!(step > 0)) return 0
    val i = Math.floor((left - contentLeft) / step + 0.5)
    val hi = if (count > 0) (count - 1).toDouble() else Int.MAX_VALUE.toDouble()
    return Math.min(hi, Math.max(0.0, i)).toInt()
  }
}
