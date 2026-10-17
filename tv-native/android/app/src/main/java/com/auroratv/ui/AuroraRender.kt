package com.auroratv.ui

import android.content.Context
import com.auroratv.BuildConfig
import com.auroratv.ui.focus.AuroraRingRegistry
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * The rendering switches (docs/qa/native-port/DEVICE-PLAN.md): which of the native components
 * measured in the native lab (docs/qa/native-lab/) draw the app, and which render fixes are on.
 * EVERY ONE IS OFF unless something turned it on, so a build that never hears of them draws
 * exactly what the JS reference draws.
 *
 *   components  focusable, card, row, hero (billboard art + the sliding column), rail
 *   fixes       cardlayer, cull, shadowcache, unstuff, unstuffq, pool
 *
 * Read ONCE per process (a component swapped while mounted would move focus; the fixes are
 * plain fields read on hot paths), so a change takes effect on the NEXT launch, never live.
 *
 * Where the set comes from, first match wins:
 *   1. "qa"        written by the QA broadcast (ui/qa/QaReceiver.kt — compiled into every build
 *                  but inert unless the build was made with -PqaReceiver=true). The exact set,
 *                  so the harness's A and B runs never depend on a server's answer.
 *   2. "resolved"  written by JS (src/render.ts): the server's `tvRender` answer
 *                  (GET /api/tv/tuning) and the hidden developer setting, combined by
 *                  src/renderRules.ts.
 *   3. BuildConfig.RENDER_DEFAULTS (`-PrenderDefaults=...`, empty by default).
 */
object AuroraRender {
  const val PREFS = "aurora_render"
  private const val QA = "qa"
  private const val RESOLVED = "resolved"
  private const val SERVER = "server"
  private const val LOCAL = "local"

  /** The native components (the lab's `impl` switch; letters F C R H N). */
  val COMPONENTS = listOf("focusable", "card", "row", "hero", "rail")
  private val LETTERS = mapOf("focusable" to "F", "card" to "C", "row" to "R", "hero" to "H", "rail" to "N")

  /** The render fixes (the lab's `exp` switch). */
  val FIXES = listOf("cardlayer", "cull", "shadowcache", "unstuff", "unstuffq", "pool")

  val KEYS: List<String> = COMPONENTS + FIXES

  /**
   * The set the lab measured best on the Mi TV (docs/qa/native-lab/6-…md "ccsu" + 7-…md pool):
   * all five components, cardlayer + cull + shadowcache + unstuff, and the shelf pool.
   * `unstuffq` is NOT in it (a trade of one repeated frame for latency — a call for an eye on
   * the TV). Kept in step with src/renderRules.ts RECOMMENDED (AuroraRenderTest checks it).
   */
  val RECOMMENDED: Set<String> =
    linkedSetOf("focusable", "card", "row", "hero", "rail", "cardlayer", "cull", "shadowcache", "unstuff", "pool")

  @Volatile private var on: Set<String> = emptySet()
  @Volatile private var source = "build"
  @Volatile private var loaded = false

  /**
   * `card,row,cull` (also `card=1,row=0`, and `recommended` for the preset) → the set of keys
   * that are on. Unknown keys are dropped (a stored key a later build retired is not an error).
   */
  fun decode(stored: String?): Set<String> {
    val out = LinkedHashSet<String>()
    if (stored.isNullOrBlank()) return out
    for (raw in stored.split(',')) {
      val p = raw.trim()
      if (p.isEmpty()) continue
      val kv = p.split('=')
      val key = kv[0].trim()
      val value = if (kv.size == 2) kv[1].trim() else "1"
      if (value != "1") {
        if (value == "0") out.remove(key)
        continue
      }
      if (key == "recommended") out.addAll(RECOMMENDED)
      else if (key in KEYS) out.add(key)
    }
    return out
  }

  /** `focusable,card,cull` in KEYS order; empty when nothing is on. */
  fun encode(set: Set<String>): String = KEYS.filter { it in set }.joinToString(",")

  /** "FCRHN" style letters of the native components, "-" when none (the perf event's `impl`). */
  fun letters(set: Set<String>): String =
    COMPONENTS.filter { it in set }.joinToString("") { LETTERS[it] ?: "" }.ifEmpty { "-" }

  /** "cardlayer+cull", "-" when no fix is on (the perf event's `exp`, the QA `ping`). */
  fun fixTag(set: Set<String>): String = FIXES.filter { it in set }.joinToString("+").ifEmpty { "-" }

  // ---- the QA override (QaReceiver) --------------------------------------------------------

  /**
   * The lab's `impl` grammar on top of `current`: `focusable=native,card=js`, `all=native|js`.
   * `grid` is accepted and ignored (the native grid was measured and is not shipped), so the
   * lab's harness lines still work. Null on an unknown key or value.
   */
  fun mergeImpl(current: Set<String>, arg: String): Set<String>? {
    val out = LinkedHashSet(current)
    for (pair in arg.split(',')) {
      val p = pair.trim()
      if (p.isEmpty()) continue
      val kv = p.split('=')
      if (kv.size != 2) return null
      val key = kv[0].trim()
      val value = kv[1].trim()
      if (value != "js" && value != "native") return null
      val keys = when (key) {
        "all" -> COMPONENTS
        "grid" -> emptyList()
        in COMPONENTS -> listOf(key)
        else -> return null
      }
      for (k in keys) if (value == "native") out.add(k) else out.remove(k)
    }
    return out
  }

  /** The lab's `exp` grammar on top of `current`: `none` (every fix off), `key=0|1`. Null on an unknown key. */
  fun mergeExp(current: Set<String>, arg: String): Set<String>? {
    val out = LinkedHashSet(current)
    for (pair in arg.split(',')) {
      val p = pair.trim()
      if (p.isEmpty()) continue
      if (p == "none") {
        out.removeAll(FIXES.toSet())
        continue
      }
      val kv = p.split('=')
      if (kv.size != 2) return null
      val key = kv[0].trim()
      if (key !in FIXES) return null
      when (kv[1].trim()) {
        "1" -> out.add(key)
        "0" -> out.remove(key)
        else -> return null
      }
    }
    return out
  }

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** The QA override as stored, or null when there is none. */
  fun readQa(ctx: Context): Set<String>? = prefs(ctx).getString(QA, null)?.let { decode(it) }

  fun writeQa(ctx: Context, set: Set<String>?) {
    val ed = prefs(ctx).edit()
    if (set == null) ed.remove(QA) else ed.putString(QA, encode(set))
    ed.commit()
  }

  /** What the NEXT launch will run with, and why — the same rule as [ensureLoaded]. */
  fun next(ctx: Context): Pair<Set<String>, String> {
    val p = prefs(ctx)
    p.getString(QA, null)?.let { return decode(it) to "qa" }
    p.getString(RESOLVED, null)?.let { return decode(it) to "saved" }
    return decode(BuildConfig.RENDER_DEFAULTS) to "build"
  }

  // ---- this process ------------------------------------------------------------------------

  /** Once per process (MainApplication.onCreate and the module's constants both call it). */
  fun ensureLoaded(ctx: Context) {
    if (loaded) return
    val (set, src) = next(ctx.applicationContext ?: ctx)
    on = set
    source = src
    loaded = true
  }

  /** Is `key` on for this process? */
  fun on(key: String): Boolean = key in on

  fun active(): Set<String> = on

  fun source(): String = source

  // ---- what JS keeps here --------------------------------------------------------------------

  fun save(ctx: Context, resolved: String, server: String, local: String) {
    prefs(ctx).edit()
      .putString(RESOLVED, encode(decode(resolved)))
      .putString(SERVER, server)
      .putString(LOCAL, local)
      .apply()
  }

  fun stored(ctx: Context, key: String): String = prefs(ctx).getString(key, "") ?: ""

  internal const val KEY_SERVER = SERVER
  internal const val KEY_LOCAL = LOCAL
}

/**
 * JS: `NativeModules.AuroraRender` (src/render.ts). Constants = this launch's switches and what
 * JS stored last time (the server's answer and the developer setting), so JS knows them
 * synchronously at startup. `save` stores what the next launch is to run with.
 */
class AuroraRenderModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraRender"

  override fun getConstants(): Map<String, Any> {
    AuroraRender.ensureLoaded(ctx)
    val set = AuroraRender.active()
    val on = HashMap<String, Any>()
    for (k in set) on[k] = true
    val (nextSet, nextSource) = AuroraRender.next(ctx)
    return mapOf(
      "on" to on,
      "letters" to AuroraRender.letters(set),
      "fixTag" to AuroraRender.fixTag(set),
      "source" to AuroraRender.source(),
      "nextQa" to (nextSource == "qa"),
      "nextQaSet" to AuroraRender.encode(nextSet),
      "server" to AuroraRender.stored(ctx, AuroraRender.KEY_SERVER),
      "local" to AuroraRender.stored(ctx, AuroraRender.KEY_LOCAL),
      "versionCode" to BuildConfig.VERSION_CODE,
    )
  }

  /** What the next launch runs with (`resolved`, KEYS csv) and the two inputs it came from (JSON). */
  @ReactMethod
  fun save(resolved: String, server: String, local: String) {
    AuroraRender.save(ctx, resolved, server, local)
  }

  /** The JS ring registry lit a ring: a lit native ring fades (native-rewrite 01 §5.2). */
  @ReactMethod
  fun jsRingClaimed() {
    UiThreadUtil.runOnUiThread { AuroraRingRegistry.jsRingClaimed() }
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
