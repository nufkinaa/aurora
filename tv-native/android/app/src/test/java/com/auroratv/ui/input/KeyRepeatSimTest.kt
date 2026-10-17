package com.auroratv.ui.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.PriorityQueue
import java.util.Random
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * `keyrate` against today's behaviour on SYNTHETIC event streams: a press-to-move timing
 * model of the UI thread (docs/qa/native-deep/DEVICE-PLAN.md §keyrate quotes the table this
 * prints).
 *
 * The model. The remote: a press at t0, Android's repeats after the repeat timeout (400 ms)
 * every `repeatMs` (50 ms, optionally jittered as a Bluetooth remote does), the key-up at
 * t0 + hold. The display: a vsync every 16.683 ms (59.94 Hz). The UI thread: one queue; while
 * it is busy nothing else runs; when it frees up, the input that arrived meanwhile is taken
 * first (Looper services the input fd before the next message), then the pending frame. A
 * focus move costs `moveMs` of UI time (focus change, animation start, the mounts the move
 * brings), a frame `frameMs`; an optional stall blocks the thread once.
 *
 *   baseline  every key-down that is not a dropped double press moves focus (today);
 *   keyrate   presses move at once; repeats are consumed; the gate moves on frames.
 *
 * What is measured: moves; moves AFTER the key-up's own time (the shelf running on after the
 * viewer let go — "overshoot"); the most moves inside one frame interval; the delay from a
 * press to its move; the spread of the intervals between held moves.
 */
class KeyRepeatSimTest {

  data class Remote(
    val presses: List<Pair<Double, Double>>, // (down at, held for) ms
    val repeatMs: Double = 50.0,
    val timeoutMs: Double = 400.0,
    val jitterMs: Double = 0.0,
    val seed: Long = 7,
  )

  data class Thread(
    val moveMs: Double,
    val frameMs: Double,
    val stallAt: Double = -1.0,
    val stallMs: Double = 0.0,
  )

  data class Result(
    val moves: List<Double>, // when each move ran (ms)
    val overshoot: Int,
    val maxPerFrame: Int,
    val pressDelays: List<Double>,
    val heldIntervals: List<Double>,
  ) {
    val meanInterval get() = heldIntervals.average()
    val sdInterval: Double
      get() {
        if (heldIntervals.size < 2) return 0.0
        val m = meanInterval
        return sqrt(heldIntervals.sumOf { (it - m) * (it - m) } / heldIntervals.size)
      }
    fun row(name: String) =
      String.format(
        java.util.Locale.US, "%-26s moves %3d  after-release %2d  max/frame %d  press-to-move max %5.1f ms  held interval %5.1f ± %4.1f ms",
        name, moves.size, overshoot, maxPerFrame, pressDelays.maxOrNull() ?: 0.0,
        if (heldIntervals.isEmpty()) 0.0 else meanInterval, sdInterval,
      )
  }

  private sealed class Ev(val at: Double) {
    class Key(at: Double, val down: Boolean, val repeat: Int, val pressIndex: Int) : Ev(at)
  }

  private val VSYNC = 1000.0 / 59.94
  private val CODE = 22

  private fun keys(r: Remote): List<Ev.Key> {
    val rnd = Random(r.seed)
    val out = ArrayList<Ev.Key>()
    r.presses.forEachIndexed { i, (t0, hold) ->
      out.add(Ev.Key(t0, true, 0, i))
      var t = t0 + r.timeoutMs
      var n = 1
      while (t < t0 + hold) {
        out.add(Ev.Key(t, true, n++, i))
        t += r.repeatMs + if (r.jitterMs > 0) (rnd.nextDouble() * 2 - 1) * r.jitterMs else 0.0
      }
      out.add(Ev.Key(t0 + hold, false, 0, i))
    }
    out.sortBy { it.at }
    return out
  }

  private fun run(r: Remote, th: Thread, gated: Boolean): Result {
    val input = ArrayDeque(keys(r))
    val ups = r.presses.map { it.first + it.second }
    val gate = KeyRepeatGate()
    val moves = ArrayList<Double>()
    val movePress = ArrayList<Int>()
    val pressDelays = ArrayList<Double>()
    val frameStarts = ArrayList<Double>()
    var now = 0.0
    var nextVsync = 0.0
    var stalled = false
    val end = (r.presses.maxOf { it.first + it.second }) + 1500.0
    var lastDown = -1e9
    var swallowUp = false

    fun move(pressIndex: Int) {
      moves.add(now)
      movePress.add(pressIndex)
      now += th.moveMs
    }

    while (now < end) {
      if (!stalled && th.stallAt >= 0 && now >= th.stallAt) {
        stalled = true
        now += th.stallMs
      }
      // 1. every input event that has arrived by now, in order
      var did = false
      while (input.isNotEmpty() && input.first().at <= now) {
        val e = input.removeFirst()
        did = true
        if (e.down && e.repeat == 0) {
          // MainActivity's double-press filter (110 ms) runs in both models
          if (e.at - lastDown < 110.0) { swallowUp = true; continue }
          lastDown = e.at
          swallowUp = false
        } else if (!e.down && swallowUp) {
          swallowUp = false
          continue
        }
        if (gated) {
          val v = gate.onKey(CODE, e.down, e.repeat, e.at.toLong())
          if (v == KeyRepeatGate.Verdict.PASS && e.down) {
            pressDelays.add(now - e.at)
            move(e.pressIndex)
          } else {
            now += 0.05 // a consumed repeat: a field write
          }
        } else if (e.down) {
          if (e.repeat == 0) pressDelays.add(now - e.at)
          move(e.pressIndex)
        }
      }
      // 2. the frame, if its vsync has come
      if (now >= nextVsync) {
        val frameTime = nextVsync
        frameStarts.add(now)
        if (gated && gate.wantsFrames && gate.onFrame(frameTime.toLong(), now.toLong())) {
          move(r.presses.indexOfLast { it.first <= now })
        }
        now += th.frameMs
        // the next vsync after the frame is done (a long frame skips vsyncs)
        while (nextVsync <= now) nextVsync += VSYNC
        did = true
      }
      if (!did) {
        // idle: wake at the next input or vsync
        val nextIn = input.firstOrNull()?.at ?: Double.MAX_VALUE
        now = max(now, minOf(nextIn, nextVsync))
      }
    }

    var overshoot = 0
    moves.forEachIndexed { i, t -> if (t > ups[movePress[i]] + 0.001) overshoot++ }
    var maxPerFrame = 0
    for (i in 0 until frameStarts.size) {
      val a = frameStarts[i]
      val b = if (i + 1 < frameStarts.size) frameStarts[i + 1] else Double.MAX_VALUE
      maxPerFrame = max(maxPerFrame, moves.count { it >= a && it < b })
    }
    // intervals between moves of one hold, from the 2nd move on (the first is the press)
    val held = ArrayList<Double>()
    for (i in 2 until moves.size) if (movePress[i] == movePress[i - 1] && movePress[i - 1] == movePress[i - 2]) held.add(moves[i] - moves[i - 1])
    return Result(moves, overshoot, maxPerFrame, pressDelays, held)
  }

  private fun both(name: String, r: Remote, th: Thread): Pair<Result, Result> {
    val a = run(r, th, gated = false)
    val b = run(r, th, gated = true)
    println(a.row("$name / today"))
    println(b.row("$name / keyrate"))
    return a to b
  }

  private val LIGHT = Thread(moveMs = 4.0, frameMs = 8.0)
  private val HEAVY = Thread(moveMs = 60.0, frameMs = 14.0) // a weak box: each move mounts and lays out

  @Test fun tapsAreNeverLostOrDelayed() {
    val taps = Remote((0 until 10).map { 300.0 * it + 5 to 80.0 })
    val (a, b) = both("10 taps, 300 ms apart", taps, LIGHT)
    assertEquals(10, a.moves.size)
    assertEquals(10, b.moves.size)
    assertEquals(0, b.overshoot)
    // a tap moves when the thread takes it, as today
    assertEquals(a.pressDelays, b.pressDelays)
    assertTrue(b.pressDelays.all { it < VSYNC })
    // a quick double tap (150 ms apart) is two moves; a bounce (60 ms) is one, in both
    val dbl = Remote(listOf(5.0 to 70.0, 155.0 to 70.0))
    assertEquals(2, run(dbl, LIGHT, true).moves.size)
    val bounce = Remote(listOf(5.0 to 30.0, 65.0 to 30.0))
    assertEquals(run(bounce, LIGHT, false).moves.size, run(bounce, LIGHT, true).moves.size)
  }

  @Test fun aHeldKeyOnALightBoxMovesSteadilyOncePerFrameAtMost() {
    val hold = Remote(listOf(5.0 to 2000.0))
    val (a, b) = both("hold 2 s, light box", hold, LIGHT)
    assertEquals(0, b.overshoot)
    assertEquals(1, b.maxPerFrame)
    // 15 a second after the repeat timeout: 1 + ~24
    assertTrue("moves ${b.moves.size}", b.moves.size in 23..27)
    assertTrue(abs(b.meanInterval - 4 * VSYNC) < 1.0)
    assertTrue(b.sdInterval < 1.0)
    // today: every hardware repeat, 20 a second
    assertTrue(a.moves.size > b.moves.size)
  }

  @Test fun aJitteryRemoteStillGivesASteadyRate() {
    val hold = Remote(listOf(5.0 to 2000.0), jitterMs = 18.0, seed = 3)
    val (a, b) = both("hold 2 s, jittery remote", hold, LIGHT)
    assertEquals(0, b.overshoot)
    assertEquals(1, b.maxPerFrame)
    assertTrue("sd ${b.sdInterval} vs ${a.sdInterval}", b.sdInterval < a.sdInterval)
    // every interval is a whole number of frames, at least 4 at 59.94 Hz
    assertTrue(b.heldIntervals.all { it > 3.5 * VSYNC })
  }

  @Test fun aSlowRemoteIsNeverOutrun() {
    val hold = Remote(listOf(5.0 to 2000.0), repeatMs = 100.0)
    val (a, b) = both("hold 2 s, 100 ms repeats", hold, LIGHT)
    assertTrue(b.moves.size <= a.moves.size)
    // one move per hardware repeat at most: a frame or so either side of 100 ms, 100 on average
    assertTrue(b.heldIntervals.all { it > 5 * VSYNC - 1 })
    assertTrue(b.meanInterval > 95.0)
  }

  @Test fun aWeakBoxNoLongerRunsOnAfterTheRelease() {
    val hold = Remote(listOf(5.0 to 1500.0))
    val (a, b) = both("hold 1.5 s, weak box", hold, HEAVY)
    // today: the backlog of repeats is still being worked off after the key-up
    assertTrue("today overshoot ${a.overshoot}", a.overshoot > 0)
    assertTrue(a.maxPerFrame > 1)
    assertEquals(0, b.overshoot)
    assertEquals(1, b.maxPerFrame)
  }

  @Test fun aStallThenReleaseDoesNotReplayTheQueue() {
    val hold = Remote(listOf(5.0 to 1000.0))
    val stall = Thread(moveMs = 4.0, frameMs = 8.0, stallAt = 700.0, stallMs = 320.0)
    val (a, b) = both("stall 320 ms, then release", hold, stall)
    assertTrue("today overshoot ${a.overshoot}", a.overshoot >= 5)
    assertEquals(0, b.overshoot)
    assertEquals(1, b.maxPerFrame)
  }
}
