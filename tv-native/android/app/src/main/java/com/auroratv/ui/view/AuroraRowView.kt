package com.auroratv.ui.view

import android.content.Context
import android.view.View
import com.auroratv.ui.anim.AuroraClock
import com.auroratv.ui.anim.AuroraDriver
import com.auroratv.ui.anim.AuroraSpring
import com.auroratv.ui.row.RowMath
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.view.ReactViewGroup

/**
 * "AuroraRow" — the shelf's sliding track (P3; src/specs/AuroraRowNativeComponent.ts).
 *
 * It stands where Row.tsx's `Animated.View` stands and is the same kind of view (a
 * ReactViewGroup: Yoga places the children, nothing is clipped), so the picture at rest
 * is the JS row's. Its children are whatever React mounts — the slots with JS or native
 * cards; this class never looks inside them.
 *
 * What moved here is the slide's whole input path. In the JS row a key press goes
 *   Android moves focus → topFocus event → JS thread → Card.onFocus → Row.focusCard →
 *   Animated.spring(...).start() → NativeAnimatedModule's queue → the driver's first frame,
 * so the shelf starts as many frames late as the JS thread is busy. Here
 * [requestChildFocus] — which Android calls on every ancestor, synchronously, while it is
 * moving focus — starts the driver itself. JS hears about it afterwards ([RowItemFocusEvent]).
 *
 * The motion is Row.tsx's: target `-max(0, (index - lead) * step)` dp ([RowMath.slideTarget]),
 * spring `{speed: 12, bounciness: 0}` through RN's own conversion, RN's native
 * SpringAnimation ([AuroraSpring]) stepped from the same Choreographer phase
 * ([AuroraClock]). A focus change while it is moving replaces the driver, which starts
 * from the value the last frame drew with velocity 0 — what `Animated.spring` on a
 * native-driven value does (AuroraSpring's header) — never from the previous target.
 *
 * The value is kept in dp as a double, like the animated node's, and applied the way
 * BaseViewManager.setTransformProperty applies a decomposed translateX:
 * `translationX = PixelUtil.toPixelFromDIP(value as float)`, unrounded.
 */
class AuroraRowView(context: Context) : ReactViewGroup(context) {

  // ---- props (AuroraRowManager) --------------------------------------------------------
  var step = 0.0
  var lead = RowMath.LEAD
  var contentLeft = 84.0
  var count = 0
  var initialIndex = 0

  // ---- state ---------------------------------------------------------------------------
  /** translateX in dp — the animated node's value. */
  private var value = 0.0
  private var spring: AuroraSpring? = null
  /** The card that last gained focus in this shelf, -1 before the first. */
  var focusedIndex = -1
    private set
  /** `initialIndex` has been consumed (or a focus overtook it). */
  private var placed = false

  private val driver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = spring ?: return true
      value = d.step(frameTimeNanos, value)
      apply()
      AuroraClock.trace(frameTimeNanos, TRACE_ID, value)
      if (d.finished) spring = null
      return d.finished
    }
  }

  /** After a props transaction: place the shelf on `initialIndex` once, without animation. */
  fun applyProps() {
    if (placed) return
    placed = true
    if (initialIndex > 0 && step > 0) {
      value = RowMath.slideTarget(initialIndex, step, lead)
      apply()
    }
  }

  // ---- focus → slide -------------------------------------------------------------------

  /**
   * Android is moving focus onto `focused`, somewhere under our direct child `child`. This
   * runs inside the framework's focus change, before the frame that draws the new ring.
   */
  override fun requestChildFocus(child: View, focused: View) {
    super.requestChildFocus(child, focused)
    if (step <= 0) return
    // The slot's laid-out left edge (Yoga: contentLeft + index * step, in px). A flattened
    // slot hands us the card itself, a few dp off at most — indexOfLeft rounds.
    val leftDp = PixelUtil.toDIPFromPixel(child.left.toFloat()).toDouble()
    val index = RowMath.indexOfLeft(leftDp, contentLeft, step, count)
    focusedIndex = index
    placed = true
    slideTo(RowMath.slideTarget(index, step, lead))
    dispatchItemFocus(index)
  }

  /**
   * `Animated.spring(value, {toValue, speed: 12, bounciness: 0}).start()`: always a new
   * driver, even toward the value it already rests at (RN starts one too; it finishes on
   * its first frame), picking the value up where the last frame left it.
   */
  private fun slideTo(to: Double) {
    spring = AuroraSpring(RowMath.SLIDE_STIFFNESS, RowMath.SLIDE_DAMPING, 1.0, to, 0.0, 0.001, 0.001, false)
    AuroraClock.add(driver)
  }

  private fun apply() {
    translationX = PixelUtil.toPixelFromDIP(value.toFloat())
  }

  private fun dispatchItemFocus(index: Int) {
    val ctx = context as? ReactContext ?: return
    try {
      UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
        ?.dispatchEvent(RowItemFocusEvent(UIManagerHelper.getSurfaceId(ctx), id, index))
    } catch (_: Throwable) {}
  }

  // ---- lifecycle -----------------------------------------------------------------------

  private fun stop() {
    spring = null
    AuroraClock.remove(driver)
  }

  /** Fabric is about to hand this view to another node: a fresh shelf rests at 0. */
  fun resetForRecycle() {
    stop()
    value = 0.0
    translationX = 0f
    focusedIndex = -1
    placed = false
    step = 0.0
    lead = RowMath.LEAD
    contentLeft = 84.0
    count = 0
    initialIndex = 0
  }

  fun onDropped() = stop()

  companion object {
    /** PROTOCOL.md §4: the shelf's translateX, dp. The JS row traces the same id. */
    const val TRACE_ID = "row.tx"
  }
}
