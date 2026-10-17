package com.auroratv.ui.focus

import java.util.ArrayDeque
import java.util.WeakHashMap

/**
 * The bookkeeping of render switch `ringshare` (ui/view/SharedRing.kt), free of Android types
 * so the JVM tests (RingPoolTest) can drive it: rings handed out per screen key (the context),
 * taken back for reuse up to [keep] per key, counted (in use now, the most at once, made).
 * UI thread only.
 */
class RingPool<K : Any, T : Any>(private val keep: Int = 4) {
  private val free = WeakHashMap<K, ArrayDeque<T>>()
  private val out = HashSet<T>()

  var inUse = 0
    private set
  var peak = 0
    private set
  var made = 0
    private set

  fun acquire(key: K, make: () -> T): T {
    val t = free[key]?.pollFirst() ?: make().also { made++ }
    out.add(t)
    inUse = out.size
    if (inUse > peak) peak = inUse
    return t
  }

  /** A ring given back twice, or one this pool never handed out, is ignored. */
  fun release(key: K, t: T) {
    if (!out.remove(t)) return
    inUse = out.size
    val q = free.getOrPut(key) { ArrayDeque() }
    if (q.size < keep) q.addFirst(t)
  }

  fun freeCount(key: K): Int = free[key]?.size ?: 0
}
