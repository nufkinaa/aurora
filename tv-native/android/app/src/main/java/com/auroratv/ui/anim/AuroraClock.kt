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
  private val cb = Choreographer.FrameCallback { frameTimeNanos ->
    posted = false
    if (active.isEmpty()) return@FrameCallback
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
