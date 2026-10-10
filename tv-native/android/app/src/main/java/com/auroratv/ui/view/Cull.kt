package com.auroratv.ui.view

import android.view.View
import android.view.ViewGroup
import com.facebook.react.uimanager.PixelUtil

/**
 * LAB experiment `cull` (AuroraExp.kt; docs/qa/native-bench/RENDER.md).
 *
 * WHY. An RN view never clips (`clipChildren = false` all the way up), and HWUI only rejects a
 * whole RenderNode when it clips to its bounds (RenderNodeDrawable::drawContent:
 * `properties.getClipToBounds() && canvas->quickReject(bounds)`). So every card of every
 * mounted shelf — on screen or not — is walked on the RenderThread each frame: prepareTree
 * visits it, its display list is replayed, and each of its ops is rejected one by one. On
 * the Mi TV that is most of the nodes of Home.
 *
 * WHAT. The sliding track (a shelf) and the sliding column (the page) know exactly where
 * their children are, so they leave the ones that are wholly outside the window (plus a
 * margin for the focus ring, the scale and the shadow) out of their own display list:
 * `drawChild` returns without drawing. Nothing else changes — the views stay mounted, laid
 * out and focusable.
 *
 * The slide itself is a RenderNode property (translationX / translationY), which does not
 * re-record the host's display list; so on every step the host asks [moved], and only when
 * the SET of hidden children differs from the one the last recording used is the host
 * invalidated (a re-record of one list of child nodes, not of the children).
 */
internal class Cull(private val host: ViewGroup, private val vertical: Boolean) {
  private val loc = IntArray(2)
  private var origin = 0f
  private var scale = 1f
  private var extent = 0f
  private var margin = 0f
  /** The hidden set the host's current display list was recorded with. */
  private var drawn = 0L
  private var ready = false

  /** Read the host's place in the window; call before asking [hidden]. False = cannot tell (draw all). */
  private fun measure(): Boolean {
    val root = host.rootView ?: return false
    extent = (if (vertical) root.height else root.width).toFloat()
    if (extent <= 0f) return false
    host.getLocationInWindow(loc)
    origin = (if (vertical) loc[1] else loc[0]).toFloat()
    // the logical canvas may be scaled to the panel (src/canvas.tsx): a uniform ancestor scale
    var s = 1f
    var p = host.parent
    while (p is View) {
      s *= if (vertical) p.scaleY else p.scaleX
      p = p.parent
    }
    scale = s * (if (vertical) host.scaleY else host.scaleX)
    margin = PixelUtil.toPixelFromDIP(MARGIN_DP) * scale
    return true
  }

  private fun outside(child: View): Boolean {
    val a = origin + (if (vertical) child.top + child.translationY else child.left + child.translationX) * scale
    val b = origin + (if (vertical) child.bottom + child.translationY else child.right + child.translationX) * scale
    return b + margin < 0f || a - margin > extent
  }

  private fun signature(): Long {
    var sig = 17L
    val n = host.childCount
    for (i in 0 until n) sig = sig * 31L + (if (outside(host.getChildAt(i))) 1L else 2L)
    return sig
  }

  /** The host is about to record its children: fix the hidden set this recording uses. */
  fun beginDraw() {
    ready = measure()
    if (ready) drawn = signature()
  }

  /** During the recording begun by [beginDraw]: is this child left out? */
  fun hidden(child: View): Boolean = ready && outside(child)

  /** The host moved (a slide step): re-record its child list only if the hidden set changed. */
  fun moved() {
    if (!measure()) return
    if (signature() != drawn) host.invalidate()
  }

  companion object {
    /**
     * How far outside the window a child must be before it is left out. A lit card reaches
     * past its box by the ring (3), the scale (5.5 % of half a 224 dp card ≈ 6), the lift and
     * the shadow (offset 10 + blur 24 ≈ 34 dp, drawn at alpha that is 0 well before that);
     * the hero title's text shadow by 26 + 3. 96 dp is more than twice the largest.
     */
    const val MARGIN_DP = 96f
  }
}
