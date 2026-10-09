package com.auroratv.ui.row

import com.auroratv.ui.anim.AuroraSpring
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The native row's arithmetic against the JS reference row (tools/gen-row-fixtures.js →
 * src/test/resources/row-fixtures.json: constants read out of Row.tsx / Card.tsx / theme.ts,
 * the rules re-stated from Row.tsx and checked against src/rowMath.ts). Regenerate with
 * `node tools/gen-row-fixtures.js` after touching Row.tsx's geometry or window constants.
 */
class RowMathTest {
  private val fx: JSONObject by lazy {
    val text = javaClass.classLoader!!.getResourceAsStream("row-fixtures.json")!!.bufferedReader().readText()
    JSONObject(text)
  }

  private fun JSONArray.doubles(): DoubleArray = DoubleArray(length()) { getDouble(it) }
  private fun JSONArray.longs(): LongArray = LongArray(length()) { getString(it).toLong() }

  @Test
  fun constantsAreRowTsxs() {
    val c = fx.getJSONObject("constants")
    assertEquals(c.getInt("lead"), RowMath.LEAD)
    assertEquals(c.getInt("ahead"), RowMath.VISIBLE_AHEAD)
    assertEquals(c.getInt("behind"), RowMath.VISIBLE_BEHIND)
    assertEquals(c.getInt("slack"), RowMath.WINDOW_SLACK)
    // 10c-spec §7.1: 138 (poster) / 238 (frame), content from 84
    assertEquals(138, c.getJSONObject("steps").getInt("poster"))
    assertEquals(238, c.getJSONObject("steps").getInt("frame"))
    assertEquals(84, c.getInt("contentLeft"))
  }

  @Test
  fun slideTargetMatchesRowTsx() {
    val cases = fx.getJSONArray("slideTargets")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = RowMath.slideTarget(c.getInt("index"), c.getDouble("step"))
      assertEquals("${c.getString("shape")} index ${c.getInt("index")}", c.getDouble("target"), got, 0.0)
    }
    // LEAD 1: cards 0 and 1 both rest at 0; no clamp at the far end
    assertEquals(0.0, RowMath.slideTarget(0, 138.0), 0.0)
    assertEquals(0.0, RowMath.slideTarget(1, 138.0), 0.0)
    assertEquals(-138.0, RowMath.slideTarget(2, 138.0), 0.0)
  }

  @Test
  fun windowMatchesRowTsx() {
    val walks = fx.getJSONArray("windowWalks")
    for (i in 0 until walks.length()) {
      val w = walks.getJSONObject(i)
      val count = w.getInt("count")
      var anchor = 0
      val steps = w.getJSONArray("steps")
      for (k in 0 until steps.length()) {
        val s = steps.getJSONArray(k)
        anchor = RowMath.nextAnchor(anchor, s.getInt(0))
        val range = RowMath.windowRange(anchor, count)
        val at = "${w.getString("name")}[$k] focus ${s.getInt(0)}"
        assertEquals("$at anchor", s.getInt(1), anchor)
        assertEquals("$at from", s.getInt(2), range[0])
        assertEquals("$at to", s.getInt(3), range[1])
      }
    }
  }

  @Test
  fun indexOfLeftNamesTheSlot() {
    val cases = fx.getJSONArray("indexOfLeft")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = RowMath.indexOfLeft(c.getDouble("left"), c.getDouble("contentLeft"), c.getDouble("step"), c.getInt("count"))
      assertEquals("left ${c.getDouble("left")} @${c.getDouble("density")} count ${c.getInt("count")}", c.getInt("index"), got)
    }
    assertEquals(0, RowMath.indexOfLeft(500.0, 84.0, 0.0, 40)) // no step yet: never divide
  }

  @Test
  fun slideSpringIsMotionTsSlideSpring() {
    val s = fx.getJSONObject("slideSpring")
    assertEquals(s.getDouble("stiffness"), RowMath.SLIDE_STIFFNESS, 1e-12)
    assertEquals(s.getDouble("damping"), RowMath.SLIDE_DAMPING, 1e-12)
    // 01-architecture.md §6.3: 342.1 / 36.93, ζ ≈ 0.998
    assertEquals(342.1, RowMath.SLIDE_STIFFNESS, 0.05)
    assertEquals(36.93, RowMath.SLIDE_DAMPING, 0.005)
  }

  /**
   * AuroraRowView's driver, replayed: every focus landing replaces the spring, which picks
   * the value up where the last frame left it; a finished spring steps no more until the
   * next landing. Value for value against RN's native SpringAnimation fed Row.tsx's targets.
   */
  @Test
  fun slideJourneysMatchTheJsRow() {
    val runs = fx.getJSONArray("slideRuns")
    for (i in 0 until runs.length()) {
      val r = runs.getJSONObject(i)
      val name = r.getString("name")
      val step = r.getDouble("step")
      val times = r.getJSONArray("frameTimesNanos").longs()
      val want = r.getJSONArray("values").doubles()
      val focus = r.getJSONArray("focus")
      val landings = HashMap<Int, Int>()
      for (k in 0 until focus.length()) landings[focus.getJSONObject(k).getInt("frame")] = focus.getJSONObject(k).getInt("index")

      var value = 0.0
      var spring: AuroraSpring? = null
      val got = ArrayList<Double>()
      for ((frame, t) in times.withIndex()) {
        landings[frame]?.let { index ->
          spring = AuroraSpring(RowMath.SLIDE_STIFFNESS, RowMath.SLIDE_DAMPING, 1.0, RowMath.slideTarget(index, step))
        }
        val d = spring ?: continue
        value = d.step(t, value)
        got.add(value)
        if (d.finished) spring = null
      }
      assertEquals("$name step count", want.size, got.size)
      for (k in want.indices) assertEquals("$name[$k]", want[k], got[k], 1e-9 * step)
      // the gate of 00-plan.md P3 is 1e-3 dp per frame; the journey must also end on its target
      val last = RowMath.slideTarget(focus.getJSONObject(focus.length() - 1).getInt("index"), step)
      assertEquals("$name rests on its target", last, got.last(), 1e-3)
    }
  }
}
