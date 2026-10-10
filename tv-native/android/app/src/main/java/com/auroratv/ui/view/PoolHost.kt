package com.auroratv.ui.view

import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import com.auroratv.ui.pool.PoolMath
import com.auroratv.ui.qa.AuroraQa

/**
 * What a container of RECYCLED slots needs beyond holding them (docs/qa/native-bench/
 * POOL-PLAN.md). Used by AuroraRowView under the `pool` experiment and by AuroraGridView.
 *
 * 1. PAINT ORDER. The slots are React children in SLOT order — fixed for the life of the
 *    container, which is the point: a window move must not add, remove or even reorder a
 *    child. But slot order is not item order (slot 0 shows item 0, then 9, then 18 …), and
 *    the order children are painted in is part of the picture: a lit card's shadow reaches
 *    over its neighbours, landing ON the ones painted before it and UNDER the ones painted
 *    after. Ordinary children are painted in item order, so the host paints its slots sorted
 *    by where they are laid out — top, then left ([PoolMath.paintOrder]). The host asks
 *    [beginDraw] at the top of its dispatchDraw (a moved slot invalidates its parent, so a
 *    rebind always re-records the list) and [order] from getChildDrawingOrder.
 *
 * 2. THE MOUNT COUNT. `[pool] <uptimeMs> <name> tag=<id> focus=<index> direct=+a/-r
 *    desc=+c/-d views=<n>` (tag AuroraAnim) on every focus change inside the host while the
 *    QA `focuslog` flag is on: how many direct children Fabric added to / removed from the
 *    host, and how many views anywhere under it appeared / disappeared, SINCE THE PREVIOUS
 *    LINE of this host. "desc" is found by comparing the identities of the views under the
 *    host now with those at the previous line, so it also sees what happens inside a card
 *    (a NEW pill or a progress bar that one item has and the next has not). Nothing is
 *    walked, kept or formatted while the flag is off.
 */
internal class PoolHost(private val host: ViewGroup, private val name: String) {

  // ---- paint order ----------------------------------------------------------------------
  private var tops = IntArray(0)
  private var lefts = IntArray(0)
  private var perm = IntArray(0)
  /** How many children [perm] was computed for; -1 = never. */
  private var n = -1

  /** The host is about to record its children: fix the order this recording paints them in. */
  fun beginDraw() {
    val c = host.childCount
    if (tops.size < c) {
      tops = IntArray(c)
      lefts = IntArray(c)
      perm = IntArray(c)
    }
    for (i in 0 until c) {
      val v = host.getChildAt(i)
      tops[i] = v.top
      lefts[i] = v.left
    }
    perm = PoolMath.paintOrder(tops, lefts, c, perm)
    n = c
  }

  /** getChildDrawingOrder: the child painted at `position`. Identity until the first [beginDraw] or when the count moved. */
  fun order(childCount: Int, position: Int): Int =
    if (childCount == n && position in 0 until n) perm[position] else position

  // ---- the mount count --------------------------------------------------------------------
  private var added = 0
  private var removed = 0
  private var seen: HashSet<Int>? = null

  fun childAdded() {
    added++
  }

  fun childRemoved() {
    removed++
  }

  /** Focus landed on item `index` inside the host. */
  fun pressed(index: Int) {
    if (!AuroraQa.focuslog) {
      // not logging: keep nothing, so the first line after the flag turns on starts clean
      if (seen != null) seen = null
      added = 0
      removed = 0
      return
    }
    val now = HashSet<Int>(256)
    collect(host, now)
    val before = seen
    var came = 0
    var went = 0
    if (before != null) {
      for (id in now) if (id !in before) came++
      for (id in before) if (id !in now) went++
    }
    seen = now
    Log.d(
      AuroraQa.TAG_ANIM,
      "[pool] ${SystemClock.uptimeMillis()} $name tag=${AuroraQa.tagOf(host)} focus=$index " +
        "direct=+$added/-$removed desc=+$came/-$went views=${now.size}" + if (before == null) " first" else "",
    )
    added = 0
    removed = 0
  }

  private fun collect(v: View, into: HashSet<Int>) {
    if (v !== host) into.add(System.identityHashCode(v))
    if (v is ViewGroup) for (i in 0 until v.childCount) collect(v.getChildAt(i), into)
  }
}
