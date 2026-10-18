package com.auroratv.ui.focus

/**
 * The bookkeeping of the "only one ring" rule (AuroraRingRegistry), pure so it is tested
 * (RingClaimsTest): who is lit, whom a claim fades, and THE BLIP RULE.
 *
 * The blip (Mi TV device pass, 2026-10-18; the taste picker's "Keep going" and the next
 * card): when the focused Focusable is removed and a new one takes focus by
 * hasTVPreferredFocus, Android's focus search can pass focus for a moment through a third
 * Focusable (one on the screen underneath) AFTER the new one claimed. That claim faded the
 * new one; its loss a millisecond later left nothing lit while the new one keeps focus — a
 * focused card with no ring until focus next moves. So when the lit one lets go, whoever
 * holds focus now and is dark is lit again.
 */
class RingClaims<V : Any> {
  var lit: V? = null
    private set

  /** `v` gained focus: the one to fade (null when nothing else was lit). */
  fun claim(v: V): V? {
    val prev = lit
    lit = v
    return if (prev != null && prev !== v) prev else null
  }

  /** `v` lost focus or went away: true when it was the lit one (then look for a blip). */
  fun release(v: V): Boolean {
    if (lit !== v) return false
    lit = null
    return true
  }

  /** Something else took the ring away (JS, the clearRing command): the one to fade. */
  fun clear(): V? {
    val prev = lit
    lit = null
    return prev
  }

  /** After a release: the Focusable holding focus now, when nothing is lit and it is dark. */
  fun relightTarget(focused: V?, isLit: (V) -> Boolean): V? =
    if (lit == null && focused != null && !isLit(focused)) focused else null
}
