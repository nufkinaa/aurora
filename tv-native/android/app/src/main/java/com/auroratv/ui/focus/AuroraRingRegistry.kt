package com.auroratv.ui.focus

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.auroratv.ui.qa.AuroraQa
import com.auroratv.ui.view.AuroraFocusableView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * The "only one ring" rule (Focusable.tsx:59-78) for native Focusables: whoever gains
 * focus fades the one that was lit, so a dropped blur event can never leave a ghost ring.
 *
 * In the mixed phase the JS registry still exists for JS Focusables. The two are joined
 * (01-architecture.md §5.2) without a call on the common path:
 *  - a native claim emits one device event `AuroraRingClear` — only if JS told us it has
 *    a lit ring (`jsClaimed`), which it only does after it has heard `AuroraRingLit` once;
 *  - a JS claim calls `AuroraRender.jsRingClaimed()` → [releaseAll] — only after a native
 *    ring has been lit in this process.
 * With `impl focusable` flipped for the whole app neither path ever runs. UI thread only.
 */
object AuroraRingRegistry {
  private const val TAG = "AuroraAnim"
  /** Who is lit, whom a claim fades, the blip rule (RingClaims.kt, tested). */
  private val claims = RingClaims<AuroraFocusableView>()
  private val main = Handler(Looper.getMainLooper())
  /** JS said one of its rings is lit (and has not been cleared by us since). */
  private var jsLit = false
  /** A native ring has been lit at least once: JS is told, and starts reporting its claims. */
  private var nativeEverLit = false

  fun claim(v: AuroraFocusableView, ctx: ReactContext?) {
    UiThreadUtil.assertOnUiThread()
    claims.claim(v)?.ringLostToClaim()
    if (AuroraQa.focuslog) Log.d(TAG, "[ring] ${SystemClock.uptimeMillis()} claim ${v.qaTag()}")
    if (!nativeEverLit) {
      nativeEverLit = true
      emit(ctx, "AuroraRingLit", null)
    }
    if (jsLit) {
      jsLit = false
      emit(ctx, "AuroraRingClear", null)
    }
  }

  fun release(v: AuroraFocusableView) {
    if (claims.release(v)) {
      if (AuroraQa.focuslog) Log.d(TAG, "[ring] ${SystemClock.uptimeMillis()} release ${v.qaTag()}")
      // after this focus change has run its course: a blip leaves the focused one dark
      val ctx = v.context as? ReactContext
      main.post { relightFocused(ctx) }
    }
  }

  /** The blip rule (RingClaims.relightTarget): the Focusable holding focus now, dark, is lit. */
  private fun relightFocused(ctx: ReactContext?) {
    val root = ctx?.currentActivity?.window?.decorView ?: return
    val focused = root.findFocus() as? AuroraFocusableView
    val t = claims.relightTarget(focused) { it.isLitNow() } ?: return
    if (!t.isAttachedToWindow || !t.isFocused) return
    Log.i("AuroraRender", "[ring] relit ${t.qaTag()} after a focus blip")
    t.relight()
  }

  /** A JS Focusable claimed its ring: ours fades. */
  fun jsRingClaimed() {
    UiThreadUtil.assertOnUiThread()
    jsLit = true
    claims.clear()?.ringLostToClaim()
  }

  /** The `clearRing` command / QA: fade whatever is lit. */
  fun releaseAll() {
    claims.clear()?.ringLostToClaim()
  }

  private fun emit(ctx: ReactContext?, name: String, body: Any?) {
    try {
      ctx?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)?.emit(name, body ?: Arguments.createMap())
    } catch (_: Throwable) {}
  }
}
