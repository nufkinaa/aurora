package com.auroratv.ui.home

/**
 * What Home's sliding column tells its billboard art, without JavaScript in between: its
 * offset on every spring step, and whether focus is up in the hero (`atTop`). The two
 * views are siblings, mounted and dropped independently, so they meet here by the `link`
 * string Home.tsx gives both. UI thread only.
 */
class ColumnLink {
  interface Listener {
    /** The column drew a new offset (dp). `frameTimeNanos` is 0 when it was placed, not animated. */
    fun onColumnOffset(frameTimeNanos: Long, offset: Double)

    /** Focus moved between the hero and the shelves. */
    fun onColumnTop(atTop: Boolean)
  }

  var offset = 0.0
    private set
  var atTop = true
    private set
  private val listeners = ArrayList<Listener>()
  internal var refs = 0

  fun publishOffset(frameTimeNanos: Long, value: Double) {
    offset = value
    for (i in listeners.indices) listeners[i].onColumnOffset(frameTimeNanos, value)
  }

  fun publishTop(value: Boolean) {
    if (atTop == value) return
    atTop = value
    for (i in listeners.indices) listeners[i].onColumnTop(value)
  }

  fun add(l: Listener) {
    if (!listeners.contains(l)) listeners.add(l)
  }

  fun remove(l: Listener) {
    listeners.remove(l)
  }

  companion object {
    private val links = HashMap<String, ColumnLink>()

    fun acquire(key: String): ColumnLink {
      val l = links.getOrPut(key) { ColumnLink() }
      l.refs++
      return l
    }

    fun release(key: String) {
      val l = links[key] ?: return
      if (--l.refs <= 0) links.remove(key)
    }
  }
}
