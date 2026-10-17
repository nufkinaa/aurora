package com.auroratv.ui.view

import android.content.Context
import com.auroratv.ui.focus.RingPool
import com.facebook.react.views.view.ReactViewGroup

/**
 * render switch `ringshare` (AuroraRender.kt; docs/qa/native-deep/DEVICE-PLAN.md §ringshare).
 *
 * WHY. Every native Focusable with a plain ring (every card, every row of a list) used to
 * create its ring decoration up front — a ReactViewGroup carrying RN's BorderDrawable and the
 * ring's OutsetBoxShadowDrawable, plus, with `shadowcache`, a ShadowLayer host of two more
 * views — and keep it, at alpha 0, for as long as it was mounted. On Home that is 40–60 dark
 * rings (80–180 views with `shadowcache`) that the RenderThread's prepareTree walks every frame
 * and that every card mount on a held key has to create and style, to show ONE ring.
 *
 * WHAT. The rings live here, per screen (per context): a Focusable takes one when it gains
 * focus and gives it back the moment its fade-out reaches 0. At rest exactly one ring exists;
 * while focus moves faster than the 160 ms fade, the one fading out and the one fading in are
 * several (a held key at 15 moves a second: up to four) — exactly the rings that are visible in
 * the per-instance scheme too. The ring is attached as the Focusable's LAST child, where the
 * per-instance ring sat, so it paints in the same place and order (over the card's content
 * and its focusOverlay) with the same drawables: same pixels. A ring handed from one style to
 * another is restyled through the same BackgroundStyleApplicator calls
 * (AuroraFocusableView.styleSharedRing).
 */
internal object SharedRing {
  class Unit(val ring: ReactViewGroup, val shadow: ShadowLayer?) {
    /** The style it was last given (AuroraFocusableView.styleSharedRing). */
    var signature = ""
  }

  val pool = RingPool<Context, Unit>(keep = 4)

  fun acquire(context: Context, make: () -> Unit): Unit = pool.acquire(context, make)

  fun release(context: Context, u: Unit) = pool.release(context, u)
}

/** The pool's counters for the QA `views` command (SharedRing is internal to this package). */
object SharedRingStats {
  fun read(): IntArray = intArrayOf(SharedRing.pool.inUse, SharedRing.pool.peak, SharedRing.pool.made)
}
