package com.auroratv.ui.pool

import com.auroratv.ui.row.RowMath
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The recycling shelf / grid arithmetic against src/poolMath.ts (tools/gen-pool-fixtures.js →
 * src/test/resources/pool-fixtures.json; the generator proves the invariants on the JS over
 * its focus walks before it writes anything). Regenerate with `node tools/gen-pool-fixtures.js`
 * after touching poolMath.ts, Row.tsx's window constants or NativeGrid.tsx.
 *
 * The second half replays walks with the Kotlin functions alone and checks the same
 * invariants, so the twin is held to the rule and not only to the sampled cases.
 */
class PoolMathTest {
  private val fx: JSONObject by lazy {
    val text = javaClass.classLoader!!.getResourceAsStream("pool-fixtures.json")!!.bufferedReader().readText()
    JSONObject(text)
  }

  private fun JSONArray.ints(): IntArray = IntArray(length()) { getInt(it) }

  private val k get() = fx.getJSONObject("constants")

  @Test
  fun constantsAreTheJs() {
    assertEquals(k.getInt("behind"), RowMath.VISIBLE_BEHIND)
    assertEquals(k.getInt("ahead"), RowMath.VISIBLE_AHEAD)
    assertEquals(k.getInt("slack"), RowMath.WINDOW_SLACK)
    assertEquals(k.getInt("pool"), PoolMath.poolSize(RowMath.VISIBLE_BEHIND, RowMath.VISIBLE_AHEAD))
    assertEquals(9, k.getInt("pool"))
    assertEquals(k.getInt("gridBehind"), PoolMath.GRID_BEHIND)
    assertEquals(k.getInt("gridAhead"), PoolMath.GRID_AHEAD)
    assertEquals(k.getInt("gridSlack"), PoolMath.GRID_SLACK)
    assertEquals(k.getInt("gridPoolRows"), PoolMath.poolSize(PoolMath.GRID_BEHIND, PoolMath.GRID_AHEAD))
    // 10e-spec §2.2 as the code has it: a 124 x 186 card at a 13 dp gap
    assertEquals(137, k.getInt("colPitch"))
    assertEquals(199, k.getInt("rowPitch"))
  }

  @Test
  fun slotOfMatches() {
    val cases = fx.getJSONArray("slotOf")
    assertTrue(cases.length() > 0)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals("slotOf(${c.getInt("index")}, ${c.getInt("pool")})", c.getInt("slot"), PoolMath.slotOf(c.getInt("index"), c.getInt("pool")))
    }
  }

  @Test
  fun slotItemsMatches() {
    val cases = fx.getJSONArray("slotItems")
    assertTrue(cases.length() > 20)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = PoolMath.slotItems(c.getInt("from"), c.getInt("to"), c.getInt("pool"))
      assertArrayEquals("slotItems(${c.getInt("from")}, ${c.getInt("to")})", c.getJSONArray("slots").ints(), got)
    }
  }

  @Test
  fun poolAnchorMatches() {
    val cases = fx.getJSONArray("poolAnchor")
    assertTrue(cases.length() > 100)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = PoolMath.poolAnchor(
        c.getInt("prev"), c.getInt("index"), c.getInt("latest"), c.getInt("count"),
        RowMath.WINDOW_SLACK, RowMath.VISIBLE_BEHIND, RowMath.VISIBLE_AHEAD,
      )
      assertEquals("poolAnchor(${c.getInt("prev")}, ${c.getInt("index")}, ${c.getInt("latest")}, ${c.getInt("count")})", c.getInt("next"), got)
    }
  }

  @Test
  fun gridWindowAndAnchorMatch() {
    val windows = fx.getJSONArray("gridWindow")
    assertTrue(windows.length() > 20)
    for (i in 0 until windows.length()) {
      val c = windows.getJSONObject(i)
      val w = PoolMath.gridWindow(c.getInt("anchor"), c.getInt("rows"))
      val at = "gridWindow(${c.getInt("anchor")}, ${c.getInt("rows")})"
      assertEquals("$at from", c.getInt("from"), w[0])
      assertEquals("$at to", c.getInt("to"), w[1])
    }
    val anchors = fx.getJSONArray("gridAnchor")
    assertTrue(anchors.length() > 50)
    for (i in 0 until anchors.length()) {
      val c = anchors.getJSONObject(i)
      val got = PoolMath.gridAnchor(c.getInt("prev"), c.getInt("row"), c.getInt("latestRow"), c.getInt("rows"))
      assertEquals("gridAnchor(${c.getInt("prev")}, ${c.getInt("row")}, ${c.getInt("latestRow")}, ${c.getInt("rows")})", c.getInt("next"), got)
    }
  }

  @Test
  fun gridSlotItemsMatches() {
    val cases = fx.getJSONArray("gridSlotItems")
    assertTrue(cases.length() > 20)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = PoolMath.gridSlotItems(c.getInt("fromRow"), c.getInt("toRow"), c.getInt("cols"), c.getInt("count"), c.getInt("poolRows"))
      assertArrayEquals("gridSlotItems(${c.getInt("fromRow")}, ${c.getInt("toRow")}, ${c.getInt("cols")}, ${c.getInt("count")})", c.getJSONArray("slots").ints(), got)
      assertEquals(PoolMath.gridRows(c.getInt("count"), c.getInt("cols")), (c.getInt("count") + c.getInt("cols") - 1) / c.getInt("cols"))
    }
  }

  @Test
  fun gridIndexOfMatches() {
    val cases = fx.getJSONArray("gridIndexOf")
    assertTrue(cases.length() > 100)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = PoolMath.gridIndexOf(
        c.getDouble("left"), c.getDouble("top"), c.getDouble("colPitch"), c.getDouble("rowPitch"), c.getInt("cols"), c.getInt("count"),
      )
      assertEquals("gridIndexOf(${c.getDouble("left")}, ${c.getDouble("top")}) @${c.getDouble("density")}", c.getInt("index"), got)
    }
    assertEquals(0, PoolMath.gridIndexOf(300.0, 300.0, 0.0, 199.0, 6, 120))
  }

  @Test
  fun paintOrderMatches() {
    val cases = fx.getJSONArray("paintOrder")
    assertTrue(cases.length() > 5)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val tops = c.getJSONArray("tops").ints()
      val lefts = c.getJSONArray("lefts").ints()
      val want = c.getJSONArray("order").ints()
      // a scratch array longer than needed, as PoolHost reuses one
      val got = PoolMath.paintOrder(tops, lefts, tops.size, IntArray(tops.size + 3) { -7 })
      assertArrayEquals(c.getString("name"), want, got.copyOf(tops.size))
      assertArrayEquals(c.getString("name") + " (fresh array)", want, PoolMath.paintOrder(tops, lefts, tops.size, IntArray(0)).copyOf(tops.size))
    }
  }

  // ---- the rule itself, replayed in Kotlin -------------------------------------------------

  /** One press toward `want`: focus moves a card only if that card is mounted. */
  private fun stepToward(focus: Int, want: Int, from: Int, to: Int): Int {
    val next = if (want > focus) focus + 1 else if (want < focus) focus - 1 else focus
    return if (next != focus && next >= from && next < to) next else focus
  }

  @Test
  fun aShelfNeverRebindsTheFocusedSlot() {
    val pool = PoolMath.poolSize(RowMath.VISIBLE_BEHIND, RowMath.VISIBLE_AHEAD)
    for (count in intArrayOf(1, 5, 9, 10, 23, 40)) {
      for (lag in 0..6) {
        // right to the end, back to the start, then short reversals
        val wants = ArrayList<Int>()
        repeat(count + 3) { wants.add(Int.MAX_VALUE) }
        repeat(count + 3) { wants.add(0) }
        for (i in 0 until 80) wants.add(if ((i / (2 + i % 5)) % 2 == 0) Int.MAX_VALUE else 0)
        var anchor = 0
        var focus = 0
        var win = RowMath.windowRange(anchor, count)
        var slots = PoolMath.slotItems(win[0], win[1], pool)
        val queue = ArrayDeque<IntArray>()
        for ((t, want) in wants.withIndex()) {
          focus = stepToward(focus, want.coerceAtMost(count - 1), win[0], win[1])
          queue.addLast(intArrayOf(t + lag, focus))
          var next = anchor
          while (queue.isNotEmpty() && queue.first()[0] <= t) {
            val index = queue.removeFirst()[1]
            next = PoolMath.poolAnchor(next, index, focus, count, RowMath.WINDOW_SLACK, RowMath.VISIBLE_BEHIND, RowMath.VISIBLE_AHEAD)
            if (lag == 0) assertEquals("up to date, the anchor is Row.tsx's", RowMath.nextAnchor(anchor, index), next)
          }
          if (next == anchor) continue
          anchor = next
          val w = RowMath.windowRange(anchor, count)
          val s = PoolMath.slotItems(w[0], w[1], pool)
          val at = "count $count lag $lag press $t focus $focus window [${w[0]},${w[1]})"
          assertTrue("$at: the focused card is mounted", focus >= w[0] && focus < w[1])
          var mounted = 0
          var unmounted = 0
          for (k in 0 until pool) {
            if (slots[k] == s[k]) continue
            assertTrue("$at: the focused card's slot $k was rebound", slots[k] != focus)
            if (slots[k] < 0) mounted++ else if (s[k] < 0) unmounted++
          }
          val grew = (w[1] - w[0]) - (win[1] - win[0])
          assertEquals("$at: mounts only when the window grows", Math.max(0, grew), mounted)
          assertEquals("$at: unmounts only when the window shrinks", Math.max(0, -grew), unmounted)
          for (i in Math.max(w[0], win[0]) until Math.min(w[1], win[1])) {
            assertEquals("$at: item $i kept its slot", slots.indexOf(i), s.indexOf(i))
          }
          win = w
          slots = s
        }
      }
    }
  }

  @Test
  fun aGridKeepsItsPoolAndTheFocusedSlot() {
    val poolRows = PoolMath.poolSize(PoolMath.GRID_BEHIND, PoolMath.GRID_AHEAD)
    for (cols in intArrayOf(3, 6)) {
      for (count in intArrayOf(1, cols * 2 + 1, cols * 8, cols * 20, cols * 20 + 1)) {
        val rows = PoolMath.gridRows(count, cols)
        for (lag in 0..6) {
          val wants = ArrayList<Int>()
          repeat(rows + 2) { wants.add(Int.MAX_VALUE) }
          repeat(rows + 2) { wants.add(0) }
          for (i in 0 until 60) wants.add(if ((i / (1 + i % 4)) % 2 == 0) Int.MAX_VALUE else 0)
          var anchor = 0
          var focusRow = 0
          var win = PoolMath.gridWindow(anchor, rows)
          var slots = PoolMath.gridSlotItems(win[0], win[1], cols, count, poolRows)
          val queue = ArrayDeque<IntArray>()
          for ((t, want) in wants.withIndex()) {
            focusRow = stepToward(focusRow, want.coerceAtMost(rows - 1), win[0], win[1])
            queue.addLast(intArrayOf(t + lag, focusRow))
            var next = anchor
            while (queue.isNotEmpty() && queue.first()[0] <= t) {
              next = PoolMath.gridAnchor(next, queue.removeFirst()[1], focusRow, rows)
            }
            if (next == anchor) continue
            anchor = next
            val w = PoolMath.gridWindow(anchor, rows)
            val s = PoolMath.gridSlotItems(w[0], w[1], cols, count, poolRows)
            val at = "cols $cols count $count lag $lag press $t row $focusRow window [${w[0]},${w[1]})"
            assertEquals("$at: the window is the pool", Math.min(poolRows, rows), w[1] - w[0])
            assertTrue("$at: the focused row is mounted", focusRow >= w[0] && focusRow < w[1])
            val fullBefore = count % cols == 0 || win[1] < rows
            val fullAfter = count % cols == 0 || w[1] < rows
            for (k in s.indices) {
              if (slots[k] == s[k]) continue
              // every card of the focused row keeps its slot
              assertTrue("$at: a slot of the focused row was rebound", slots[k] < 0 || slots[k] / cols != focusRow)
              if (fullBefore && fullAfter) assertTrue("$at: a move between full windows only rebinds", slots[k] >= 0 && s[k] >= 0)
            }
            win = w
            slots = s
          }
        }
      }
    }
  }
}
