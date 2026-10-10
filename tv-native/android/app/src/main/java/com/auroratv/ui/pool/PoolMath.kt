package com.auroratv.ui.pool

/**
 * The recycling shelf and grid: which SLOT shows which ITEM — the Kotlin twin of
 * src/poolMath.ts. Pure JVM; held to the JS by tools/gen-pool-fixtures.js →
 * src/test/resources/pool-fixtures.json → PoolMathTest.
 *
 * Item `i` lives in slot `i mod pool`. A window is at most `pool` consecutive indices, so
 * its items never share a slot, and an item that stays in the window across a move keeps
 * its slot: only the slots whose item left are rebound.
 *
 * What the views use today: [gridIndexOf] (AuroraGridView names the focused card from its
 * laid-out edges) and [paintOrder] (PoolHost: slots are painted in item order although
 * they are mounted in slot order). The assignment itself is still decided in JS, which
 * commits it as props; [slotItems], [poolAnchor], [gridWindow], [gridAnchor] and
 * [gridSlotItems] are here, tested, for the step that binds the slots natively
 * (docs/qa/native-bench/POOL-PLAN.md, "the further step").
 */
object PoolMath {
  const val GRID_BEHIND = 3
  const val GRID_AHEAD = 4
  const val GRID_SLACK = 2

  fun poolSize(behind: Int, ahead: Int): Int = behind + ahead + 1

  fun slotOf(index: Int, pool: Int): Int = ((index % pool) + pool) % pool

  /** Slot → the item it shows for the window `[from, to)`, -1 for an unfilled slot. */
  fun slotItems(from: Int, to: Int, pool: Int): IntArray {
    val out = IntArray(pool) { -1 }
    for (i in from until to) out[slotOf(i, pool)] = i
    return out
  }

  /** Row.tsx's anchor rule, refused when `latest` would fall outside the window it produces. */
  fun poolAnchor(prev: Int, index: Int, latest: Int, count: Int, slack: Int, behind: Int, ahead: Int): Int {
    val next = if (Math.abs(index - prev) >= slack) index else prev
    if (next == prev) return prev
    val from = Math.max(0, next - behind)
    val to = Math.min(count, next + ahead + 1)
    return if (latest in from until to) next else prev
  }

  fun gridRows(count: Int, cols: Int): Int = if (cols > 0) (count + cols - 1) / cols else 0

  /** The mounted rows `[from, to)`, packed as `from to`: always the pool's length when the grid has that many rows. */
  fun gridWindow(anchorRow: Int, rows: Int, behind: Int = GRID_BEHIND, ahead: Int = GRID_AHEAD): IntArray {
    val pool = poolSize(behind, ahead)
    val from = Math.max(0, Math.min(anchorRow - behind, rows - pool))
    return intArrayOf(from, Math.min(rows, from + pool))
  }

  fun gridAnchor(
    prev: Int,
    row: Int,
    latestRow: Int,
    rows: Int,
    slack: Int = GRID_SLACK,
    behind: Int = GRID_BEHIND,
    ahead: Int = GRID_AHEAD,
  ): Int {
    val next = if (Math.abs(row - prev) >= slack) row else prev
    if (next == prev) return prev
    val w = gridWindow(next, rows, behind, ahead)
    return if (latestRow >= w[0] && latestRow < w[1]) next else prev
  }

  /** Slot → item for rows `[fromRow, toRow)`; -1 where the row is not mounted or the last row ends early. */
  fun gridSlotItems(fromRow: Int, toRow: Int, cols: Int, count: Int, poolRows: Int): IntArray {
    val out = IntArray(poolRows * cols) { -1 }
    for (r in fromRow until toRow) {
      val base = slotOf(r, poolRows) * cols
      for (c in 0 until cols) {
        val i = r * cols + c
        if (i < count) out[base + c] = i
      }
    }
    return out
  }

  /** Which item a direct child of the grid is, from its laid-out left / top edge in dp. */
  fun gridIndexOf(left: Double, top: Double, colPitch: Double, rowPitch: Double, cols: Int, count: Int): Int {
    if (!(colPitch > 0) || !(rowPitch > 0) || cols <= 0) return 0
    val col = Math.min((cols - 1).toDouble(), Math.max(0.0, Math.floor(left / colPitch + 0.5)))
    val row = Math.max(0.0, Math.floor(top / rowPitch + 0.5))
    val i = row * cols + col
    val hi = if (count > 0) (count - 1).toDouble() else Int.MAX_VALUE.toDouble()
    return Math.min(hi, Math.max(0.0, i)).toInt()
  }

  /**
   * Child indices in paint order: by top, then left (stable). `out` is reused when it is
   * long enough; only its first `n` entries are meaningful.
   */
  fun paintOrder(tops: IntArray, lefts: IntArray, n: Int, out: IntArray): IntArray {
    val p = if (out.size >= n) out else IntArray(n)
    for (i in 0 until n) p[i] = i
    for (i in 1 until n) {
      val v = p[i]
      var j = i - 1
      while (j >= 0 && (tops[p[j]] > tops[v] || (tops[p[j]] == tops[v] && lefts[p[j]] > lefts[v]))) {
        p[j + 1] = p[j]
        j--
      }
      p[j + 1] = v
    }
    return p
  }
}
