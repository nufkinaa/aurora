package com.auroratv.ui.view

import android.content.Context
import android.graphics.Canvas
import android.view.View
import android.view.ViewTreeObserver
import com.auroratv.ui.pool.PoolMath
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.view.ReactViewGroup

/**
 * "AuroraGrid" — the body of a recycling grid (P6; src/specs/AuroraGridNativeComponent.ts,
 * src/components/NativeGrid.tsx, docs/qa/native-bench/POOL-PLAN.md).
 *
 * It stands inside the ScrollView's content, where the FlatList's rows stood, and is a plain
 * ReactViewGroup: Yoga places the card slots (absolute, `col * colPitch`, `row * rowPitch`),
 * nothing is clipped. Its children are the slots React mounted ONCE; when the mounted rows
 * move, JS rebinds the slots that fell out (new props, a new position) and Fabric neither
 * adds nor removes a child here. This class never looks inside a slot.
 *
 * What it owns:
 *
 *  - THE FOCUS EVENT. [requestChildFocus] — called on every ancestor while Android is moving
 *    focus — reads the direct child's laid-out edges, names the card ([PoolMath.gridIndexOf])
 *    and tells JS once (`onItemFocus {index}`, the shelf's own event class). The ScrollView
 *    above hears the same call and scrolls; this view moves nothing.
 *
 *  - THE PAINT ORDER. Slots are children in slot order, items are not: the view paints its
 *    children by position (top, then left), which is the order a FlatList's rows and cells
 *    are painted in — so a lit card's shadow lies over the cards before it and under the
 *    ones after, as it always did ([PoolHost]).
 *
 *  - WHAT IS NOT DRAWN. The pool keeps eight rows mounted and the viewport shows fewer than
 *    three. The FlatList detached the rest (`removeClippedSubviews`); here they stay
 *    attached — so they can take focus and be rebound — and are left out of the display
 *    list instead ([Cull], the `cull` experiment's class, always on for a grid). A scroll is
 *    a property of the ScrollView, not a re-record of this view, so the view listens for it
 *    and re-records its child list only when the SET of hidden rows changed.
 *
 *  - THE MOUNT COUNT, `[pool] … grid …` lines while the QA focus log is on ([PoolHost]).
 */
class AuroraGridView(context: Context) : ReactViewGroup(context) {

  // ---- props (AuroraGridManager) ---------------------------------------------------------
  var cols = 1
  var colPitch = 0.0
  var rowPitch = 0.0
  var count = 0

  /** The card that last gained focus in this grid, -1 before the first. */
  var focusedIndex = -1
    private set

  private val slots = PoolHost(this, "grid")
  private val cull = Cull(this, vertical = true)
  private val onScroll = ViewTreeObserver.OnScrollChangedListener { cull.moved() }
  private var listening = false

  init {
    isChildrenDrawingOrderEnabled = true
  }

  // ---- focus → JS ------------------------------------------------------------------------

  /** Android is moving focus onto `focused`, somewhere under our direct child `child`. */
  override fun requestChildFocus(child: View, focused: View) {
    super.requestChildFocus(child, focused)
    if (colPitch <= 0 || rowPitch <= 0) return
    // The cell's laid-out edges (Yoga: col * colPitch, row * rowPitch, in px). A flattened
    // cell hands us the card itself, on the same edges — gridIndexOf rounds either way.
    val leftDp = PixelUtil.toDIPFromPixel(child.left.toFloat()).toDouble()
    val topDp = PixelUtil.toDIPFromPixel(child.top.toFloat()).toDouble()
    val index = PoolMath.gridIndexOf(leftDp, topDp, colPitch, rowPitch, cols, count)
    focusedIndex = index
    dispatchItemFocus(index)
    slots.pressed(index)
  }

  private fun dispatchItemFocus(index: Int) {
    val ctx = context as? ReactContext ?: return
    try {
      UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
        ?.dispatchEvent(RowItemFocusEvent(UIManagerHelper.getSurfaceId(ctx), id, index))
    } catch (_: Throwable) {}
  }

  // ---- drawing ---------------------------------------------------------------------------

  override fun getChildDrawingOrder(childCount: Int, drawingPosition: Int): Int = slots.order(childCount, drawingPosition)

  override fun dispatchDraw(canvas: Canvas) {
    slots.beginDraw()
    cull.beginDraw()
    super.dispatchDraw(canvas)
  }

  override fun drawChild(canvas: Canvas, child: View, drawingTime: Long): Boolean {
    if (cull.hidden(child)) return false
    return super.drawChild(canvas, child, drawingTime)
  }

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    slots.childAdded()
  }

  override fun onViewRemoved(child: View) {
    super.onViewRemoved(child)
    slots.childRemoved()
  }

  // ---- lifecycle -------------------------------------------------------------------------

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!listening) {
      viewTreeObserver.addOnScrollChangedListener(onScroll)
      listening = true
    }
  }

  override fun onDetachedFromWindow() {
    if (listening) {
      viewTreeObserver.removeOnScrollChangedListener(onScroll)
      listening = false
    }
    super.onDetachedFromWindow()
  }

  /** Fabric is about to hand this view to another node. */
  fun resetForRecycle() {
    focusedIndex = -1
    cols = 1
    colPitch = 0.0
    rowPitch = 0.0
    count = 0
  }
}
