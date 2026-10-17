package com.auroratv.ui.card

import com.auroratv.ui.card.CardGeometry.Box
import com.auroratv.ui.card.CardGeometry.Line
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `cardtext`'s box layout (CardGeometry.kt) against Yoga's results for Card.tsx's styles,
 * worked out by hand at the Mi TV's density 2 (and one at 1.5, where the rounding shows).
 * A poster card's padding box: 124 − 2 × 1 = 122 × 184 dp = 244 × 368 px.
 */
class CardGeometryTest {
  private val s = 2.0
  private val root = CardGeometry.root(244, 368)

  @Test fun yogaRoundsHalfUp() {
    assertEquals(3.0, CardGeometry.roundPx(1.25, 2.0), 0.0) // 2.5 px → 3
    assertEquals(2.0, CardGeometry.roundPx(1.2, 2.0), 0.0) // 2.4 → 2
    assertEquals(-2.0, CardGeometry.roundPx(-1.25, 2.0), 0.0) // −2.5 → −2 (a fraction of .5 goes up)
    assertEquals(4.0, CardGeometry.roundPx(2.66666, 1.5), 0.0) // 3.99999 → 4 (inexactly whole)
  }

  @Test fun theLabelStacksUpFromItsBottom() {
    // `.card-label` left 8 right 8 bottom 7, an episode: two 14 dp lines of 38 px each
    val n = CardGeometry.stack(root, 122.0, 184.0, 8.0, 8.0, 7.0, listOf(Line(38, 0.0), Line(38, 0.0)), s)
    assertEquals(Box(16, 368 - 14 - 76, 212, 76), n[0].box)
    assertEquals(Box(16, 278, 212, 38), n[1].box)
    assertEquals(Box(16, 316, 212, 38), n[2].box)
    // raised over a bar: bottom 14
    val r = CardGeometry.stack(root, 122.0, 184.0, 8.0, 8.0, 14.0, listOf(Line(38, 0.0)), s)
    assertEquals(Box(16, 368 - 28 - 38, 212, 38), r[1].box)
  }

  @Test fun theFrameLabelKeepsItsMargins() {
    // frameLabel left/right 11 bottom 17: title (lineHeight 20 → 40 px), sub mt 1, meta mt 3
    val w = CardGeometry.root(444, 276) // FRAME 224 × 140 → 222 × 138 dp
    val n = CardGeometry.stack(w, 222.0, 138.0, 11.0, 11.0, 17.0, listOf(Line(40, 0.0), Line(36, 1.0), Line(36, 3.0)), s)
    val h = 40 + 2 + 36 + 6 + 36
    assertEquals(Box(22, 276 - 34 - h, 400, h), n[0].box)
    assertEquals(276 - 34 - h, n[1].box.y)
    assertEquals(276 - 34 - h + 40 + 2, n[2].box.y)
    assertEquals(276 - 34 - h + 40 + 2 + 36 + 6, n[3].box.y)
  }

  @Test fun pillsAreSizedByWhatTheyHold() {
    // NEW: left 7 top 7, padding 1/5, border 1, the text 41 × 30 px
    val n = CardGeometry.pill(root, 122.0, 7.0, 7.0, null, 20.5, 15.0, 1.0, 5.0, 1.0, 5.0, 1.0, s)
    assertEquals(Box(14, 14, 41 + 24, 30 + 8), n[0].box)
    assertEquals(Box(14 + 12, 14 + 4, 41, 30), n[1].box)
    // kind: right 7, padding 2/6, the 11 dp icon → 25 × 17 dp at the right edge
    val k = CardGeometry.pill(root, 122.0, 7.0, null, 7.0, 11.0, 11.0, 2.0, 6.0, 2.0, 6.0, 1.0, s)
    assertEquals(Box(244 - 14 - 50, 14, 50, 34), k[0].box)
    assertEquals(Box(244 - 14 - 50 + 14, 14 + 6, 22, 22), k[1].box)
  }

  @Test fun theBarAndItsBead() {
    // a wide card's 226 × 128 dp padding box, track left/right 8 bottom 6 height 4, 33 %
    val w = CardGeometry.root(452, 256)
    val n = CardGeometry.progress(w, 226.0, 128.0, 8.0, 8.0, 6.0, 4.0, 33, -3.0, -2.0, 8.0, 8.0, s)
    assertEquals(Box(16, 256 - 12 - 8, 420, 8), n[0].box)
    // 210 dp × 0.33 = 69.3 dp = 138.6 px: the fill ends at round(16 + 138.6) = 155
    assertEquals(Box(16, 236, 139, 8), n[1].box)
    // the bead: 69.3 + 3 − 8 = 64.3 dp into the fill (128.6 → 129 px), top −2 dp
    assertEquals(Box(16 + 129, 236 - 4, 16, 16), n[2].box)
  }

  @Test fun aCentredTextRoundsLikeYoga() {
    // the ✕: a 30 dp box at right 6 top 6; a 25 × 39 px glyph: (60 − 25) / 2 = 17.5 px → 18
    val n = CardGeometry.centred(root, 122.0 - 6.0 - 30.0, 6.0, 30.0, 30.0, 0.0, 25, 39, s)
    assertEquals(Box(172, 12, 60, 60), n[0].box)
    assertEquals(Box(172 + 18, 12 + 11, 25, 39), n[1].box)
  }

  @Test fun atDensityOnePointFiveTheRoundingIsYogas() {
    // the label at left 8 = 12 px; its top 184 − 7 − 29/1.5 = 157.67 dp = 236.5 px → 237
    val r = CardGeometry.root(183, 276) // 122 × 184 dp
    val n = CardGeometry.stack(r, 122.0, 184.0, 8.0, 8.0, 7.0, listOf(Line(29, 0.0)), 1.5)
    assertEquals(Box(12, 237, 159, 29), n[0].box)
  }
}
