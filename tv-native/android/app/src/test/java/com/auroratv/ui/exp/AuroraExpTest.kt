package com.auroratv.ui.exp

import com.auroratv.ui.AuroraExp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AuroraExpTest {
  @Test fun nothingIsOnByDefault() {
    assertEquals(emptySet<String>(), AuroraExp.decode(null))
    assertEquals(emptySet<String>(), AuroraExp.decode(""))
    assertEquals("-", AuroraExp.tag(emptySet()))
    assertEquals("", AuroraExp.encode(emptySet()))
  }

  @Test fun mergeSetsClearsAndKeeps() {
    val a = AuroraExp.merge(emptySet(), "shadowcache=1,cull=1")!!
    assertEquals(setOf("cull", "shadowcache"), a)
    assertEquals("cull+shadowcache", AuroraExp.tag(a))
    assertEquals("cull=1,shadowcache=1", AuroraExp.encode(a))
    val b = AuroraExp.merge(a, "cull=0, x_hero=1")!!
    assertEquals(setOf("shadowcache", "x_hero"), b)
    assertEquals(emptySet<String>(), AuroraExp.merge(b, "none"))
    assertEquals(setOf("taglayer"), AuroraExp.merge(b, "none,taglayer=1"))
  }

  @Test fun unknownKeysAndValuesAreRefused() {
    assertNull(AuroraExp.merge(emptySet(), "nope=1"))
    assertNull(AuroraExp.merge(emptySet(), "cull=yes"))
    assertNull(AuroraExp.merge(emptySet(), "cull"))
  }

  @Test fun roundTrip() {
    val s = setOf("x_text", "cull", "cardlayer")
    assertEquals(s, AuroraExp.decode(AuroraExp.encode(s)))
    // a stored key this build no longer knows is dropped, not an error
    assertEquals(setOf("cull"), AuroraExp.decode("cull=1,retired=1,taglayer=0"))
  }
}
