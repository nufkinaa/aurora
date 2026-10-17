package com.auroratv.ui.rail

/**
 * The rail's `slide` value (0 shut → 1 open), shared between the two AuroraRailPanel views
 * of one NavRail: the strip — always mounted — owns and animates it; the panel — mounted
 * only while the rail is open — follows it. They are siblings, so they meet here by the
 * `link` string NavRail.tsx gives both. UI thread only.
 */
class RailLink {
  interface Listener {
    /** `frameTimeNanos` is 0 when the value was placed, not animated. */
    fun onRailSlide(frameTimeNanos: Long, slide: Double)
  }

  var slide = 0.0
    private set
  private val listeners = ArrayList<Listener>()
  internal var refs = 0

  fun publish(frameTimeNanos: Long, value: Double) {
    slide = value
    for (i in listeners.indices) listeners[i].onRailSlide(frameTimeNanos, value)
  }

  fun add(l: Listener) {
    if (!listeners.contains(l)) listeners.add(l)
  }

  fun remove(l: Listener) {
    listeners.remove(l)
  }

  companion object {
    private val links = HashMap<String, RailLink>()

    fun acquire(key: String): RailLink {
      val l = links.getOrPut(key) { RailLink() }
      l.refs++
      return l
    }

    fun release(key: String) {
      val l = links[key] ?: return
      if (--l.refs <= 0) links.remove(key)
    }
  }
}
