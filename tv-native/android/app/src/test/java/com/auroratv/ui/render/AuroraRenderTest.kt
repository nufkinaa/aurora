package com.auroratv.ui.render

import com.auroratv.ui.AuroraRender
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The rendering switches' grammar (ui/AuroraRender.kt): stored words, the QA override's `impl` / `exp`. */
class AuroraRenderTest {
  @Test fun nothingIsOnByDefault() {
    assertEquals(emptySet<String>(), AuroraRender.decode(null))
    assertEquals(emptySet<String>(), AuroraRender.decode(""))
    assertEquals("-", AuroraRender.letters(emptySet()))
    assertEquals("-", AuroraRender.fixTag(emptySet()))
    assertEquals("", AuroraRender.encode(emptySet()))
  }

  @Test fun storedWordsRoundTripInKeyOrder() {
    val s = AuroraRender.decode("cull,card,retired,,row")
    assertEquals(setOf("card", "row", "cull"), s)
    assertEquals("card,row,cull", AuroraRender.encode(s))
    assertEquals("CR", AuroraRender.letters(s))
    assertEquals("cull", AuroraRender.fixTag(s))
    // the =1 / =0 form and the preset
    assertEquals(setOf("card"), AuroraRender.decode("card=1,row=0"))
    val rec = AuroraRender.decode("recommended")
    assertEquals(AuroraRender.RECOMMENDED, rec)
    assertFalse("unstuffq" in rec)
    assertEquals("FCRHN", AuroraRender.letters(rec))
    assertEquals("cardlayer+cull+shadowcache+unstuff+pool", AuroraRender.fixTag(rec))
  }

  @Test fun qaImplGrammar() {
    val a = AuroraRender.mergeImpl(emptySet(), "all=native")!!
    assertEquals(AuroraRender.COMPONENTS.toSet(), a)
    val b = AuroraRender.mergeImpl(a + "cull", "card=js, grid=native")!!
    assertEquals(setOf("focusable", "row", "hero", "rail", "cull"), b)
    assertEquals(setOf("cull"), AuroraRender.mergeImpl(b, "all=js"))
    assertNull(AuroraRender.mergeImpl(emptySet(), "card=yes"))
    assertNull(AuroraRender.mergeImpl(emptySet(), "nope=native"))
    assertNull(AuroraRender.mergeImpl(emptySet(), "card"))
  }

  @Test fun qaExpGrammar() {
    val a = AuroraRender.mergeExp(setOf("card"), "cull=1,cardlayer=1")!!
    assertEquals(setOf("card", "cull", "cardlayer"), a)
    assertEquals(setOf("card"), AuroraRender.mergeExp(a, "none"))
    assertEquals(setOf("card", "pool"), AuroraRender.mergeExp(a, "none,pool=1"))
    // the lab's attribution removals and dropped experiments are not in production
    assertNull(AuroraRender.mergeExp(emptySet(), "x_hero=1"))
    assertNull(AuroraRender.mergeExp(emptySet(), "taglayer=1"))
    assertNull(AuroraRender.mergeExp(emptySet(), "card=1")) // a component is not a fix
    assertNull(AuroraRender.mergeExp(emptySet(), "cull=yes"))
  }
}
