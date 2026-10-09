package com.auroratv.ui

import android.content.Context
import com.auroratv.BuildConfig
import com.auroratv.ui.focus.AuroraRingRegistry
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * The per-component switch (01-architecture.md §4): which rendering implementation each
 * component uses, "js" (the reference) or "native". Stored in SharedPreferences
 * "aurora_impl" (keys focusable|card|row|hero|rail|grid), defaults from
 * BuildConfig.IMPL_DEFAULTS ("focusable=native,card=js", empty = all js), flipped by the
 * QA broadcast (`impl` command, tools/tv-pixel-diff/PROTOCOL.md §3). Read ONCE per launch
 * by src/impl.ts through the AuroraImpl module's constants; a change takes effect on the
 * next launch, never live.
 */
object AuroraImpl {
  const val PREFS = "aurora_impl"
  val KEYS = listOf("focusable", "card", "row", "hero", "rail", "grid")
  private val LETTERS = mapOf("focusable" to "F", "card" to "C", "row" to "R", "hero" to "H", "rail" to "N", "grid" to "G")

  private fun defaults(): Map<String, Boolean> {
    val out = HashMap<String, Boolean>()
    for (k in KEYS) out[k] = false
    for (pair in BuildConfig.IMPL_DEFAULTS.split(',')) {
      val kv = pair.trim().split('=')
      if (kv.size == 2 && kv[0] in KEYS) out[kv[0]] = kv[1].trim() == "native"
    }
    return out
  }

  /** key → native? for every component. */
  fun read(ctx: Context): Map<String, Boolean> {
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val d = defaults()
    val out = LinkedHashMap<String, Boolean>()
    for (k in KEYS) {
      val stored = prefs.getString(k, null)
      out[k] = if (stored == null) d[k] == true else stored == "native"
    }
    return out
  }

  /** `focusable=native,card=js` (any subset; `all=js|native`) → the resulting map, or null on an unknown key. */
  fun write(ctx: Context, arg: String): Map<String, Boolean>? {
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val ed = prefs.edit()
    for (pair in arg.split(',')) {
      val p = pair.trim()
      if (p.isEmpty()) continue
      val kv = p.split('=')
      if (kv.size != 2) return null
      val key = kv[0].trim()
      val value = kv[1].trim()
      if (value != "js" && value != "native") return null
      if (key == "all") {
        for (k in KEYS) ed.putString(k, value)
      } else if (key in KEYS) {
        ed.putString(key, value)
      } else {
        return null
      }
    }
    ed.commit()
    return read(ctx)
  }

  fun format(m: Map<String, Boolean>): String =
    KEYS.joinToString(",") { "$it=${if (m[it] == true) "native" else "js"}" }

  /** "FCR" style letters, "-" when everything is js. */
  fun letters(m: Map<String, Boolean>): String {
    val s = KEYS.filter { m[it] == true }.joinToString("") { LETTERS[it] ?: "" }
    return if (s.isEmpty()) "-" else s
  }
}

/** JS: `NativeModules.AuroraImpl` — constants {impl, letters, versionCode}, read once at startup. */
class AuroraImplModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraImpl"

  override fun getConstants(): Map<String, Any> {
    val m = AuroraImpl.read(ctx)
    val impl = HashMap<String, Any>()
    for ((k, v) in m) impl[k] = v
    return mapOf(
      "impl" to impl,
      "letters" to AuroraImpl.letters(m),
      "versionCode" to BuildConfig.VERSION_CODE,
    )
  }

  /** The JS ring registry lit a ring: a lit native ring fades (01 §5.2). */
  @ReactMethod
  fun jsRingClaimed() {
    UiThreadUtil.runOnUiThread { AuroraRingRegistry.jsRingClaimed() }
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
