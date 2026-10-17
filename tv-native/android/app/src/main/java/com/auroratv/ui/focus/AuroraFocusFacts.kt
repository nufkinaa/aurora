package com.auroratv.ui.focus

import android.os.SystemClock
import android.view.View
import java.lang.ref.WeakReference

/**
 * The native twin of focus.ts's process-wide facts (01-architecture.md §5.2). In P1 it is
 * write-only from the native Focusable; JS keeps reading its own copy, fed by the
 * `onFocusChange` event. The two converge when the rail's key logic moves native. UI thread.
 */
object AuroraFocusFacts {
  private var held: WeakReference<View>? = null
  var heldEdgeLeft = true
    private set
  var heldEdgeRight = false
    private set
  var lastFocusMoveAt = 0L
    private set

  fun note(v: View, edgeLeft: Boolean, edgeRight: Boolean) {
    if (held?.get() !== v) lastFocusMoveAt = SystemClock.uptimeMillis()
    held = WeakReference(v)
    heldEdgeLeft = edgeLeft
    heldEdgeRight = edgeRight
  }

  fun lost(v: View) {
    if (held?.get() === v) held = null
  }

  fun focusJustMoved(withinMs: Long) = SystemClock.uptimeMillis() - lastFocusMoveAt < withinMs
}
