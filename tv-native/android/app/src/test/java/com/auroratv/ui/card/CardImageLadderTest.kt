package com.auroratv.ui.card

import com.auroratv.ui.card.CardImageLadder.Show
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The retry ladder's timing table against Card.tsx:173-245 / 10c-spec §1.4:
 *
 *   with a backup:   fail → +1500 ms r=1 → fail → +0 ms backup → fail → tile, round 30 s
 *   without one:     fail → +1500 ms r=1 → fail → tile, round 30 s
 *   rounds 30 s / 120 s / 480 s replay the chain from the first address; the 4th tile parks.
 */
class CardImageLadderTest {
  private fun fresh(backup: Boolean, uri: String = "http://s/img/a?w=256") = CardImageLadder(backup).also { it.restart(uri) }

  @Test
  fun withBackup_retryThenBackupThenTile() {
    val l = fresh(true)
    assertEquals(3, l.tileAt)
    assertEquals(Show.FIRST, l.show())

    val s1 = l.fail()
    assertEquals(1, s1.tries)
    assertEquals(Show.FIRST, s1.now) // keeps showing what failed for a breath
    assertEquals(Show.RETRY, s1.then)
    assertEquals(1500L, s1.delayMs)
    assertFalse(s1.parked)
    l.apply(s1)
    assertEquals(Show.RETRY, l.show())

    val s2 = l.fail()
    assertEquals(2, s2.tries)
    assertEquals(Show.BACKUP, s2.then)
    assertEquals(0L, s2.delayMs) // the backup poster is tried at once
    l.apply(s2)
    assertEquals(Show.BACKUP, l.show())

    val s3 = l.fail()
    assertEquals(3, s3.tries)
    assertEquals(Show.TILE, s3.now) // the tile shows immediately
    assertEquals(Show.FIRST, s3.then)
    assertEquals(30_000L, s3.delayMs)
    assertEquals(0, s3.round)
    assertEquals(Show.TILE, l.show())
  }

  @Test
  fun withoutBackup_retryThenTile() {
    val l = fresh(false)
    assertEquals(2, l.tileAt)
    val s1 = l.fail()
    assertEquals(Show.RETRY, s1.then)
    assertEquals(1500L, s1.delayMs)
    l.apply(s1)
    val s2 = l.fail()
    assertEquals(2, s2.tries)
    assertEquals(Show.TILE, s2.now)
    assertEquals(Show.FIRST, s2.then)
    assertEquals(30_000L, s2.delayMs)
  }

  @Test
  fun slowRoundsThenPark() {
    val l = fresh(false)
    val delays = ArrayList<Long>()
    var last: CardImageLadder.Step? = null
    for (round in 0 until 4) {
      // the chain replays from the first address each round
      assertEquals(Show.FIRST, l.show())
      l.apply(l.fail()) // → retry
      assertEquals(Show.RETRY, l.show())
      last = l.fail() // → tile
      assertEquals(Show.TILE, last.now)
      if (round < 3) {
        assertEquals(round, last.round)
        assertFalse(last.parked)
        delays.add(last.delayMs)
        l.apply(last) // the round timer fired
      }
    }
    assertEquals(listOf(30_000L, 120_000L, 480_000L), delays)
    assertTrue(last!!.parked)
    assertNull(last.then)
    assertTrue(l.parked)
    assertEquals(Show.TILE, l.show())
    // parked: further failures schedule nothing
    val again = l.fail()
    assertTrue(again.parked)
    assertNull(again.then)
  }

  @Test
  fun unparkResetsRoundsAndReturnsToFirst() {
    val l = fresh(false)
    repeat(4) {
      l.apply(l.fail())
      val t = l.fail()
      if (t.then != null) l.apply(t)
    }
    assertTrue(l.parked)
    l.unpark()
    assertFalse(l.parked)
    assertEquals(Show.FIRST, l.show())
    // the rounds start over: the next tile gets round 0 (30 s), not a park
    l.apply(l.fail())
    val t = l.fail()
    assertEquals(0, t.round)
    assertEquals(30_000L, t.delayMs)
    assertFalse(t.parked)
  }

  @Test
  fun newPictureStartsOver_roundsKeyedByAddress() {
    val l = fresh(true, "http://s/img/a?w=256")
    l.apply(l.fail())
    l.apply(l.fail())
    val tileA = l.fail()
    assertEquals(0, tileA.round)
    // a different address: tries restart, and its rounds are its own
    l.restart("http://s/img/b?w=256")
    assertEquals(Show.FIRST, l.show())
    assertEquals(0, l.tries)
    l.apply(l.fail())
    l.apply(l.fail())
    val tileB = l.fail()
    assertEquals(0, tileB.round)
  }

  @Test
  fun constantsMatchCardTsx() {
    assertEquals(1500L, CardImageLadder.RETRY_MS)
    assertEquals(listOf(30_000L, 120_000L, 480_000L), CardImageLadder.ROUND_MS.toList())
  }
}
