package com.auroratv.ui.view

import android.content.Context
import android.graphics.Rect
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import com.auroratv.ui.anim.AuroraClock
import com.auroratv.ui.anim.AuroraDriver
import com.auroratv.ui.anim.AuroraSpring
import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Bezier
import com.auroratv.ui.focus.AuroraFocusFacts
import com.auroratv.ui.focus.AuroraRingRegistry
import com.auroratv.ui.qa.AuroraQa
import com.facebook.react.R
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.LengthPercentage
import com.facebook.react.uimanager.LengthPercentageType
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.style.BorderRadiusProp
import com.facebook.react.uimanager.style.LogicalEdge
import com.facebook.react.views.view.ReactViewGroup

/**
 * The native Focusable (P1): src/components/Focusable.tsx's JS body, in Kotlin, with every
 * number from docs/native-rewrite/10a-spec-focusable-chip-btn-icon.md §1.
 *
 * It EXTENDS ReactViewGroup, so Yoga positions its React children, the border/background
 * props draw as on any RN View, and the TV focus plumbing (trapFocus*, autoFocus,
 * requestTVFocus, nextFocusLeft, FocusFinder) is inherited verbatim (01-architecture.md
 * §1.3, §5.2). What this class adds:
 *
 *  - the decorations the JS draws as Animated.Views — highlight wash (under the children),
 *    ring, or the `light` gap + ring (over them) — as ReactViewGroups it creates itself and
 *    styles through RN's own BackgroundStyleApplicator (same BorderDrawable /
 *    OutsetBoxShadowDrawable code, same dp→px, same pixels), laid out at the rects Yoga
 *    would give them (inset 0 / −3 dp / −7 dp, half-up pixel rounding, §8 of 01);
 *  - the two animated values: `ring` (opacity of the decorations and of the `focusOverlay`
 *    child; timing 160 ms, bezier 0.2,0.7,0.2,1) and `spring` (scale + lift; tension 180,
 *    friction 14, restDisplacement 0.001), driven by the ports of RN's drivers in ui/anim
 *    from the same ReactChoreographer phase — no JS in the loop;
 *  - focus: claim the one lit ring, note the facts, emit one `onFocusChange` event;
 *  - OK: press on release, long-press at 500 ms (Pressability's DEFAULT_LONG_PRESS_DELAY_MS);
 *  - `hasTVPreferredFocus` honoured once, with the 600 ms / first-focus disarm done here.
 *
 * The React children are untouched (text stays RN Text). The manager keeps the React child
 * indices separate from the decorations (see AuroraFocusableManager.addView & co).
 */
class AuroraFocusableView(context: Context) : ReactViewGroup(context) {

  // ---- props (set by the manager; applied in applyProps after a transaction) -------------
  var ringKind = "white"
  var ringWidth = 3.0
  var ringColor: Int? = null
  var ringRadius = 12.0
  var shadowOffsetX = 0.0
  var shadowOffsetY = 10.0
  var shadowBlur = 24.0
  var shadowSpread = 0.0
  var shadowColor: Int? = null
  var light = false
  var lightRingColor: Int? = null
  var lightGapColor: Int? = null
  var highlightColor: Int? = null
  var scaleTo = 1.055
  var noScale = false
  var lift = 0.0
  var edgeLeft = false
  var edgeRight = false
  var hasPress = true
  var hasLongPress = false
  var holdLeft = false
    set(v) {
      field = v
      nextFocusLeftId = if (v) id else View.NO_ID
    }
  var focusDisabled = false
    set(v) {
      field = v
      isFocusable = !v
      descendantFocusability = if (v) FOCUS_BLOCK_DESCENDANTS else FOCUS_BEFORE_DESCENDANTS
    }

  // ---- decorations ---------------------------------------------------------------------
  private var highlight: ReactViewGroup? = null
  private var ring: ReactViewGroup? = null
  private var gap: ReactViewGroup? = null
  private var lightRing: ReactViewGroup? = null
  /** The `focusOverlay` child (nativeID "aurora:overlay"); its alpha rides the ring value. */
  private var overlay: View? = null
  /** How many of the children are React's (the manager maintains it). */
  var rnChildCount = 0

  // ---- animation state -----------------------------------------------------------------
  private var ringValue = 0.0
  private var springValue = 0.0
  private var timing: AuroraTiming? = null
  private var spring: AuroraSpring? = null
  private val ringDriver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = timing ?: return true
      ringValue = d.step(frameTimeNanos, ringValue)
      applyRing()
      AuroraClock.trace(frameTimeNanos, traceId("ring"), ringValue)
      if (d.finished) timing = null
      return d.finished
    }
  }
  private val springDriver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = spring ?: return true
      springValue = d.step(frameTimeNanos, springValue)
      applySpring()
      AuroraClock.trace(frameTimeNanos, traceId("spring"), springValue)
      if (d.finished) spring = null
      return d.finished
    }
  }

  // ---- press / preferred focus ---------------------------------------------------------
  private val main = Handler(Looper.getMainLooper())
  private var pressed = false
  private var longSent = false
  private val longPressRunnable = Runnable {
    if (!pressed) return@Runnable
    longSent = true
    dispatch(PressEvent(surfaceId(), id, long = true))
  }
  private var preferredArmed = false
  private var preferredDisarmed = false
  private val disarmRunnable = Runnable { preferredDisarmed = true }

  init {
    isFocusable = true
    descendantFocusability = FOCUS_BEFORE_DESCENDANTS
    // RN Views do not clip (10-spec §8): the light ring and the shadow draw outside the box.
    clipChildren = false
    clipToPadding = false
  }

  // =====================================================================================
  // Props → decorations
  // =====================================================================================

  /** Called by the manager after every props transaction (and on first mount). */
  fun applyProps() {
    // highlight wash, under the children
    val hc = highlightColor
    if (hc != null) {
      val h = highlight ?: newDecoration().also {
        highlight = it
        super.addView(it, 0)
      }
      BackgroundStyleApplicator.setBackgroundColor(h, hc)
      BackgroundStyleApplicator.setBorderRadius(h, BorderRadiusProp.BORDER_RADIUS, dp(ringRadius))
    } else {
      highlight?.let { super.removeView(it) }
      highlight = null
    }

    if (light) {
      ring?.let { super.removeView(it) }
      ring = null
      val g = gap ?: newDecoration().also {
        gap = it
        super.addView(it)
      }
      BackgroundStyleApplicator.setBorderWidth(g, LogicalEdge.ALL, LIGHT_GAP.toFloat())
      BackgroundStyleApplicator.setBorderColor(g, LogicalEdge.ALL, lightGapColor ?: BG_COLOR)
      BackgroundStyleApplicator.setBorderRadius(g, BorderRadiusProp.BORDER_RADIUS, dp(ringRadius + LIGHT_GAP))
      val lr = lightRing ?: newDecoration().also {
        lightRing = it
        super.addView(it)
      }
      BackgroundStyleApplicator.setBorderWidth(lr, LogicalEdge.ALL, LIGHT_RING.toFloat())
      BackgroundStyleApplicator.setBorderColor(lr, LogicalEdge.ALL, lightRingColor ?: ringColor ?: FOCUS_RING_COLOR)
      BackgroundStyleApplicator.setBorderRadius(lr, BorderRadiusProp.BORDER_RADIUS, dp(ringRadius + LIGHT_GAP + LIGHT_RING))
      BackgroundStyleApplicator.setBoxShadow(lr, shadowArray(0.0, 10.0, 24.0, 0.0, TOKEN_SHADOW_COLOR))
    } else {
      gap?.let { super.removeView(it) }
      gap = null
      lightRing?.let { super.removeView(it) }
      lightRing = null
      if (ringKind == "none") {
        ring?.let { super.removeView(it) }
        ring = null
      } else {
        val r = ring ?: newDecoration().also {
          ring = it
          super.addView(it)
        }
        BackgroundStyleApplicator.setBorderWidth(r, LogicalEdge.ALL, ringWidth.toFloat())
        BackgroundStyleApplicator.setBorderColor(r, LogicalEdge.ALL, ringColor ?: FOCUS_RING_COLOR)
        BackgroundStyleApplicator.setBorderRadius(r, BorderRadiusProp.BORDER_RADIUS, dp(ringRadius))
        BackgroundStyleApplicator.setBoxShadow(r, shadowArray(shadowOffsetX, shadowOffsetY, shadowBlur, shadowSpread, shadowColor ?: TOKEN_SHADOW_COLOR))
      }
    }
    layoutDecorations()
    applyRing()
    applySpring()
  }

  private fun newDecoration(): ReactViewGroup =
    ReactViewGroup(context).apply {
      isFocusable = false
      isClickable = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      setOpacityIfPossible(ringValue.toFloat())
    }

  private fun dp(v: Double) = LengthPercentage(v.toFloat(), LengthPercentageType.POINT)

  /** The map RN's own `boxShadow` prop setter receives (processBoxShadow's output, in dp). */
  private fun shadowArray(ox: Double, oy: Double, blur: Double, spread: Double, color: Int): com.facebook.react.bridge.ReadableArray {
    val m: WritableMap = Arguments.createMap()
    m.putDouble("offsetX", ox)
    m.putDouble("offsetY", oy)
    m.putDouble("blurRadius", blur)
    m.putDouble("spreadDistance", spread)
    m.putInt("color", color)
    m.putBoolean("inset", false)
    return Arguments.createArray().apply { pushMap(m) }
  }

  /** `rnOffset`: how many decorations sit BEFORE the React children. */
  fun rnOffset() = if (highlight != null) 1 else 0

  /** Remove every React child (manager's removeAllViews), keeping the decorations. */
  fun removeRnChildren() {
    val off = rnOffset()
    while (rnChildCount > 0) {
      super.removeViewAt(off)
      rnChildCount--
    }
  }

  // =====================================================================================
  // Layout: Yoga lays out the React children (ReactViewGroup.onLayout is a no-op); the
  // decorations are positioned here at the rects Yoga would compute for the JS views
  // (01 §8: dp → px by half-up rounding on the scaled value, from this view's own edge).
  // =====================================================================================

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    super.onLayout(changed, l, t, r, b)
    layoutDecorations()
  }

  /**
   * The JS decorations are `position: absolute` children, and Yoga resolves an absolute
   * child's insets against the parent's PADDING box — inside its border. So "inset 0" is
   * not the element's edge: on a Btn/Chip (the 3 dp reserved border of styles.base) the
   * ring sits 3 dp in, the light gap exactly covers the reserved border and the light ring
   * starts at the element's edge; on a Card (borderWidth 1) the ring sits 1 dp in.
   */
  private fun layoutDecorations() {
    val w = width
    val h = height
    if (w == 0 && h == 0) return
    val bl = borderPx(LogicalEdge.LEFT, LogicalEdge.START, LogicalEdge.HORIZONTAL)
    val br = borderPx(LogicalEdge.RIGHT, LogicalEdge.END, LogicalEdge.HORIZONTAL)
    val bt = borderPx(LogicalEdge.TOP, LogicalEdge.BLOCK_START, LogicalEdge.VERTICAL)
    val bb = borderPx(LogicalEdge.BOTTOM, LogicalEdge.BLOCK_END, LogicalEdge.VERTICAL)
    val l = bl
    val t = bt
    val r = w - br
    val b = h - bb
    highlight?.layout(l, t, r, b)
    ring?.layout(l, t, r, b)
    val g = px(LIGHT_GAP)
    gap?.layout(l - g, t - g, r + g, b + g)
    val lr = px(LIGHT_GAP + LIGHT_RING)
    lightRing?.layout(l - lr, t - lr, r + lr, b + lr)
  }

  /** This view's own border width on one edge, in px (the style's, as RN resolved it). */
  private fun borderPx(vararg edges: LogicalEdge): Int {
    for (e in edges) {
      val v = BackgroundStyleApplicator.getBorderWidth(this, e)
      if (v != null) return px(v.toDouble())
    }
    val all = BackgroundStyleApplicator.getBorderWidth(this, LogicalEdge.ALL) ?: return 0
    return px(all.toDouble())
  }

  /** Yoga's roundValueToPixelGrid for a non-negative inset: half-up on the scaled value. */
  private fun px(dp: Double): Int {
    val scaled = PixelUtil.toPixelFromDIP(dp.toFloat()).toDouble()
    return Math.floor(scaled + 0.5).toInt()
  }

  // =====================================================================================
  // The React children: the focusOverlay child is found by its nativeID.
  // =====================================================================================

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    if (child.getTag(R.id.view_tag_native_id) == OVERLAY_ID) {
      overlay = child
      setAlpha(child, ringValue)
    }
  }

  override fun onViewRemoved(child: View) {
    super.onViewRemoved(child)
    if (child === overlay) overlay = null
  }

  // =====================================================================================
  // Animations
  // =====================================================================================

  private fun applyRing() {
    val v = ringValue
    highlight?.setOpacityIfPossible(v.toFloat())
    ring?.setOpacityIfPossible(v.toFloat())
    gap?.setOpacityIfPossible(v.toFloat())
    lightRing?.setOpacityIfPossible(v.toFloat())
    overlay?.let { setAlpha(it, v) }
  }

  private fun setAlpha(v: View, a: Double) {
    if (v is ReactViewGroup) v.setOpacityIfPossible(a.toFloat()) else v.alpha = a.toFloat()
  }

  /**
   * transform: [{scale}, {translateY}] with scale = spring interpolated [0,1,2] → [1, s, 2s−1]
   * and translateY = [0,1,2] → [0, −lift, −2·lift] (Focusable.tsx:286-295). RN composes the
   * list in CSS order (TransformHelper → MatrixMathHelper.multiplyInto, column-major), so the
   * translation is in the SCALED space: the decomposed matrix carries translateY · scale, and
   * BaseViewManager.setTransformProperty hands the view scaleX/Y = s and
   * translationY = toPixelFromDIP(s · ty). Same here, without the matrix round trip.
   */
  private fun applySpring() {
    if (noScale) return
    val v = springValue
    val s = interpolate(v, SPRING_IN, doubleArrayOf(1.0, scaleTo, scaleTo * 2 - 1))
    val sf = s.toFloat()
    scaleX = sf
    scaleY = sf
    if (lift != 0.0) {
      val ty = interpolate(v, SPRING_IN, doubleArrayOf(0.0, -lift, -lift * 2))
      translationY = PixelUtil.toPixelFromDIP((s * ty).toFloat())
    } else if (translationY != 0f) {
      translationY = 0f
    }
  }

  private fun startRing(to: Double) {
    // like Animated.timing on a running value: the old driver is dropped, the node keeps
    // its value, the new driver starts from it on its first frame
    timing = AuroraTiming(RING_FRAMES, to)
    AuroraClock.add(ringDriver)
  }

  private fun startSpring(to: Double) {
    spring = AuroraSpring(SPRING_STIFFNESS, SPRING_DAMPING, 1.0, to, 0.0, 0.001, 0.001, false)
    AuroraClock.add(springDriver)
  }

  private var headingLit = false

  private fun toLit() {
    headingLit = true
    startRing(1.0)
    startSpring(1.0)
  }

  private fun toDark() {
    headingLit = false
    startRing(0.0)
    startSpring(0.0)
  }

  /** Another ring was claimed: fade out (Focusable.tsx:240-254). Fades, never snaps. */
  fun ringLostToClaim() = toDark()

  /** The `clearRing` command. */
  fun clearRingFromJS() {
    AuroraRingRegistry.release(this)
    toDark()
  }

  private fun stopAnimations() {
    timing = null
    spring = null
    AuroraClock.remove(ringDriver)
    AuroraClock.remove(springDriver)
  }

  // =====================================================================================
  // Focus
  // =====================================================================================

  /** BaseViewManager installs a focus listener that sends topFocus/topBlur to JS; the
   *  native Focusable replaces those with one `onFocusChange` and does not pay for them. */
  override fun setOnFocusChangeListener(l: OnFocusChangeListener?) {
    if (l != null && l.javaClass.name.endsWith("BaseVMFocusChangeListener")) return
    super.setOnFocusChangeListener(l)
  }

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    if (gainFocus) {
      AuroraRingRegistry.claim(this, context as? ReactContext)
      AuroraFocusFacts.note(this, edgeLeft, edgeRight)
      toLit()
      if (preferredArmed) disarmPreferred()
    } else {
      AuroraRingRegistry.release(this)
      AuroraFocusFacts.lost(this)
      toDark()
      cancelPress()
    }
    AuroraQa.logFocus(gainFocus, qaTag(), "native", edgeLeft, edgeRight)
    dispatch(FocusChangeEvent(surfaceId(), id, gainFocus, edgeLeft, edgeRight))
  }

  /**
   * hasTVPreferredFocus (ReactViewManager.setTVPreferredFocus: focusable + requestFocus) —
   * honoured the first time it is true, then disarmed on first focus or after 600 ms, so a
   * Fabric prop re-apply can never yank focus back (react-native-tvos#670; Focusable.tsx:265-276).
   */
  fun setPreferredFocus(wants: Boolean) {
    hasTVPreferredFocus = wants
    if (!wants || preferredArmed || preferredDisarmed) return
    preferredArmed = true
    isFocusable = !focusDisabled
    isFocusableInTouchMode = true
    requestFocus()
    main.postDelayed(disarmRunnable, PREFERRED_DISARM_MS)
  }

  private fun disarmPreferred() {
    preferredDisarmed = true
    main.removeCallbacks(disarmRunnable)
  }

  // =====================================================================================
  // OK / ENTER: Pressability's TV contract (10-spec §4.5). Key-down starts the 500 ms
  // long-press timer; key-up presses unless the long press fired. Handled here instead of
  // through topPressIn/topPressOut round-trips.
  // =====================================================================================

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (isConfirm(keyCode)) {
      if (event.repeatCount == 0) {
        pressed = true
        longSent = false
        main.removeCallbacks(longPressRunnable)
        if (hasLongPress) main.postDelayed(longPressRunnable, LONG_PRESS_MS)
      }
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (isConfirm(keyCode)) {
      val wasPressed = pressed
      cancelPress()
      if (wasPressed && !longSent && hasPress) {
        try {
          (context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.playSoundEffect(AudioManager.FX_KEY_CLICK)
        } catch (_: Throwable) {}
        dispatch(PressEvent(surfaceId(), id, long = false))
      }
      return true
    }
    return super.onKeyUp(keyCode, event)
  }

  private fun isConfirm(keyCode: Int) = keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER

  private fun cancelPress() {
    pressed = false
    main.removeCallbacks(longPressRunnable)
  }

  // =====================================================================================
  // Lifecycle
  // =====================================================================================

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    AuroraRingRegistry.release(this)
    AuroraFocusFacts.lost(this)
    cancelPress()
  }

  /** Fabric view recycling: nothing of the old node may survive. */
  fun resetForRecycle() {
    stopAnimations()
    cancelPress()
    main.removeCallbacks(disarmRunnable)
    AuroraRingRegistry.release(this)
    AuroraFocusFacts.lost(this)
    ringValue = 0.0
    springValue = 0.0
    headingLit = false
    scaleX = 1f
    scaleY = 1f
    translationY = 0f
    // ReactViewGroup.recycleView removes every child; forget ours
    highlight = null
    ring = null
    gap = null
    lightRing = null
    overlay = null
    rnChildCount = 0
    preferredArmed = false
    preferredDisarmed = false
    ringKind = "white"; ringWidth = 3.0; ringColor = null; ringRadius = 12.0
    shadowOffsetX = 0.0; shadowOffsetY = 10.0; shadowBlur = 24.0; shadowSpread = 0.0; shadowColor = null
    light = false; lightRingColor = null; lightGapColor = null; highlightColor = null
    scaleTo = 1.055; noScale = false; lift = 0.0; edgeLeft = false; edgeRight = false
    hasPress = true; hasLongPress = false; holdLeft = false; focusDisabled = false
  }

  fun onDropped() {
    stopAnimations()
    cancelPress()
    main.removeCallbacks(disarmRunnable)
    AuroraRingRegistry.release(this)
    AuroraFocusFacts.lost(this)
  }

  // =====================================================================================
  // Events / QA
  // =====================================================================================

  private fun surfaceId() = UIManagerHelper.getSurfaceId(context)

  private fun dispatch(ev: com.facebook.react.uimanager.events.Event<*>) {
    val ctx = context as? ReactContext ?: return
    try {
      UIManagerHelper.getEventDispatcherForReactTag(ctx, id)?.dispatchEvent(ev)
    } catch (_: Throwable) {}
  }

  fun qaTag(): String = AuroraQa.tagOf(this)

  /** `focus.ring` / `focus.spring` while heading to lit, `….out` while heading to dark —
   *  the same ids the JS Focusable logs (Focusable.tsx), so A and B are comparable. */
  private fun traceId(prop: String): String = if (headingLit) "focus.$prop" else "focus.$prop.out"

  companion object {
    const val OVERLAY_ID = "aurora:overlay"
    // Focusable.tsx:48-49 — LIGHT_GAP 3, LIGHT_RING = focus.borderWidth + 1 = 4
    const val LIGHT_GAP = 3.0
    const val LIGHT_RING = 4.0
    // theme.ts colors.bg "#0b0c14", colors.focusRing rgba(255,255,255,0.95) → processColor
    const val BG_COLOR = 0xFF0B0C14.toInt()
    const val FOCUS_RING_COLOR = 0xF2FFFFFF.toInt()
    // '0 10px 24px rgba(0,0,0,0.5)' — the colour as processColor makes it (alpha 128)
    const val TOKEN_SHADOW_COLOR = 0x80000000.toInt()
    // Pressability DEFAULT_LONG_PRESS_DELAY_MS; Focusable.tsx:272-276
    const val LONG_PRESS_MS = 500L
    const val PREFERRED_DISARM_MS = 600L
    // theme.focus: duration 160, ease [0.2,0.7,0.2,1]; spring tension 180 / friction 14
    private val RING_EASE = Bezier(0.2, 0.7, 0.2, 1.0)
    val RING_FRAMES: DoubleArray = AuroraTiming.sample(160.0) { RING_EASE.ease(it) }
    val SPRING_STIFFNESS = AuroraSpring.stiffnessFromOrigamiValue(180.0) // 737
    val SPRING_DAMPING = AuroraSpring.dampingFromOrigamiValue(14.0) // 43
    private val SPRING_IN = doubleArrayOf(0.0, 1.0, 2.0)

    /** InterpolationAnimatedNode with extrapolate "extend" on both sides. */
    fun interpolate(value: Double, inputRange: DoubleArray, outputRange: DoubleArray): Double {
      var index = 1
      while (index < inputRange.size - 1) {
        if (inputRange[index] >= value) break
        index++
      }
      val i = index - 1
      val inputMin = inputRange[i]
      val inputMax = inputRange[i + 1]
      val outputMin = outputRange[i]
      val outputMax = outputRange[i + 1]
      if (outputMin == outputMax) return outputMin
      if (inputMin == inputMax) return if (value <= inputMin) outputMin else outputMax
      return outputMin + (outputMax - outputMin) * (value - inputMin) / (inputMax - inputMin)
    }
  }
}
