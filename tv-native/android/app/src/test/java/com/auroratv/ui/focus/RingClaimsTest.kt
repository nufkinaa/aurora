package com.auroratv.ui.focus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/** RingClaims.kt: one ring, and the blip rule (the taste picker's Keep going, 2026-10-18). */
class RingClaimsTest {
  private class F(val name: String) { var lit = false }

  @Test fun aClaimFadesTheOneThatWasLit() {
    val c = RingClaims<F>()
    val a = F("a"); val b = F("b")
    assertNull(c.claim(a))
    assertSame(a, c.claim(b))
    assertNull(c.claim(b)) // the same one again fades nothing
  }

  @Test fun theBlipLeavesTheFocusedOneDarkAndTheReleaseLightsItAgain() {
    // the card gains focus (preferred focus), the screen underneath's row blips through
    val c = RingClaims<F>()
    val card = F("card").apply { lit = true }
    val under = F("settings row")
    c.claim(card)
    val faded = c.claim(under)
    assertSame(card, faded)
    card.lit = false // ringLostToClaim
    assertTrue(c.release(under)) // the blip's loss: it was the lit one
    // focus is on the card: it is lit again
    assertSame(card, c.relightTarget(card) { it.lit })
  }

  @Test fun anOrdinaryMoveRelightsNothing() {
    // focus moves a → b: b claims (a fades), then a's loss is not the lit one's
    val c = RingClaims<F>()
    val a = F("a"); val b = F("b").apply { lit = true }
    c.claim(a)
    c.claim(b)
    assertFalse(c.release(a))
    assertEquals(b, c.lit)
    // and with something lit there is never a target
    assertNull(c.relightTarget(a) { it.lit })
  }

  @Test fun nothingFocusedOrAlreadyLitIsNoTarget() {
    val c = RingClaims<F>()
    val a = F("a")
    c.claim(a)
    assertTrue(c.release(a))
    assertNull(c.relightTarget(null) { it.lit })
    assertNull(c.relightTarget(F("lit").apply { lit = true }) { it.lit })
  }

  @Test fun aJsClaimClearsWithoutABlipTarget() {
    val c = RingClaims<F>()
    val a = F("a")
    c.claim(a)
    assertSame(a, c.clear())
    assertFalse(c.release(a)) // nothing native was lit: JS holds the ring
  }
}
