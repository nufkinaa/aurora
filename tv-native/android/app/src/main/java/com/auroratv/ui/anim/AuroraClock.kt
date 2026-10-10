package com.auroratv.ui.anim

import android.util.Log
import android.view.Choreographer
import com.auroratv.ui.qa.AuroraQa
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.ReactChoreographer

/** One step per frame; return true when finished (the clock drops the driver). */
interface AuroraDriver {
  fun step(frameTimeNanos: Long): Boolean
}

/**
 * The frame clock for the native components' animations: every active driver is stepped
 * once per vsync from ReactChoreographer's NATIVE_ANIMATED_MODULE phase — the same phase
 * React Native's own native-driver animations run in, so ordering relative to them is
 * unchanged (01-architecture.md §6, §10). UI thread only.
 *
 * `[anim] <frameTimeNanos> <id> <value>` lines (tag AuroraAnim) are written by the drivers
 * through [trace] while the QA receiver has tracing on; nothing is formatted otherwise.
 */
object AuroraClock {
  private const val TAG = "AuroraAnim"
  private val active = ArrayList<AuroraDriver>()
  private var posted = false
  // ---- LAB experiments `unstuff` / `unstuffq` (AuroraExp.kt; docs/qa/native-bench/FOLLOWUP.md) ----
  // Android 14 has no recovery from a stuffed buffer queue: once a finished buffer waits in
  // front of SurfaceFlinger, a 60 fps producer keeps it there until the motion ends, and each
  // frame is shown a vsync later than it could be. It comes in two depths, both read here
  // from the UI thread's own clock:
  //   LATE     this callback runs well after its vsync, frame after frame: the UI thread spent
  //            the vsync blocked in the previous frame's sync, behind a RenderThread that was
  //            waiting for a buffer. One whole frame is parked in the UI thread.
  //   BLOCKED  the callback is on time but the frame it starts keeps the UI thread for many ms:
  //            the same wait, shorter. One finished buffer is parked in the queue.
  // WAITING, NOT WORKING. Both are told apart from a UI thread that is simply busy (mounting a
  // shelf, laying out a grid — late and long too) by the thread's own CPU clock: a frame that
  // kept the thread for 10 ms and used 1 ms of CPU spent the rest asleep behind the RenderThread.
  // The cure is what Android 16 does: produce nothing for exactly ONE vsync, so SurfaceFlinger
  // gets ahead by one buffer. The drivers are stepped with the frame's time, so the motion
  // stays where the clock says; the vsync that is skipped shows the previous frame again.
  // `unstuff` cures LATE only; `unstuffq` cures both.
  private val UNSTUFF = com.auroratv.ui.AuroraExp.on("unstuff") || com.auroratv.ui.AuroraExp.on("unstuffq")
  private val UNSTUFF_Q = com.auroratv.ui.AuroraExp.on("unstuffq")
  private const val LATE_NS = 5_000_000L
  private const val WAITED_NS = 5_000_000L
  // LATE is cured at once: it costs two refreshes of delay and is only ever seen after a stall.
  // BLOCKED must have lasted 12 frames (200 ms) and is cured at most once a second: a held key
  // is worth one held-back vsync, a single step of 18 frames is not (measured: curing after 3
  // frames held back 8-13 vsyncs in the row-stepping and grid scenarios for no gain at all).
  private const val RUN = 3
  private const val RUN_BLOCKED = 12
  private const val REST_NS = 500_000_000L
  private const val REST_BLOCKED_NS = 1_000_000_000L
  private var lateRun = 0
  private var blockedRun = 0
  private var lastSkip = 0L
  private var frameStart = 0L
  private var cpuStart = 0L
  /** How long the last frame kept the UI thread without using it (wall time minus the thread's CPU time). */
  private var lastWaited = 0L
  private var skips = 0
  private val main by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }
  /** Runs right after the frame this callback belongs to (doFrame is one message; this is the next). */
  private val afterFrame = Runnable {
    lastWaited = (System.nanoTime() - frameStart) - (android.os.Debug.threadCpuTimeNanos() - cpuStart)
    blockedRun = if (lastWaited > WAITED_NS) blockedRun + 1 else 0
  }

  /** True = produce nothing on this vsync. */
  private fun stuffed(frameTimeNanos: Long): Boolean {
    val now = System.nanoTime()
    lateRun = if (now - frameTimeNanos > LATE_NS && lastWaited > WAITED_NS) lateRun + 1 else 0
    val why = when {
      lateRun >= RUN && now - lastSkip > REST_NS -> "late"
      UNSTUFF_Q && blockedRun >= RUN_BLOCKED && now - lastSkip > REST_BLOCKED_NS -> "blocked"
      else -> null
    }
    if (why != null) {
      lastSkip = now
      lateRun = 0
      blockedRun = 0
      lastWaited = 0L
      skips++
      Log.i("AuroraExp", "[unstuff] skip #$skips $why")
      return true
    }
    frameStart = now
    cpuStart = android.os.Debug.threadCpuTimeNanos()
    main.postAtFrontOfQueue(afterFrame)
    return false
  }

  private val cb = Choreographer.FrameCallback { frameTimeNanos ->
    posted = false
    if (active.isEmpty()) return@FrameCallback
    if (UNSTUFF && stuffed(frameTimeNanos)) {
      post()
      return@FrameCallback
    }
    // a driver may add another (a retarget) while we iterate
    val drivers = active.toTypedArray()
    for (d in drivers) {
      val done = try {
        d.step(frameTimeNanos)
      } catch (t: Throwable) {
        Log.w(TAG, "driver failed", t)
        true
      }
      if (done) active.remove(d)
    }
    if (active.isNotEmpty()) post()
  }

  fun add(d: AuroraDriver) {
    UiThreadUtil.assertOnUiThread()
    if (!active.contains(d)) active.add(d)
    post()
  }

  fun remove(d: AuroraDriver) {
    active.remove(d)
  }

  private fun post() {
    if (posted) return
    posted = true
    try {
      ReactChoreographer.getInstance().postFrameCallback(ReactChoreographer.CallbackType.NATIVE_ANIMATED_MODULE, cb)
    } catch (_: Throwable) {
      // no React instance yet (cannot happen for a mounted view, but never die for it)
      Choreographer.getInstance().postFrameCallback(cb)
    }
  }

  /** `[anim] <frameTimeNanos> <id> <value>` while tracing (02-verification.md §4.3). */
  fun trace(frameTimeNanos: Long, id: String, value: Double) {
    if (!AuroraQa.trace) return
    Log.d(TAG, "[anim] $frameTimeNanos $id ${String.format(java.util.Locale.US, "%.6f", value)}")
  }
}
