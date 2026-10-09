package com.auroratv.ui.home

import com.auroratv.ui.anim.AuroraSpring
import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Interpolation
import com.auroratv.ui.row.RowMath
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Home's native column and billboard arithmetic against the JS reference
 * (tools/gen-home-fixtures.js → src/test/resources/home-fixtures.json: constants read out of
 * Home.tsx / theme.ts, the rules re-stated from Home.tsx and checked against src/homeMath.ts).
 * Regenerate with `node tools/gen-home-fixtures.js` after touching Home.tsx's column or art.
 */
class HomeMathTest {
  private val fx: JSONObject by lazy {
    val text = javaClass.classLoader!!.getResourceAsStream("home-fixtures.json")!!.bufferedReader().readText()
    JSONObject(text)
  }

  private fun JSONArray.doubles(): DoubleArray = DoubleArray(length()) { getDouble(it) }
  private fun JSONArray.longs(): LongArray = LongArray(length()) { getString(it).toLong() }

  @Test
  fun constantsAreHomeTsxs() {
    val c = fx.getJSONObject("constants")
    // 10d-spec §2.2 / §2.4 / §2.5 / §5
    assertEquals(0.45, c.getDouble("restDim"), 0.0)
    assertEquals(0.42, c.getDouble("scrolledDim"), 0.0)
    assertEquals(0.9, c.getDouble("fadeOutK"), 0.0)
    assertEquals(0.3, c.getDouble("fadeInK"), 0.0)
    assertEquals(27, c.getInt("pageY"))
    assertEquals(280, c.getInt("med"))
    assertEquals(HomeMath.REST_FADE_MS, c.getInt("restFadeMs"))
    assertEquals(HomeMath.NO_TARGET, fx.getDouble("noTarget"), 0.0)
  }

  @Test
  fun markersAreHomeMathTss() {
    val cases = fx.getJSONArray("markers")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals("'${c.getString("id")}'", c.getInt("marker"), HomeMath.markerOf(c.getString("id")))
    }
    assertEquals(HomeMath.NONE, HomeMath.markerOf(null))
    assertEquals(-1, HomeMath.TOP)
    assertEquals(-2, HomeMath.NONE)
  }

  @Test
  fun rowTargetMatchesHomeTsx() {
    val cases = fx.getJSONArray("rowTargets")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val got = HomeMath.rowTarget(c.getDouble("y"), c.getDouble("colH"), c.getDouble("height"), c.getDouble("pageY"))
      assertEquals("y ${c.getDouble("y")} colH ${c.getDouble("colH")} h ${c.getDouble("height")}", c.getDouble("target"), got, 0.0)
      assertTrue(got <= 0.0)
    }
    // 10d-spec §5: the heading rests 27 dp from the top; clamped to the column's end; never below 0
    assertEquals(-329.0, HomeMath.rowTarget(356.0, 1371.0, 540.0, 27.0), 0.0)
    assertEquals(-831.0, HomeMath.rowTarget(1097.0, 1371.0, 540.0, 27.0), 0.0)
    assertEquals(0.0, HomeMath.rowTarget(356.0, 500.0, 540.0, 27.0), 0.0)
  }

  /** What a focus landing selects out of the `targets` prop: the hero → 0, a measured row → its target, anything else → no slide. */
  @Test
  fun targetSelection() {
    val cols = fx.getJSONArray("columns")
    for (i in 0 until cols.length()) {
      val c = cols.getJSONObject(i)
      val targets = c.getJSONArray("targets").doubles()
      val picks = c.getJSONArray("picks")
      for (k in 0 until picks.length()) {
        val p = picks.getJSONArray(k)
        val got = HomeMath.targetFor(targets, p.getInt(0))
        val at = "${c.getString("name")} marker ${p.getInt(0)}"
        if (p.isNull(1)) assertTrue("$at: no slide", got.isNaN()) else assertEquals(at, p.getDouble(1), got, 0.0)
      }
    }
    assertTrue(HomeMath.targetFor(doubleArrayOf(Double.NaN), 0).isNaN())
    assertTrue(HomeMath.targetFor(doubleArrayOf(), 0).isNaN())
    assertEquals(0.0, HomeMath.targetFor(doubleArrayOf(), HomeMath.TOP), 0.0)
  }

  @Test
  fun artFadeMatchesTheInterpolationNode() {
    val fades = fx.getJSONArray("artFade")
    for (i in 0 until fades.length()) {
      val f = fades.getJSONObject(i)
      val out = f.getDouble("fadeOutAt")
      val inn = f.getDouble("fadeInAt")
      val samples = f.getJSONArray("samples")
      for (k in 0 until samples.length()) {
        val s = samples.getJSONArray(k)
        assertEquals("heroH ${f.getInt("heroH")} offset ${s.getDouble(0)}", s.getDouble(1), HomeMath.artFade(s.getDouble(0), out, inn), 0.0)
      }
      // clamped at both ends, whole across the top band
      assertEquals(1.0, HomeMath.artFade(0.0, out, inn), 0.0)
      assertEquals(1.0, HomeMath.artFade(inn, out, inn), 0.0)
      assertEquals(0.0, HomeMath.artFade(out, out, inn), 0.0)
      assertEquals(0.0, HomeMath.artFade(out - 400, out, inn), 0.0)
      assertEquals(1.0, HomeMath.artFade(25.0, out, inn), 0.0)
    }
    // 10d-spec §2.4 @540: fully visible until 107 dp, gone at 320 dp
    val f540 = fades.getJSONObject(0)
    assertEquals(-320.0, f540.getDouble("fadeOutAt"), 0.0)
    assertEquals(-107.0, f540.getDouble("fadeInAt"), 0.0)
  }

  @Test
  fun atTopFramesAndWhatRidesThem() {
    val a = fx.getJSONObject("atTop")
    val frames = a.getJSONArray("frames").doubles()
    assertEquals(frames.size, HomeMath.AT_TOP_FRAMES.size)
    for (i in frames.indices) assertEquals("frame $i", frames[i], HomeMath.AT_TOP_FRAMES[i], 1e-12)
    val samples = a.getJSONArray("samples")
    for (i in 0 until samples.length()) {
      val s = samples.getJSONObject(i)
      val v = s.getDouble("atTop")
      assertEquals("dim @$v", s.getDouble("dim"), HomeMath.dim(v, 0.42, 0.45), 0.0)
      assertEquals("scrolled @$v", s.getDouble("scrolledAlpha"), HomeMath.scrolledAlpha(v), 0.0)
    }
    assertEquals(0.45, HomeMath.dim(1.0, 0.42, 0.45), 0.0)
    assertEquals(0.42, HomeMath.dim(0.0, 0.42, 0.45), 0.0)
  }

  @Test
  fun alpha8TruncatesLikeHwui() {
    val cases = fx.getJSONArray("alpha8")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals("alpha ${c.getDouble("alpha")} base ${c.getInt("base")}", c.getInt("value"), Interpolation.alpha8(c.getDouble("alpha"), c.getInt("base")))
    }
    // the dim at rest and scrolled: 0.45 → 114, 0.42 → 107 of 255
    assertEquals(114, Interpolation.alpha8(0.45))
    assertEquals(107, Interpolation.alpha8(0.42))
  }

  /**
   * AuroraSlideColumnView's and AuroraHeroArtView's drivers, replayed: a focus landing in a
   * marked child replaces the spring when the marker has a target (from the value the last
   * frame drew) and restarts the atTop timing when top/shelves changed (from its value); the
   * art's alpha is the column's offset through the fade. Value for value against RN's native
   * drivers fed Home.tsx's targets.
   */
  @Test
  fun journeysMatchTheJsHome() {
    val runs = fx.getJSONArray("journeys")
    val columns = fx.getJSONArray("columns")
    for (i in 0 until runs.length()) {
      val r = runs.getJSONObject(i)
      val name = r.getString("name")
      var targets = DoubleArray(0)
      for (k in 0 until columns.length()) {
        if (columns.getJSONObject(k).getString("name") == r.getString("column")) targets = columns.getJSONObject(k).getJSONArray("targets").doubles()
      }
      val fadeOutAt = r.getDouble("fadeOutAt")
      val fadeInAt = r.getDouble("fadeInAt")
      val times = r.getJSONArray("frameTimesNanos").longs()
      val want = r.getJSONArray("frames")
      val focus = r.getJSONArray("focus")
      val landings = HashMap<Int, Int>()
      for (k in 0 until focus.length()) landings[focus.getJSONObject(k).getInt("frame")] = focus.getJSONObject(k).getInt("marker")

      var value = 0.0
      var spring: AuroraSpring? = null
      var atTop = true
      var atTopValue = 1.0
      var timing: AuroraTiming? = null
      for ((frame, t) in times.withIndex()) {
        landings[frame]?.let { marker ->
          if (marker != HomeMath.NONE) {
            val nextTop = marker == HomeMath.TOP
            if (nextTop != atTop) {
              atTop = nextTop
              timing = AuroraTiming(HomeMath.AT_TOP_FRAMES, if (nextTop) 1.0 else 0.0)
            }
            val to = HomeMath.targetFor(targets, marker)
            if (!to.isNaN()) spring = AuroraSpring(RowMath.SLIDE_STIFFNESS, RowMath.SLIDE_DAMPING, 1.0, to)
          }
        }
        val w = want.getJSONArray(frame)
        val at = "$name[$frame]"
        val s = spring
        if (s == null) {
          assertTrue("$at: the spring does not step", w.isNull(0))
        } else {
          value = s.step(t, value)
          assertEquals("$at ty", w.getDouble(0), value, 1e-9 * 1000)
          assertEquals("$at art", w.getDouble(1), HomeMath.artFade(value, fadeOutAt, fadeInAt), 1e-9)
          if (s.finished) spring = null
        }
        val d = timing
        if (d == null) {
          assertTrue("$at: the timing does not step", w.isNull(2))
        } else {
          atTopValue = d.step(t, atTopValue)
          assertEquals("$at atTop", w.getDouble(2), atTopValue, 1e-12)
          if (d.finished) timing = null
        }
      }
      val rest = r.getJSONObject("rest")
      assertEquals("$name rests (ty)", rest.getDouble("ty"), value, 1e-3)
      assertEquals("$name rests (atTop)", rest.getDouble("atTop"), atTopValue, 0.0)
    }
  }
}
