package com.auroratv.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioFxCurveTest {
  @Test
  fun offIsNeutral() {
    assertEquals(AudioFxCurve.NEUTRAL, AudioFxCurve.targets(night = false, dialogue = false))
  }

  @Test
  fun nightLiftsQuietAndCutsLoud() {
    val v = AudioFxCurve.targets(night = true, dialogue = false)
    // quiet speech (well under the threshold) comes up by the make-up
    assertEquals(-39f, AudioFxCurve.nightOut(-45f, v), 0.01f)
    // a loud burst comes well down
    val loud = AudioFxCurve.nightOut(-3f, v)
    assertTrue("loud burst at $loud", loud < -3f - 10f)
    // the loudness range of a -45..-3 film shrinks from 42 dB to under 25
    assertTrue(loud - AudioFxCurve.nightOut(-45f, v) < 25f)
    // no limiter, no EQ with night mode alone besides the safety limiter
    assertEquals(0f, v.eqVoice, 0f)
    assertEquals(AudioFxCurve.LIM_THRESHOLD, v.limThreshold, 0f)
  }

  @Test
  fun dialogueBoostIsTheVoiceBand() {
    val v = AudioFxCurve.targets(night = false, dialogue = true)
    assertEquals(6f, v.eqVoice, 0f)
    assertEquals(-4f, v.eqLow, 0f)
    assertEquals(3f, v.centreGain, 0f)
    assertEquals(1f, v.mbcRatio, 0f) // no compression with dialogue boost alone
    assertEquals(listOf(200f, 1000f, 4000f, 20000f), AudioFxCurve.EQ_CUTOFFS.toList())
  }

  @Test
  fun aSwitchGlidesInSmallStepsAndEndsExactly() {
    val from = AudioFxCurve.NEUTRAL
    val to = AudioFxCurve.targets(night = true, dialogue = true)
    val steps = AudioFxCurve.ramp(from, to)
    assertEquals(AudioFxCurve.RAMP_STEPS, steps.size)
    assertEquals(to, steps.last())
    // no step jumps the voice EQ by more than a dB, the make-up by more than one
    var prev = from
    for (s in steps) {
      assertTrue(Math.abs(s.eqVoice - prev.eqVoice) <= 1.0f)
      assertTrue(Math.abs(s.mbcPostGain - prev.mbcPostGain) <= 1.0f)
      prev = s
    }
  }

  @Test
  fun passthroughIsNeverProcessed() {
    assertTrue(AudioFxCurve.processable(isLinearPcm = true, offload = false))
    assertFalse(AudioFxCurve.processable(isLinearPcm = false, offload = false))
    assertFalse(AudioFxCurve.processable(isLinearPcm = true, offload = true))
  }
}
