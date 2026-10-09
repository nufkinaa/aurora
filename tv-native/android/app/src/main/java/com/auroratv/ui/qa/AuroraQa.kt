package com.auroratv.ui.qa

import android.content.Context
import android.os.SystemClock
import android.util.Log
import android.view.View
import com.facebook.react.R

/**
 * The QA flags (tools/tv-pixel-diff/PROTOCOL.md), compiled into every build and inert until
 * the com.auroratv.QA broadcast sets them. Kept in SharedPreferences "aurora_qa" so a
 * restart between the harness's A and B captures keeps them, and mirrored here as plain
 * volatile booleans so the hot paths pay one field read.
 *
 *   frozen / trailer   `freeze on|off|on,trailer`
 *   trace              `[anim]` + `[key]` lines (tag AuroraAnim)
 *   focuslog           `[focus]` + `[ring]` lines (tag AuroraAnim)
 */
object AuroraQa {
  const val PREFS = "aurora_qa"
  const val TAG_ANIM = "AuroraAnim"

  @Volatile var frozen = false
  @Volatile var trailer = false
  @Volatile var trace = false
  @Volatile var focuslog = false
  @Volatile private var loaded = false

  fun load(ctx: Context) {
    val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    frozen = p.getBoolean("frozen", false)
    trailer = p.getBoolean("trailer", false)
    trace = p.getBoolean("trace", false)
    focuslog = p.getBoolean("focuslog", false)
    loaded = true
  }

  fun ensureLoaded(ctx: Context) {
    if (!loaded) load(ctx)
  }

  fun save(ctx: Context) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean("frozen", frozen)
      .putBoolean("trailer", trailer)
      .putBoolean("trace", trace)
      .putBoolean("focuslog", focuslog)
      .commit()
  }

  /** `[focus] <uptimeMs> gain|loss tag=<id> impl=js|native edgeL=0|1 edgeR=0|1`. */
  fun logFocus(gain: Boolean, tag: String, impl: String, edgeLeft: Boolean, edgeRight: Boolean) {
    if (!focuslog) return
    val b = StringBuilder("[focus] ").append(SystemClock.uptimeMillis()).append(if (gain) " gain" else " loss")
      .append(" tag=").append(tag).append(" impl=").append(impl)
    if (gain) b.append(" edgeL=").append(if (edgeLeft) 1 else 0).append(" edgeR=").append(if (edgeRight) 1 else 0)
    Log.d(TAG_ANIM, b.toString())
  }

  /** `[ring] <uptimeMs> claim|release <tag>`. */
  fun logRing(what: String, tag: String) {
    if (!focuslog) return
    Log.d(TAG_ANIM, "[ring] ${SystemClock.uptimeMillis()} $what $tag")
  }

  /** The id a trace/focus line names a view by: nativeID, else testID, else the react tag. */
  fun tagOf(v: View): String {
    (v.getTag(R.id.view_tag_native_id) as? String)?.let { if (it.isNotEmpty()) return it }
    (v.tag as? String)?.let { if (it.isNotEmpty()) return it }
    return v.id.toString()
  }
}
