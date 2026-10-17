package com.auroratv.ui.anim

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The animation-driver ports against values computed from React Native's own JS
 * (tools/gen-anim-fixtures.js → src/test/resources/anim-fixtures.json). Regenerate the
 * fixtures with `node tools/gen-anim-fixtures.js` after a react-native bump.
 *
 * Tolerances: the bezier and the pre-sampled frames are pure IEEE arithmetic in the same
 * order, so they must agree to the last bit (1e-15); the spring uses exp/sin/cos, where
 * V8's libm and the JVM's may differ by an ulp, so 1e-9 of the animated unit — the
 * device gate (02-verification.md §4.3) is 1e-3.
 */
class AnimMathTest {
  private val fx: JSONObject by lazy {
    val text = javaClass.classLoader!!.getResourceAsStream("anim-fixtures.json")!!.bufferedReader().readText()
    JSONObject(text)
  }

  private fun JSONArray.doubles(): DoubleArray = DoubleArray(length()) { getDouble(it) }
  private fun JSONArray.longs(): LongArray = LongArray(length()) { getString(it).toLong() }

  @Test
  fun bezierMatchesReactNative() {
    val cases = fx.getJSONArray("bezier")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val b = Bezier(c.getDouble("x1"), c.getDouble("y1"), c.getDouble("x2"), c.getDouble("y2"))
      val samples = c.getJSONArray("samples")
      for (j in 0 until samples.length()) {
        val s = samples.getJSONArray(j)
        assertEquals("bezier #$i x=${s.getDouble(0)}", s.getDouble(1), b.ease(s.getDouble(0)), 1e-15)
      }
    }
  }

  @Test
  fun timingFramesMatchReactNative() {
    val frames = fx.getJSONObject("timingFrames")
    val ease = Bezier(0.2, 0.7, 0.2, 1.0)
    val expectations = mapOf(
      "bezier160" to AuroraTiming.sample(160.0) { ease.ease(it) },
      "bezier280" to AuroraTiming.sample(280.0) { ease.ease(it) },
      "sin8000" to AuroraTiming.sample(8000.0) { (1 - Math.cos(Math.PI * it)) / 2 },
      "linear800" to AuroraTiming.sample(800.0) { it },
    )
    for ((name, got) in expectations) {
      val want = frames.getJSONArray(name).doubles()
      assertEquals("$name length", want.size, got.size)
      for (i in want.indices) assertEquals("$name[$i]", want[i], got[i], if (name == "sin8000") 1e-12 else 1e-15)
    }
    // 160 ms → 10 samples + 1 (01-architecture.md §6.1)
    assertEquals(11, expectations["bezier160"]!!.size)
    assertEquals(18, expectations["bezier280"]!!.size)
  }

  @Test
  fun springConfigMatchesReactNative() {
    val cfg = fx.getJSONObject("springConfig")
    val tf = AuroraSpring.fromOrigamiTensionAndFriction(180.0, 14.0)
    assertEquals(cfg.getJSONObject("tension180friction14").getDouble("stiffness"), tf.first, 1e-12)
    assertEquals(cfg.getJSONObject("tension180friction14").getDouble("damping"), tf.second, 1e-12)
    val tf2 = AuroraSpring.fromOrigamiTensionAndFriction(40.0, 7.0)
    assertEquals(cfg.getJSONObject("tension40friction7").getDouble("stiffness"), tf2.first, 1e-12)
    assertEquals(cfg.getJSONObject("tension40friction7").getDouble("damping"), tf2.second, 1e-12)
    val bs = AuroraSpring.fromBouncinessAndSpeed(0.0, 12.0)
    assertEquals(cfg.getJSONObject("bounciness0speed12").getDouble("stiffness"), bs.first, 1e-12)
    assertEquals(cfg.getJSONObject("bounciness0speed12").getDouble("damping"), bs.second, 1e-12)
    val bs2 = AuroraSpring.fromBouncinessAndSpeed(8.0, 12.0)
    assertEquals(cfg.getJSONObject("bounciness8speed12").getDouble("stiffness"), bs2.first, 1e-12)
    assertEquals(cfg.getJSONObject("bounciness8speed12").getDouble("damping"), bs2.second, 1e-12)
  }

  @Test
  fun timingDriverMatchesFrameBasedAnimationDriver() {
    val runs = fx.getJSONArray("timingRuns")
    val frames = fx.getJSONObject("timingFrames")
    for (i in 0 until runs.length()) {
      val r = runs.getJSONObject(i)
      val name = r.getString("name")
      val f = frames.getJSONArray(r.getString("frames")).doubles()
      val times = r.getJSONArray("frameTimesNanos").longs()
      val want = r.getJSONArray("values").doubles()
      val retargetAfter = r.optInt("retargetAfter", -1)
      var value = r.getDouble("from")
      var d = AuroraTiming(f, r.getDouble("to"))
      val got = ArrayList<Double>()
      for ((k, t) in times.withIndex()) {
        if (k == retargetAfter) d = AuroraTiming(f, r.getDouble("retargetTo"))
        value = d.step(t, value)
        got.add(value)
        if (d.finished) break // (a retarget happens before the first driver finishes)
      }
      assertEquals("$name step count", want.size, got.size)
      for (k in want.indices) assertEquals("$name[$k]", want[k], got[k], 1e-15)
    }
  }

  @Test
  fun springDriverMatchesSpringAnimation() {
    val runs = fx.getJSONArray("springRuns")
    for (i in 0 until runs.length()) {
      val r = runs.getJSONObject(i)
      val name = r.getString("name")
      val times = r.getJSONArray("frameTimesNanos").longs()
      val want = r.getJSONArray("values").doubles()
      val retargetAfter = r.optInt("retargetAfter", -1)
      val stiffness = r.getDouble("stiffness")
      val damping = r.getDouble("damping")
      val mass = r.optDouble("mass", 1.0)
      var value = r.getDouble("from")
      var d = AuroraSpring(stiffness, damping, mass, r.getDouble("to"))
      val got = ArrayList<Double>()
      for ((k, t) in times.withIndex()) {
        if (k == retargetAfter) d = AuroraSpring(stiffness, damping, mass, r.getDouble("retargetTo"))
        value = d.step(t, value)
        got.add(value)
        if (d.finished) break // (a retarget happens before the first driver settles)
      }
      assertEquals("$name step count", want.size, got.size)
      val range = Math.abs(r.getDouble("to") - r.getDouble("from")).coerceAtLeast(1.0)
      for (k in want.indices) assertEquals("$name[$k]", want[k], got[k], 1e-9 * range)
    }
  }

  @Test
  fun focusSpringSettlesInsideTheSpecsEnvelope() {
    // 10a §1.2: tension 180 / friction 14 → ζ ≈ 0.792, first overshoot ≈ 1.7 %, rest ≈ 320 ms
    val d = AuroraSpring(AuroraSpring.stiffnessFromOrigamiValue(180.0), AuroraSpring.dampingFromOrigamiValue(14.0), 1.0, 1.0)
    var v = 0.0
    var peak = 0.0
    var frames = 0
    var t = 0L
    while (!d.finished && frames < 200) {
      v = d.step(t, v)
      peak = Math.max(peak, v)
      t += 16_666_667L
      frames++
    }
    assertTrue("overshoot $peak", peak > 1.01 && peak < 1.03)
    // 24 frames on a 60 Hz clock, the first being the idle start frame: ~383 ms to the
    // 1e-3 rest thresholds (the spec's "≈ 320 ms" is the envelope alone; the velocity
    // threshold is the slower one). Same number the fixture (RN's maths) gives.
    assertTrue("rest after $frames frames", frames in 22..26)
    assertEquals(1.0, v, 0.0011)
  }
}
