package com.auroratv.ui.rail

import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Interpolation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The native rail's drawing arithmetic against the JS reference rail
 * (tools/gen-rail-fixtures.js → src/test/resources/rail-fixtures.json: every constant read
 * out of NavRail.tsx / theme.ts / qa.ts, colours through RN's normalize-colors, easings
 * through RN's Easing.js). Regenerate with `node tools/gen-rail-fixtures.js` after touching
 * NavRail.tsx's strip, panel or hues.
 */
class RailMathTest {
  private val fx: JSONObject by lazy {
    val text = javaClass.classLoader!!.getResourceAsStream("rail-fixtures.json")!!.bufferedReader().readText()
    JSONObject(text)
  }

  private fun JSONArray.doubles(): DoubleArray = DoubleArray(length()) { getDouble(it) }
  private fun JSONArray.ints(): IntArray = IntArray(length()) { getInt(it) }
  private fun JSONArray.floats(): FloatArray = FloatArray(length()) { getDouble(it).toFloat() }
  private fun JSONArray.longs(): LongArray = LongArray(length()) { getString(it).toLong() }

  @Test
  fun constantsAreNavRailTsxs() {
    val c = fx.getJSONObject("constants")
    assertEquals(c.getDouble("rail"), RailMath.RAIL, 0.0)
    assertEquals(c.getDouble("railOpen"), RailMath.RAIL_OPEN, 0.0)
    assertEquals(c.getDouble("feather"), RailMath.FEATHER, 0.0)
    assertEquals(c.getDouble("panel"), RailMath.PANEL, 0.0)
    assertEquals(c.getDouble("edge"), RailMath.EDGE, 0.0)
    assertEquals(c.getDouble("hueAMs"), RailMath.HUE_A_MS, 0.0)
    assertEquals(c.getDouble("hueBMs"), RailMath.HUE_B_MS, 0.0)
    assertEquals(c.getDouble("frozenPhase"), RailMath.FROZEN_PHASE, 0.0)
    assertEquals(c.getInt("bodyColor"), RailMath.BODY_COLOR)
    assertEquals(280, c.getInt("med"))
    // 10b-spec §2-3: strip 72, panel 288 = 240 + 48
    assertEquals(288.0, RailMath.PANEL, 0.0)
  }

  @Test
  fun coloursAndStopsAreNavRailTsxs() {
    val g = fx.getJSONObject("gradients")
    val body = g.getJSONObject("body")
    assertEquals(body.getDouble("angle"), RailMath.BODY_ANGLE, 0.0)
    assertArrayEquals(body.getJSONArray("colors").ints(), RailMath.BODY_COLORS)
    assertArrayEquals(body.getJSONArray("stops").floats(), RailMath.BODY_STOPS, 0f)
    val edge = g.getJSONObject("edge")
    assertEquals(edge.getDouble("angle"), RailMath.EDGE_ANGLE, 0.0)
    assertArrayEquals(edge.getJSONArray("colors").ints(), RailMath.EDGE_COLORS)
    assertArrayEquals(edge.getJSONArray("stops").floats(), RailMath.EDGE_STOPS, 0f)
    val scrim = g.getJSONObject("scrim")
    assertArrayEquals(scrim.getJSONArray("colors").ints(), RailMath.SCRIM_COLORS)
    assertArrayEquals(scrim.getJSONArray("stops").floats(), RailMath.SCRIM_STOPS, 0f)
    val feather = g.getJSONObject("feather")
    assertArrayEquals(feather.getJSONArray("colors").ints(), RailMath.FEATHER_COLORS)
    assertArrayEquals(feather.getJSONArray("stops").floats(), RailMath.FEATHER_STOPS, 0f)
    // 10b-spec §2: the scrim starts at alpha 0.9 → 230 of 255; the feather's knee 0.55 → 140
    assertEquals(230, RailMath.SCRIM_COLORS[0] ushr 24)
    assertEquals(140, RailMath.FEATHER_COLORS[1] ushr 24)

    val h = fx.getJSONObject("hues")
    val v = h.getJSONObject("violet")
    assertEquals(v.getDouble("left"), RailMath.VIOLET_LEFT, 0.0)
    assertEquals(v.getDouble("top"), RailMath.VIOLET_TOP, 0.0)
    assertEquals(v.getDouble("size"), RailMath.VIOLET_SIZE, 0.0)
    assertEquals(v.getInt("tint"), RailMath.VIOLET_TINT)
    val gr = h.getJSONObject("green")
    assertEquals(gr.getDouble("left"), RailMath.GREEN_LEFT, 0.0)
    assertEquals(gr.getDouble("bottom"), RailMath.GREEN_BOTTOM, 0.0)
    assertEquals(gr.getDouble("size"), RailMath.GREEN_SIZE, 0.0)
    assertEquals(gr.getInt("tint"), RailMath.GREEN_TINT)
  }

  /** AuroraRailPanelView's slide driver, replayed against RN's native timing driver. */
  @Test
  fun slideMatchesTheJsRail() {
    val s = fx.getJSONObject("slide")
    val frames = s.getJSONArray("frames").doubles()
    assertEquals(frames.size, RailMath.SLIDE_FRAMES.size)
    for (i in frames.indices) assertEquals("frame $i", frames[i], RailMath.SLIDE_FRAMES[i], 1e-12)
    assertEquals(18, RailMath.SLIDE_FRAMES.size) // 280 ms: 17 samples + the end

    val runs = s.getJSONArray("runs")
    for (i in 0 until runs.length()) {
      val r = runs.getJSONObject(i)
      val name = r.getString("name")
      val times = r.getJSONArray("frameTimesNanos").longs()
      val steps = r.getJSONArray("steps")
      val timing = AuroraTiming(RailMath.SLIDE_FRAMES, r.getDouble("to"))
      var value = r.getDouble("from")
      for ((k, t) in times.withIndex()) {
        value = timing.step(t, value)
        val w = steps.getJSONArray(k)
        assertEquals("$name[$k] slide", w.getDouble(0), value, 1e-12)
        assertEquals("$name[$k] panel tx", w.getDouble(1), RailMath.panelTx(value), 1e-9)
        assertEquals("$name[$k] strip alpha", w.getDouble(2), RailMath.stripAlpha(value), 1e-12)
        assertEquals("$name[$k] body alpha", w.getInt(3), Interpolation.alpha8(value))
      }
      assertEquals("$name finished with its last step", true, timing.finished)
      assertEquals("$name ends on its target", r.getDouble("to"), value, 0.0)
    }
    assertEquals(-288.0, RailMath.panelTx(0.0), 0.0)
    assertEquals(0.0, RailMath.panelTx(1.0), 0.0)
    assertEquals(1.0, RailMath.stripAlpha(0.0), 0.0)
    assertEquals(0.0, RailMath.stripAlpha(1.0), 0.0)
  }

  @Test
  fun hueEasingAndFramesAreRNs() {
    val e = fx.getJSONArray("sinInOut")
    for (i in 0 until e.length()) {
      val p = e.getJSONArray(i)
      assertEquals("sinInOut(${p.getDouble(0)})", p.getDouble(1), RailMath.sinInOut(p.getDouble(0)), 1e-15)
    }
    val f = fx.getJSONObject("hueFrames")
    for ((key, frames) in listOf("a" to RailMath.HUE_A_FRAMES, "b" to RailMath.HUE_B_FRAMES)) {
      val o = f.getJSONObject(key)
      assertEquals("$key frame count", o.getInt("count"), frames.size)
      val samples = o.getJSONArray("samples")
      for (i in 0 until samples.length()) {
        val p = samples.getJSONArray(i)
        assertEquals("$key frame ${p.getInt(0)}", p.getDouble(1), frames[p.getInt(0)], 1e-15)
      }
    }
    // 8 s and 10.5 s each way at 60 samples a second, plus the end
    assertEquals(481, RailMath.HUE_A_FRAMES.size)
    assertEquals(631, RailMath.HUE_B_FRAMES.size)
  }

  @Test
  fun glowsMatchRailHues() {
    val cases = fx.getJSONArray("glows")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val a = c.getDouble("a")
      val b = c.getDouble("b")
      for ((key, got) in listOf("violet" to RailMath.violet(a, b), "green" to RailMath.green(a, b))) {
        val w = c.getJSONObject(key)
        val at = "$key @($a, $b)"
        assertEquals("$at alpha", w.getDouble("alpha"), got.alpha, 1e-15)
        assertEquals("$at tx", w.getDouble("tx"), got.tx, 1e-12)
        assertEquals("$at ty", w.getDouble("ty"), got.ty, 1e-12)
        assertEquals("$at scale", w.getDouble("scale"), got.scale, 1e-15)
      }
      val paints = c.getJSONArray("paints")
      for (k in 0 until paints.length()) {
        val p = paints.getJSONObject(k)
        val slide = p.getDouble("slide")
        assertEquals("violet paint @($a, $b) slide $slide", p.getInt("violet"), Interpolation.alpha8(slide, Interpolation.alpha8(RailMath.violet(a, b).alpha)))
        assertEquals("green paint @($a, $b) slide $slide", p.getInt("green"), Interpolation.alpha8(slide, Interpolation.alpha8(RailMath.green(a, b).alpha)))
      }
    }
    // 10b-spec §3.1 at the ends of the loops
    val rest = RailMath.violet(0.0, 0.0)
    assertEquals(0.26, rest.alpha, 0.0)
    assertEquals(-14.0, rest.tx, 0.0)
    assertEquals(-10.0, rest.ty, 0.0)
    assertEquals(1.0, rest.scale, 0.0)
    val far = RailMath.green(1.0, 1.0)
    assertEquals(0.36, far.alpha, 0.0)
    assertEquals(-18.0, far.tx, 0.0)
    assertEquals(-30.0, far.ty, 0.0)
    assertEquals(0.96, far.scale, 0.0)
  }

  @Test
  fun gradientLineIsReactNativesCssLine() {
    val cases = fx.getJSONArray("gradientLines")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val want = c.getJSONArray("line").doubles()
      val got = RailMath.gradientLine(c.getDouble("angle"), c.getDouble("width").toFloat(), c.getDouble("height").toFloat())
      // RN computes the line in floats; the fixture in doubles. 1/100 px on a 2160-px box.
      for (k in 0 until 4) assertEquals("${c.getDouble("angle")}deg ${c.getInt("width")}x${c.getInt("height")} [$k]", want[k], got[k].toDouble(), 0.01)
    }
    // 90deg: left to right, exactly
    assertArrayEquals(floatArrayOf(0f, 0f, 240f, 0f), RailMath.gradientLine(90.0, 240f, 1080f), 0f)
  }

  @Test
  fun pixelGridIsYogas() {
    val cases = fx.getJSONArray("px")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals("${c.getDouble("dp")} @${c.getDouble("density")}", c.getInt("px"), RailMath.px(c.getDouble("dp"), c.getDouble("density")))
    }
    assertEquals(480, RailMath.px(240.0, 2.0))
    assertEquals(-340, RailMath.px(-170.0, 2.0))
  }

  @Test
  fun svgStopFoldsTheOpacityIn() {
    assertEquals(0xE6080910.toInt(), RailMath.svgStop(0x080910, 0.9))
    assertEquals(0x00080910, RailMath.svgStop(0x080910, 0.0))
    assertEquals(0xFF0A0B14.toInt(), RailMath.svgStop(0x0A0B14, 1.0))
    assertEquals(0x8C0A0B14.toInt(), RailMath.svgStop(0x0A0B14, 0.55))
  }
}
