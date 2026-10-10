package com.auroratv.ui

import android.content.Context

/**
 * LAB ONLY — rendering experiments (docs/qa/native-bench/RENDER.md), each behind its own
 * switch and all OFF by default, so the lab app stays the reference picture.
 *
 * Stored in SharedPreferences "aurora_exp" as one string ("cull=1,cardlayer=1"), written by the
 * QA broadcast (`cmd exp`, tools/tv-pixel-diff/PROTOCOL.md §3) and read ONCE per process:
 * like the impl switch, a change takes effect on the next launch, never live — the hot
 * paths read a plain field.
 *
 *   `exp "cull=1,taglayer=0"`   set some, keep the others
 *   `exp "none"`            everything off
 *
 * Two families. FIXES keep the picture (or say by how much they change it); the `x_…` keys
 * REMOVE something from the frame and exist only to attribute render-thread time to it.
 */
object AuroraExp {
  const val PREFS = "aurora_exp"
  private const val KEY = "on"

  /** Fixes (RENDER.md, part 2). */
  val FIXES = listOf(
    "cull",        // Row / Column leave children that are wholly off screen out of their display list (Cull.kt)
    "cardlayer",   // a card that rests dark is ONE hardware layer (AuroraFocusableView.syncLayer)
    "taglayer",    // the progress bar and the NEW / kind pills are each one hardware layer (Card.tsx)
    "shadowcache", // a box-shadow is blurred once into a layered host, then composited (ShadowLayer.kt)
    "pool",        // a shelf keeps its card slots mounted and rebinds them: no Fabric mounts on a window move (PoolHost.kt, POOL-PLAN.md)
  )

  /** Removals, for attribution only — every one of these changes the picture. */
  val REMOVALS = listOf(
    "x_hero", "x_ambient", "x_rail", "x_herocol", "x_cards", "x_cardart", "x_clip", "x_shade",
    "x_text", "x_textshadow", "x_tags", "x_shadow", "x_fade", "x_border", "x_rowtitle", "x_svg",
    "x_progress", "x_kind", "x_new", "x_progshadow", "x_proggrad",
  )

  val KEYS: List<String> = FIXES + REMOVALS

  @Volatile private var on: Set<String> = emptySet()
  @Volatile private var loaded = false

  /** `a=1,b=0` → the set of keys that are on. */
  fun decode(stored: String?): Set<String> {
    val out = LinkedHashSet<String>()
    if (stored.isNullOrEmpty()) return out
    for (pair in stored.split(',')) {
      val kv = pair.trim().split('=')
      if (kv.size == 2 && kv[0] in KEYS && kv[1] == "1") out.add(kv[0])
    }
    return out
  }

  /**
   * Apply `arg` (`none`, or `key=0|1,…`; any subset) on top of `current`. Null on an
   * unknown key or value — nothing is written then.
   */
  fun merge(current: Set<String>, arg: String): Set<String>? {
    val out = LinkedHashSet(current)
    for (pair in arg.split(',')) {
      val p = pair.trim()
      if (p.isEmpty()) continue
      if (p == "none") {
        out.clear()
        continue
      }
      val kv = p.split('=')
      if (kv.size != 2) return null
      val key = kv[0].trim()
      if (key !in KEYS) return null
      when (kv[1].trim()) {
        "1" -> out.add(key)
        "0" -> out.remove(key)
        else -> return null
      }
    }
    return out
  }

  /** `cull=1,cardlayer=1` in KEYS order; empty when nothing is on. */
  fun encode(set: Set<String>): String = KEYS.filter { it in set }.joinToString(",") { "$it=1" }

  /** `cull+cardlayer`, `-` when nothing is on: the perf event's `exp` field and the `ping` answer. */
  fun tag(set: Set<String>): String = KEYS.filter { it in set }.joinToString("+").ifEmpty { "-" }

  fun read(ctx: Context): Set<String> =
    decode(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, ""))

  fun write(ctx: Context, arg: String): Set<String>? {
    val next = merge(read(ctx), arg) ?: return null
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, encode(next)).commit()
    return next
  }

  /** Once per process (MainApplication.onCreate and the module's constants both call it). */
  fun ensureLoaded(ctx: Context) {
    if (loaded) return
    on = read(ctx.applicationContext ?: ctx)
    loaded = true
  }

  /** The value this process started with. */
  fun on(key: String): Boolean = key in on

  fun active(): Set<String> = on
}
