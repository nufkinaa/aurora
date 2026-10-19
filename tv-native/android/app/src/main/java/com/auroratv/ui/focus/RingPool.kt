package com.auroratv.ui.focus

import java.util.ArrayDeque
import java.util.WeakHashMap

/**
 * The bookkeeping of render switch `ringshare` (ui/view/SharedRing.kt), free of Android types
 * so the JVM tests (RingPoolTest) can drive it: rings handed out per screen key (the context),
 * taken back for reuse up to [keep] per key, counted (in use now, the most at once, made).
 * UI thread only.
 *
 * [cap]: the most rings one screen may have out at once. A ring is out while lit and for its
 * 160 ms fade; at the system's own key repeat (20 a second) a long hold on a slow frame had
 * five or six out (Mi TV, 2026-10-18 — the plan said four). [evictable] names the oldest ring
 * of a screen that is at the cap and already fading, so its owner can hand it back early
 * (it is a few per cent from invisible by then) instead of a fifth one being made.
 */
class RingPool<K : Any, T : Any>(private val keep: Int = 4, val cap: Int = 4) {
  private val free = WeakHashMap<K, ArrayDeque<T>>()
  /** Out now, oldest first, with the screen each was taken for. */
  private val out = LinkedHashMap<T, K>()

  var inUse = 0
    private set
  var peak = 0
    private set
  var made = 0
    private set

  fun acquire(key: K, make: () -> T): T {
    val t = free[key]?.pollFirst() ?: make().also { made++ }
    out[t] = key
    inUse = out.size
    if (inUse > peak) peak = inUse
    return t
  }

  /** A ring given back twice, or one this pool never handed out, is ignored. */
  fun release(key: K, t: T) {
    if (out.remove(t) == null) return
    inUse = out.size
    val q = free.getOrPut(key) { ArrayDeque() }
    if (q.size < keep) q.addFirst(t)
  }

  /** A ring that cannot be reused (still held by a view in an exit transition: its parent
   *  lets go only when the transition ends): out of the count, never handed out again. */
  fun discard(t: T) {
    if (out.remove(t) == null) return
    inUse = out.size
  }

  fun freeCount(key: K): Int = free[key]?.size ?: 0

  /** How many rings screen [key] has out. */
  fun outCount(key: K): Int = out.values.count { it == key }

  /** When screen [key] has [cap] rings out: its oldest one that [fading] says is on its way
   *  out (to be handed back by its owner before the next is taken); null otherwise. */
  fun evictable(key: K, fading: (T) -> Boolean): T? {
    if (outCount(key) < cap) return null
    for ((t, k) in out) if (k == key && fading(t)) return t
    return null
  }
}
