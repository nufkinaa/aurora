package com.auroratv.ui.focus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** `ringshare`'s pool (RingPool.kt): one ring at rest, reuse, the overlap of fades. */
class RingPoolTest {
  private class Ring(val n: Int)

  @Test fun oneRingAtRestIsReusedMoveAfterMove() {
    val p = RingPool<String, Ring>()
    var n = 0
    // focus moves slowly: each ring fades out before the next is lit
    val a = p.acquire("home") { Ring(++n) }
    p.release("home", a)
    val b = p.acquire("home") { Ring(++n) }
    assertSame(a, b)
    p.release("home", b)
    assertEquals(1, p.made)
    assertEquals(1, p.peak)
    assertEquals(0, p.inUse)
  }

  @Test fun aHeldKeyOverlapsTheFades() {
    // 15 moves a second (66.7 ms) against a 160 ms fade: a ring is out while lit and fading
    val p = RingPool<String, Ring>()
    var n = 0
    val live = ArrayDeque<Pair<Ring, Double>>()
    var t = 0.0
    repeat(30) {
      while (live.isNotEmpty() && live.first().second <= t) p.release("home", live.removeFirst().first)
      val r = p.acquire("home") { Ring(++n) }
      live.addLast(r to t + 66.7 + 160.0) // lit until the next move, then 160 ms of fade
      t += 66.7
    }
    assertEquals(4, p.peak) // the lit one + the ones still fading
    assertEquals(4, p.made)
    while (live.isNotEmpty()) p.release("home", live.removeFirst().first)
    assertEquals(0, p.inUse)
    assertEquals(4, p.freeCount("home"))
  }

  @Test fun screensDoNotShareAndDoubleReleaseIsIgnored() {
    val p = RingPool<String, Ring>(keep = 2)
    var n = 0
    val a = p.acquire("home") { Ring(++n) }
    p.release("home", a)
    p.release("home", a)
    assertEquals(1, p.freeCount("home"))
    val b = p.acquire("detail") { Ring(++n) }
    assertEquals(2, b.n)
    p.release("detail", b)
    // a foreign ring is not taken in
    p.release("home", Ring(99))
    assertEquals(1, p.freeCount("home"))
  }

  @Test fun aRingStillHeldByALeavingScreenIsNeverHandedOutAgain() {
    // Mi TV 2026-10-18: a ring released while its old parent was in an exit transition kept
    // that parent; handed out again, addView threw. Such a ring is discarded, not pooled.
    val p = RingPool<String, Ring>()
    var n = 0
    val a = p.acquire("home") { Ring(++n) }
    p.discard(a)
    assertEquals(0, p.inUse)
    assertEquals(0, p.freeCount("home"))
    val b = p.acquire("home") { Ring(++n) }
    assertEquals(2, b.n) // a new one, not `a`
    p.release("home", a) // a late release of the discarded one is ignored
    assertEquals(0, p.freeCount("home"))
    assertEquals(1, p.inUse)
  }

  @Test fun theCapHandsBackTheOldestFadingRingFirst() {
    // the system's own repeat (20 a second, 50 ms) on a slow frame: fades last longer than the
    // gap times four — without the cap the fifth and sixth were made (Mi TV, 2026-10-18)
    val p = RingPool<String, Ring>(cap = 4)
    var n = 0
    val lit = HashSet<Ring>()
    val live = ArrayDeque<Pair<Ring, Double>>()
    var t = 0.0
    repeat(40) {
      while (live.isNotEmpty() && live.first().second <= t) p.release("home", live.removeFirst().first)
      // at the cap: the oldest one that is fading (not the lit one) goes back first
      p.evictable("home") { it !in lit }?.let { old ->
        live.removeIf { it.first === old }
        p.release("home", old)
      }
      lit.clear()
      val r = p.acquire("home") { Ring(++n) }
      lit.add(r)
      live.addLast(r to t + 50.0 + 300.0) // lit until the next move, then a long (slow-frame) fade
      t += 50.0
    }
    assertEquals(4, p.peak)
    assertEquals(4, p.made)
  }

  @Test fun underTheCapNothingIsEvicted() {
    val p = RingPool<String, Ring>(cap = 4)
    var n = 0
    repeat(3) { p.acquire("home") { Ring(++n) } }
    assertEquals(null, p.evictable("home") { true })
    p.acquire("detail") { Ring(++n) } // another screen's ring does not count
    assertEquals(null, p.evictable("home") { true })
    p.acquire("home") { Ring(++n) }
    assertEquals(1, p.evictable("home") { true }!!.n)
    assertEquals(2, p.evictable("home") { it.n != 1 }!!.n)
  }
}
