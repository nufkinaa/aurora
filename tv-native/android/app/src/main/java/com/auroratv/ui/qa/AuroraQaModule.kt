package com.auroratv.ui.qa

import android.os.SystemClock
import android.util.Log
import android.view.View
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType

/**
 * JS: `NativeModules.AuroraQA` (src/qa.ts). Constants = the flags at startup; the methods
 * are the JS implementation's side of the trace / focus log (only called while a flag is
 * on) and the `nav` command's completion.
 */
class AuroraQaModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraQA"

  override fun getConstants(): Map<String, Any> {
    AuroraQa.ensureLoaded(ctx)
    return mapOf(
      "frozen" to AuroraQa.frozen,
      "trailer" to AuroraQa.trailer,
      "trace" to AuroraQa.trace,
      "focuslog" to AuroraQa.focuslog,
    )
  }

  /** `[anim]` line for a JS-side Animated.Value listener; stamped on arrival (uptime clock). */
  @ReactMethod
  fun trace(id: String, value: Double) {
    if (!AuroraQa.trace) return
    Log.d(AuroraQa.TAG_ANIM, "[anim] ${SystemClock.uptimeMillis() * 1_000_000L} $id ${String.format(java.util.Locale.US, "%.6f", value)}")
  }

  @ReactMethod
  fun focus(gain: Boolean, reactTag: Int, impl: String, edgeLeft: Boolean, edgeRight: Boolean) {
    if (!AuroraQa.focuslog) return
    UiThreadUtil.runOnUiThread { AuroraQa.logFocus(gain, tagFor(reactTag), impl, edgeLeft, edgeRight) }
  }

  @ReactMethod
  fun ring(what: String, reactTag: Int) {
    if (!AuroraQa.focuslog) return
    UiThreadUtil.runOnUiThread { AuroraQa.logRing(what, tagFor(reactTag)) }
  }

  /** navigation.tsx: a `nav` command was dispatched. */
  @ReactMethod
  fun navDone(rid: String, route: String) {
    QaReceiver.navDone(rid, route)
  }

  private fun tagFor(reactTag: Int): String {
    if (reactTag <= 0) return reactTag.toString()
    val v: View? = try {
      UIManagerHelper.getUIManager(ctx, UIManagerType.FABRIC)?.resolveView(reactTag)
    } catch (_: Throwable) {
      null
    }
    return if (v != null) AuroraQa.tagOf(v) else reactTag.toString()
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
