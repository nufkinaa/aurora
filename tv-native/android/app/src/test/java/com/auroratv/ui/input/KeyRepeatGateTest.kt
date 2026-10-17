package com.auroratv.ui.input

import com.auroratv.ui.input.KeyRepeatGate.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `keyrate` policy, event by event (KeyRepeatGate.kt). */
class KeyRepeatGateTest {
  private val RIGHT = 22
  private val LEFT = 21

  @Test fun aPressAndItsReleaseAlwaysPass() {
    val g = KeyRepeatGate()
    assertEquals(Verdict.PASS, g.onKey(RIGHT, true, 0, 1000))
    assertFalse(g.wantsFrames)
    assertEquals(Verdict.PASS, g.onKey(RIGHT, false, 0, 1080))
    assertEquals(0, g.heldCode)
    // a frame with nothing held moves nothing
    assertFalse(g.onFrame(1100, 1100))
  }

  @Test fun repeatsAreConsumedAndMovesComeFromFrames() {
    val g = KeyRepeatGate()
    g.onKey(RIGHT, true, 0, 0)
    assertEquals(Verdict.CONSUME, g.onKey(RIGHT, true, 1, 400))
    assertTrue(g.wantsFrames)
    // the first frame after the first repeat moves (the press was 400 ms ago)
    assertTrue(g.onFrame(408, 408))
    assertEquals(1, g.syntheticRepeatCount())
    // the next frames do not: no new repeat yet, then not 60 ms yet
    assertFalse(g.onFrame(425, 425))
    assertEquals(Verdict.CONSUME, g.onKey(RIGHT, true, 2, 450))
    assertFalse(g.onFrame(442, 451))
    assertFalse(g.onFrame(458, 458))
    assertTrue(g.onFrame(475, 475)) // 67 ms after the last move
    assertEquals(2, g.syntheticRepeatCount())
  }

  @Test fun theReleaseEndsItAtOnce() {
    val g = KeyRepeatGate()
    g.onKey(RIGHT, true, 0, 0)
    g.onKey(RIGHT, true, 1, 400)
    g.onKey(RIGHT, false, 0, 420)
    assertFalse(g.wantsFrames)
    assertFalse(g.onFrame(475, 475))
  }

  @Test fun noRepeatForAWhileMeansNoMove() {
    val g = KeyRepeatGate()
    g.onKey(RIGHT, true, 0, 0)
    g.onKey(RIGHT, true, 1, 400)
    assertFalse(g.onFrame(600, 600)) // 200 ms since the last hardware repeat: the key-up is in flight
  }

  @Test fun anotherKeyTakesOver() {
    val g = KeyRepeatGate()
    g.onKey(RIGHT, true, 0, 0)
    g.onKey(RIGHT, true, 1, 400)
    assertEquals(Verdict.PASS, g.onKey(LEFT, true, 0, 430))
    assertFalse(g.wantsFrames)
    // a stray repeat of the old key is not ours any more
    assertEquals(Verdict.PASS, g.onKey(RIGHT, true, 2, 450))
    // the old key's release does not end the new hold
    g.onKey(RIGHT, false, 0, 460)
    assertEquals(LEFT, g.heldCode)
  }

  @Test fun theIntervalIsATunable() {
    val g = KeyRepeatGate(intervalMs = 120)
    g.onKey(RIGHT, true, 0, 0)
    g.onKey(RIGHT, true, 1, 400)
    assertTrue(g.onFrame(400, 400))
    g.onKey(RIGHT, true, 2, 450)
    assertFalse(g.onFrame(467, 467))
    g.onKey(RIGHT, true, 3, 500)
    assertTrue(g.onFrame(517, 517)) // 117 ≥ 120 − 6
  }
}
