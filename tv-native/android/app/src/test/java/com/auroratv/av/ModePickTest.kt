package com.auroratv.av

import com.auroratv.av.ModePick.Mode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which screen mode shows a film without judder (ModePick.kt). */
class ModePickTest {
  private val m60 = Mode(1, 1920, 1080, 60f)
  private val m5994 = Mode(2, 1920, 1080, 59.94f)
  private val m50 = Mode(3, 1920, 1080, 50f)
  private val m24 = Mode(4, 1920, 1080, 24f)
  private val m23976 = Mode(5, 1920, 1080, 23.976f)
  private val m30 = Mode(6, 1920, 1080, 30f)
  private val m25 = Mode(7, 1920, 1080, 25f)
  private val uhd60 = Mode(8, 3840, 2160, 60f)
  private val uhd24 = Mode(9, 3840, 2160, 24f)
  private val all = listOf(m60, m5994, m50, m24, m23976, m30, m25, uhd60, uhd24)

  @Test fun filmOnSixtyGoesToItsOwnRate() {
    assertEquals(m23976, ModePick.choose(m60, all, 23.976f))
    assertEquals(m24, ModePick.choose(m60, all, 24f))
    assertEquals(m25, ModePick.choose(m60, all, 25f))
    assertEquals(m50, ModePick.choose(m60, all, 50f))
    assertEquals(m5994, ModePick.choose(m60, all, 59.94f))
  }

  @Test fun aScreenThatAlreadyShowsTheRateIsLeftAlone() {
    assertNull(ModePick.choose(m60, all, 30f)) // 2 × 30
    assertNull(ModePick.choose(m60, all, 60f))
    assertNull(ModePick.choose(m50, all, 25f)) // 2 × 25
    assertNull(ModePick.choose(m5994, all, 29.97f))
    assertNull(ModePick.choose(m23976, all, 23.976f))
  }

  @Test fun near_24ForFilmOnlyWhenNothingExact() {
    val no23976 = listOf(m60, m50, m24)
    assertEquals(m24, ModePick.choose(m60, no23976, 23.976f))
    // already near (24 Hz for 23.976): not worth the blink
    assertNull(ModePick.choose(m24, no23976, 23.976f))
    // near → exact is worth it
    assertEquals(m23976, ModePick.choose(m24, all, 23.976f))
    // 59.94 content on a 60-only screen: near already, nothing better
    assertNull(ModePick.choose(m60, listOf(m60, m50), 59.94f))
  }

  @Test fun theResolutionNeverChanges() {
    assertEquals(uhd24, ModePick.choose(uhd60, all, 24f))
    // a 4K screen with no 4K mode for 25: stays (never drops to 1080p for the rate)
    assertNull(ModePick.choose(uhd60, all, 25f))
  }

  @Test fun noFittingMode_orNoRealFrameRate_staysPut() {
    assertNull(ModePick.choose(m60, listOf(m60), 23.976f))
    assertNull(ModePick.choose(m60, all, 0f))
    assertNull(ModePick.choose(m60, all, 5f))
    assertNull(ModePick.choose(m60, all, 240f))
  }

  @Test fun theLowestMultipleWins() {
    val m48 = Mode(10, 1920, 1080, 47.952f)
    val m120 = Mode(11, 1920, 1080, 119.88f)
    assertEquals(m23976, ModePick.choose(m60, listOf(m60, m120, m48, m23976), 23.976f))
    assertEquals(m48, ModePick.choose(m60, listOf(m60, m120, m48), 23.976f))
    // 50 for 25 when there is no 25
    assertEquals(m50, ModePick.choose(m60, listOf(m60, m50), 25f))
  }

  @Test fun fitReadsExactNearAndNot() {
    assertEquals(0, ModePick.fit(23.976f, 24000f / 1001f))
    assertEquals(1, ModePick.fit(24f, 23.976f))
    assertEquals(-1, ModePick.fit(60f, 23.976f))
    assertEquals(0, ModePick.fit(50f, 25f))
    assertEquals(-1, ModePick.fit(0f, 25f))
  }
}
