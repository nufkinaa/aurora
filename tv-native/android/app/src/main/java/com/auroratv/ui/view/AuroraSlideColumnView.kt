package com.auroratv.ui.view

import android.content.Context
import android.graphics.Canvas
import android.view.View
import com.auroratv.ui.AuroraExp
import com.auroratv.ui.anim.AuroraClock
import com.auroratv.ui.anim.AuroraDriver
import com.auroratv.ui.anim.AuroraSpring
import com.auroratv.ui.home.ColumnLink
import com.auroratv.ui.home.HomeMath
import com.auroratv.ui.qa.AuroraQa
import com.auroratv.ui.row.RowMath
import com.facebook.react.R
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.view.ReactViewGroup

/**
 * "AuroraSlideColumn" — Home's sliding column (P4; src/specs/AuroraSlideColumnNativeComponent.ts).
 *
 * It stands where Home.tsx's `Animated.View style={column}` stands and is the same kind of
 * view (a ReactViewGroup: Yoga places the hero block, the shelves and the spacer; nothing is
 * clipped). Its children are whatever React mounts.
 *
 * What moved here is the slide's input path, as AuroraRowView did for a shelf. In the JS
 * column a key press goes
 *   Android moves focus → topFocus → JS → Card.onFocus → Row.focusCard → Home.toRow →
 *   Animated.spring(ty).start() → NativeAnimatedModule's queue → the driver's first frame.
 * Here [requestChildFocus] — called on every ancestor while Android is moving focus — finds
 * which marked child the focus landed in and starts the driver itself:
 *
 *   - the hero block (nativeID "aurora-col-top")   → 0             (Home.tsx toHero)
 *   - shelf i        (nativeID "aurora-col-row-i") → targets[i]    (Home.tsx toRow)
 *
 * `targets` are Home.tsx's own numbers — `-min(max(0, rowY - 27), max(0, colH - height))`
 * from its measured layout — recomputed there on every layout event and committed as a prop;
 * nothing of Home's geometry is derived here. A row whose target has not arrived yet does
 * not slide (toRow's `if (y == null) return`). A new `targets` prop never moves the column
 * by itself: like the JS, only a focus change does.
 *
 * The motion is `useSlide()`'s (motion.ts SLIDE_SPRING, the same spring as a shelf): RN's
 * native SpringAnimation ([AuroraSpring]) from the same Choreographer phase; EVERY focus
 * change replaces the driver — even toward the value it rests at, as `toRow` does on each
 * card of the same row — and the new one starts from the value the last frame drew with
 * velocity 0 (AuroraSpring's header: what the shipped native driver does on a restart).
 *
 * The value is dp as a double; applied as BaseViewManager applies a decomposed translateY:
 * `translationY = PixelUtil.toPixelFromDIP(value as float)`, unrounded.
 *
 * Each step is published to the [ColumnLink] the billboard art listens on (its fade is a
 * function of this offset, and its `atTop` cross-fade starts on the same focus change), so
 * neither waits for JS. JS is told afterwards, once, with `onRowFocus {index}` (-1 = hero).
 */
class AuroraSlideColumnView(context: Context) : ReactViewGroup(context) {

  // ---- props (AuroraSlideColumnManager) ------------------------------------------------
  private var targets = DoubleArray(0)
  private var linkKey = ""
  private var link: ColumnLink? = null

  // ---- state ---------------------------------------------------------------------------
  /** translateY in dp — the animated node's value. */
  private var value = 0.0
  private var spring: AuroraSpring? = null
  private var atTop = true

  private val driver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = spring ?: return true
      value = d.step(frameTimeNanos, value)
      apply()
      link?.publishOffset(frameTimeNanos, value)
      AuroraClock.trace(frameTimeNanos, TRACE_ID, value)
      if (d.finished) spring = null
      return d.finished
    }
  }

  fun setTargets(array: ReadableArray?) {
    val n = array?.size() ?: 0
    val next = DoubleArray(n)
    for (i in 0 until n) next[i] = array!!.getDouble(i)
    targets = next
  }

  fun setLink(key: String?) {
    val k = key ?: ""
    if (k == linkKey) return
    dropLink()
    linkKey = k
    if (k.isNotEmpty()) {
      link = ColumnLink.acquire(k).also {
        it.publishOffset(0L, value)
        it.publishTop(atTop)
      }
    }
  }

  private fun dropLink() {
    if (linkKey.isNotEmpty()) ColumnLink.release(linkKey)
    link = null
    linkKey = ""
  }

  // ---- focus → slide -------------------------------------------------------------------

  /** Android is moving focus onto `focused`, somewhere under our direct child `child`. */
  override fun requestChildFocus(child: View, focused: View) {
    super.requestChildFocus(child, focused)
    val marker = markerAbove(focused)
    if (marker == HomeMath.NONE) return
    setTop(marker == HomeMath.TOP)
    val to = HomeMath.targetFor(targets, marker)
    // (QA `freeze on,mid`: the column stops half way to the row — Home.tsx toRow does the same)
    if (!to.isNaN()) slideTo(if (AuroraQa.mid) to / 2 else to)
    dispatchRowFocus(marker)
  }

  /** The nearest marked ancestor of `v` below this view (the wrapper Home.tsx tagged). */
  private fun markerAbove(v: View): Int {
    var cur: View? = v
    while (cur != null && cur !== this) {
      val m = HomeMath.markerOf(cur.getTag(R.id.view_tag_native_id) as? String)
      if (m != HomeMath.NONE) return m
      cur = cur.parent as? View
    }
    return HomeMath.NONE
  }

  private fun setTop(next: Boolean) {
    if (next == atTop) return
    atTop = next
    link?.publishTop(next)
  }

  /** `Animated.spring(ty, {toValue, speed: 12, bounciness: 0}).start()` — always a new driver. */
  private fun slideTo(to: Double) {
    spring = AuroraSpring(RowMath.SLIDE_STIFFNESS, RowMath.SLIDE_DAMPING, 1.0, to, 0.0, 0.001, 0.001, false)
    AuroraClock.add(driver)
  }

  private fun apply() {
    translationY = PixelUtil.toPixelFromDIP(value.toFloat())
    cull?.moved()
  }

  // ---- LAB experiment `cull` (Cull.kt): the hero block and the shelves wholly off screen are not drawn
  private val cull: Cull? = if (AuroraExp.on("cull")) Cull(this, vertical = true) else null

  override fun dispatchDraw(canvas: Canvas) {
    cull?.beginDraw()
    super.dispatchDraw(canvas)
  }

  override fun drawChild(canvas: Canvas, child: View, drawingTime: Long): Boolean {
    if (cull?.hidden(child) == true) return false
    return super.drawChild(canvas, child, drawingTime)
  }

  private fun dispatchRowFocus(index: Int) {
    val ctx = context as? ReactContext ?: return
    try {
      UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
        ?.dispatchEvent(ColumnRowFocusEvent(UIManagerHelper.getSurfaceId(ctx), id, index))
    } catch (_: Throwable) {}
  }

  // ---- lifecycle -----------------------------------------------------------------------

  private fun stop() {
    spring = null
    AuroraClock.remove(driver)
  }

  /** Fabric is about to hand this view to another node: a fresh column rests at 0, at the top. */
  fun resetForRecycle() {
    stop()
    dropLink()
    value = 0.0
    translationY = 0f
    atTop = true
    targets = DoubleArray(0)
  }

  fun onDropped() {
    stop()
    dropLink()
  }

  companion object {
    /** PROTOCOL.md §4: the column's translateY, dp. The JS column traces the same id. */
    const val TRACE_ID = "hero.ty"
  }
}
