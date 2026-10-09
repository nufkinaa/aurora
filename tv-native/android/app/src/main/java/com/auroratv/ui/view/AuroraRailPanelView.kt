package com.auroratv.ui.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Shader
import com.auroratv.R
import com.auroratv.ui.anim.AuroraClock
import com.auroratv.ui.anim.AuroraDriver
import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Interpolation
import com.auroratv.ui.image.AuroraBitmaps
import com.auroratv.ui.qa.AuroraQa
import com.auroratv.ui.rail.RailLink
import com.auroratv.ui.rail.RailMath
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.view.ReactViewGroup

/**
 * "AuroraRailPanel" — the nav rail's drawing and its slide (P5;
 * src/specs/AuroraRailPanelNativeComponent.ts). One component, mounted twice by NavRail.tsx,
 * exactly where its two `Animated.View`s stand:
 *
 * `part="strip"` — the collapsed strip (`styles.strip`, always mounted). It draws the scrim
 *   (NavRail.tsx `Scrim`: an SVG rect filled #080910 0.9 → 0, left to right) under its React
 *   children — the mark and the dots, still RN — and it OWNS `slide`: the 280 ms
 *   `bezier(0.2, 0.7, 0.2, 1)` timing NavRail.tsx ran on an Animated.Value now runs here
 *   ([AuroraTiming]) from the `open` / `closing` props:
 *     open && !closing  → toward 1      (the `[open]` effect)
 *     closing           → toward 0, then `onSlideEnd {open: false}` (close()'s callback)
 *     !open             → 0 at once     (instantClose's `slide.setValue(0)`)
 *   Its own opacity is `1 - slide`.
 *
 * `part="panel"` — the open panel (`styles.panel`, mounted only while the rail is open). It
 *   follows the strip's `slide` through the [RailLink] — `translateX` [-288, 0] dp — and
 *   draws, under its React children (the focus guide with the items, still RN):
 *     1. the body        #0a0b14 + linear-gradient(165deg, …), 240 dp wide          (panelBody)
 *     2. the body again  at opacity `slide`, with the two moving glows clipped to it
 *                        and the edge ramp over them                    (panelBody + RailHues)
 *     3. the feather     an SVG rect, #0a0b14 1 → 0.55 @0.45 → 0, 48 dp     (panelFeather)
 *   and runs the hue loops: `a` 8 s and `b` 10.5 s each way on `Easing.inOut(Easing.sin)`,
 *   not started when `lite`, held at phase 0.37 under the QA freeze (qa.ts runLoop).
 *
 * The rail's KEY LOGIC is not here: opening, closing, wrapping, traps, focus restore and
 * arm-to-switch stay in NavRail.tsx (00-plan.md P5); the items are its `Focusable`s.
 *
 * DRAWN AS THE JS DRAWS IT.
 *  - The SVG gradients: react-native-svg rasterises into a software bitmap the size of the
 *    view with an `android.graphics.LinearGradient` in objectBoundingBox units and paints
 *    that bitmap. So does [gradientRow] — one software row (the ramp is horizontal, so
 *    every row is the same), stretched down the view.
 *  - The CSS gradients: React Native's own gradient line ([RailMath.gradientLine]) on an
 *    anti-aliased fill paint, as BackgroundImageDrawable draws a single tile.
 *  - Alpha: no view involved has overlapping rendering, so HWUI multiplies each view's
 *    alpha into each op, truncating to 8 bits, innermost first ([Interpolation.alpha8]):
 *    a glow is `floor(floor(255 * opacity) * slide)`, the second body `floor(255 * slide)`.
 *    The strip's own alpha is this view's `alpha` — HWUI applies it to the scrim and to the
 *    children exactly as it did for the Animated.View.
 *  - A glow: glow.png stretched over its 440 / 460 dp box, tinted SRC_IN, moved by
 *    translate then scale about the box's centre — the matrix RN's
 *    `[{translateX}, {translateY}, {scale}]` decomposes to.
 */
class AuroraRailPanelView(context: Context) : ReactViewGroup(context), RailLink.Listener {

  // ---- props (AuroraRailPanelManager) ------------------------------------------------------
  var part = PART_STRIP
  var linkProp = ""
  var open = false
  var closing = false
  var lite = false

  private var linkKey = ""
  private var link: RailLink? = null

  // ---- the slide (strip: owner; panel: follower) -------------------------------------------
  private var slide = 0.0
  private var phase = SHUT
  private var timing: AuroraTiming? = null
  private val slideDriver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = timing ?: return true
      slide = d.step(frameTimeNanos, slide)
      applySlide()
      link?.publish(frameTimeNanos, slide)
      AuroraClock.trace(frameTimeNanos, TRACE_SLIDE, slide)
      AuroraClock.trace(frameTimeNanos, TRACE_STRIP, RailMath.stripAlpha(slide))
      if (d.finished) {
        timing = null
        if (phase == CLOSING) dispatchSlideEnd(false)
      }
      return d.finished
    }
  }

  // ---- the hues (panel) --------------------------------------------------------------------
  private class Loop(val frames: DoubleArray) {
    var value = 0.0
    var timing: AuroraTiming? = null
    private var rising = true

    fun start() {
      value = 0.0
      rising = true
      timing = AuroraTiming(frames, 1.0)
    }

    /** `Animated.loop(Animated.sequence([timing → 1, timing → 0]))`: each leg a fresh timing. */
    fun step(frameTimeNanos: Long) {
      val d = timing ?: return
      value = d.step(frameTimeNanos, value)
      if (d.finished) {
        rising = !rising
        timing = AuroraTiming(frames, if (rising) 1.0 else 0.0)
      }
    }
  }

  private var huesStarted = false
  private var loopA: Loop? = null
  private var loopB: Loop? = null
  private var hueA = 0.0
  private var hueB = 0.0
  private val hueDriver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val a = loopA ?: return true
      val b = loopB ?: return true
      a.step(frameTimeNanos)
      b.step(frameTimeNanos)
      hueA = a.value
      hueB = b.value
      invalidate()
      return false
    }
  }

  // ---- drawing -----------------------------------------------------------------------------
  private val rect = RectF()
  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val gradientPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val rowPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val violetPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG).apply {
    colorFilter = PorterDuffColorFilter(RailMath.VIOLET_TINT, PorterDuff.Mode.SRC_IN)
  }
  private val greenPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG).apply {
    colorFilter = PorterDuffColorFilter(RailMath.GREEN_TINT, PorterDuff.Mode.SRC_IN)
  }
  private var row: Bitmap? = null
  private var rowW = 0
  private var bodyShaderW = 0
  private var bodyShaderH = 0
  private var edgeShaderW = 0

  // =========================================================================================
  // Props
  // =========================================================================================

  fun applyProps() {
    if (linkProp != linkKey) {
      dropLink()
      linkKey = linkProp
      if (linkKey.isNotEmpty()) {
        val l = RailLink.acquire(linkKey)
        link = l
        if (part == PART_PANEL) {
          l.add(this)
          slide = l.slide
        } else {
          l.publish(0L, slide)
        }
      }
    }
    if (part == PART_STRIP) applyOpen() else startHues()
    applySlide()
  }

  /** The three things NavRail.tsx did to `slide`. */
  private fun applyOpen() {
    when {
      !open -> {
        // instantClose (or the commit after a finished close): `slide.setValue(0)`
        phase = SHUT
        if (timing != null || slide != 0.0) {
          timing = null
          AuroraClock.remove(slideDriver)
          slide = 0.0
          link?.publish(0L, slide)
        }
      }
      closing -> if (phase != CLOSING) {
        phase = CLOSING
        animateTo(0.0)
      }
      else -> if (phase != OPEN) {
        phase = OPEN
        animateTo(1.0)
      }
    }
  }

  private fun animateTo(to: Double) {
    timing = AuroraTiming(RailMath.SLIDE_FRAMES, to)
    AuroraClock.add(slideDriver)
  }

  /** RailHues' effect: nothing when lite; held at 0.37 while frozen; else the two loops. */
  private fun startHues() {
    if (huesStarted) return
    huesStarted = true
    if (lite) return
    if (AuroraQa.frozen) {
      hueA = RailMath.FROZEN_PHASE
      hueB = RailMath.FROZEN_PHASE
      return
    }
    loopA = Loop(RailMath.HUE_A_FRAMES).also { it.start() }
    loopB = Loop(RailMath.HUE_B_FRAMES).also { it.start() }
    AuroraClock.add(hueDriver)
  }

  private fun dropLink() {
    link?.remove(this)
    if (linkKey.isNotEmpty()) RailLink.release(linkKey)
    link = null
    linkKey = ""
  }

  override fun onRailSlide(frameTimeNanos: Long, slide: Double) {
    this.slide = slide
    applySlide()
  }

  private fun applySlide() {
    if (part == PART_STRIP) {
      val a = RailMath.stripAlpha(slide).toFloat()
      if (alpha != a) alpha = a
    } else {
      translationX = PixelUtil.toPixelFromDIP(RailMath.panelTx(slide).toFloat())
      invalidate()
    }
  }

  private fun dispatchSlideEnd(open: Boolean) {
    val ctx = context as? ReactContext ?: return
    try {
      UIManagerHelper.getEventDispatcherForReactTag(ctx, id)
        ?.dispatchEvent(RailSlideEndEvent(UIManagerHelper.getSurfaceId(ctx), id, open))
    } catch (_: Throwable) {}
  }

  // =========================================================================================
  // Drawing — under the React children
  // =========================================================================================

  override fun dispatchDraw(canvas: Canvas) {
    val w = width
    val h = height
    if (w > 0 && h > 0) {
      if (part == PART_STRIP) drawStrip(canvas, w, h) else drawPanel(canvas, w, h)
    }
    super.dispatchDraw(canvas)
  }

  /** `<Scrim width={nav.rail} />`: the whole strip, #080910 0.9 → 0. */
  private fun drawStrip(canvas: Canvas, w: Int, h: Int) {
    val bmp = gradientRow(w, RailMath.SCRIM_COLORS, RailMath.SCRIM_STOPS) ?: return
    rect.set(0f, 0f, w.toFloat(), h.toFloat())
    canvas.drawBitmap(bmp, null, rect, rowPaint)
  }

  private fun drawPanel(canvas: Canvas, w: Int, h: Int) {
    val density = PixelUtil.toPixelFromDIP(1f).toDouble()
    val bodyW = minOf(w, RailMath.px(RailMath.RAIL_OPEN, density))
    val hf = h.toFloat()

    // ---- panelBody, twice: opaque, then again at `slide` with the hues inside it ----
    if (bodyShaderW != bodyW || bodyShaderH != h) {
      bodyShaderW = bodyW
      bodyShaderH = h
      val line = RailMath.gradientLine(RailMath.BODY_ANGLE, bodyW.toFloat(), hf)
      gradientPaint.shader =
        LinearGradient(line[0], line[1], line[2], line[3], RailMath.BODY_COLORS, RailMath.BODY_STOPS, Shader.TileMode.CLAMP)
    }
    val save = canvas.save()
    canvas.clipRect(0f, 0f, bodyW.toFloat(), hf) // overflow: 'hidden'
    fillPaint.color = RailMath.BODY_COLOR
    canvas.drawRect(0f, 0f, bodyW.toFloat(), hf, fillPaint)
    gradientPaint.alpha = 255
    canvas.drawRect(0f, 0f, bodyW.toFloat(), hf, gradientPaint)

    val over = Interpolation.alpha8(slide)
    if (over > 0) {
      fillPaint.alpha = over
      canvas.drawRect(0f, 0f, bodyW.toFloat(), hf, fillPaint)
      gradientPaint.alpha = over
      canvas.drawRect(0f, 0f, bodyW.toFloat(), hf, gradientPaint)
      drawHues(canvas, bodyW, h, density, over)
    }
    canvas.restoreToCount(save)

    // ---- the feather: the rest of the panel's width, beside the body ----
    val featherW = w - bodyW
    if (featherW > 0) {
      val bmp = gradientRow(featherW, RailMath.FEATHER_COLORS, RailMath.FEATHER_STOPS) ?: return
      rect.set(bodyW.toFloat(), 0f, w.toFloat(), hf)
      canvas.drawBitmap(bmp, null, rect, rowPaint)
    }
  }

  /** RailHues: the two glows, then `huesEdge` over them — all inside the second body's `slide` alpha. */
  private fun drawHues(canvas: Canvas, bodyW: Int, h: Int, density: Double, over: Int) {
    val glow = AuroraBitmaps.raw(context, R.drawable.aurora_glow)
    val heightDp = h / density
    if (glow != null) {
      val v = RailMath.violet(hueA, hueB)
      drawGlow(
        canvas, glow, violetPaint, v, over, density,
        RailMath.VIOLET_LEFT, RailMath.VIOLET_TOP, RailMath.VIOLET_SIZE,
      )
      val g = RailMath.green(hueA, hueB)
      drawGlow(
        canvas, glow, greenPaint, g, over, density,
        RailMath.GREEN_LEFT, heightDp - RailMath.GREEN_BOTTOM - RailMath.GREEN_SIZE, RailMath.GREEN_SIZE,
      )
    }
    // huesEdge: the right `round(railOpen * 0.5)` dp of the body, clear → the body's colour
    val edgeLeft = RailMath.px(RailMath.RAIL_OPEN - RailMath.EDGE, density)
    val edgeW = bodyW - edgeLeft
    if (edgeW > 0) {
      if (edgeShaderW != edgeW) {
        edgeShaderW = edgeW
        val line = RailMath.gradientLine(RailMath.EDGE_ANGLE, edgeW.toFloat(), h.toFloat())
        edgePaint.shader =
          LinearGradient(line[0], line[1], line[2], line[3], RailMath.EDGE_COLORS, RailMath.EDGE_STOPS, Shader.TileMode.CLAMP)
      }
      edgePaint.alpha = over
      val save = canvas.save()
      canvas.translate(edgeLeft.toFloat(), 0f)
      canvas.drawRect(0f, 0f, edgeW.toFloat(), h.toFloat(), edgePaint)
      canvas.restoreToCount(save)
    }
  }

  private fun drawGlow(
    canvas: Canvas, glow: Bitmap, paint: Paint, g: RailMath.Glow, over: Int, density: Double,
    leftDp: Double, topDp: Double, sizeDp: Double,
  ) {
    val alpha = Interpolation.alpha8(slide, Interpolation.alpha8(g.alpha))
    if (alpha <= 0 || over <= 0) return
    // the box Yoga lays the <Animated.Image> out in: each edge on the pixel grid
    rect.set(
      RailMath.px(leftDp, density).toFloat(),
      RailMath.px(topDp, density).toFloat(),
      RailMath.px(leftDp + sizeDp, density).toFloat(),
      RailMath.px(topDp + sizeDp, density).toFloat(),
    )
    paint.alpha = alpha
    val save = canvas.save()
    canvas.translate(PixelUtil.toPixelFromDIP(g.tx.toFloat()), PixelUtil.toPixelFromDIP(g.ty.toFloat()))
    canvas.scale(g.scale.toFloat(), g.scale.toFloat(), rect.centerX(), rect.centerY())
    canvas.drawBitmap(glow, null, rect, paint)
    canvas.restoreToCount(save)
  }

  /**
   * A horizontal SVG gradient `w` px wide as react-native-svg makes it: rasterised by the
   * software canvas into an ARGB_8888 bitmap (SvgView.drawOutput), the `<Rect>` filled with
   * `LinearGradient(0, 0, w, 0, colors, stops, CLAMP)` on an anti-aliased fill paint
   * (Brush.setupPaint, objectBoundingBox). One row: the ramp does not vary down the view.
   */
  private fun gradientRow(w: Int, colors: IntArray, stops: FloatArray): Bitmap? {
    row?.let { if (rowW == w && !it.isRecycled) return it }
    return try {
      val bmp = Bitmap.createBitmap(w, 1, Bitmap.Config.ARGB_8888)
      val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        shader = LinearGradient(0f, 0f, w.toFloat(), 0f, colors, stops, Shader.TileMode.CLAMP)
      }
      Canvas(bmp).drawRect(0f, 0f, w.toFloat(), 1f, p)
      row = bmp
      rowW = w
      bmp
    } catch (_: Throwable) {
      null
    }
  }

  // =========================================================================================
  // Lifecycle
  // =========================================================================================

  /** Fabric view recycling: nothing of the old node may survive. */
  fun resetForRecycle() {
    release()
    part = PART_STRIP; linkProp = ""; open = false; closing = false; lite = false
    slide = 0.0
    phase = SHUT
    huesStarted = false
    hueA = 0.0
    hueB = 0.0
    alpha = 1f
    translationX = 0f
    row = null
    rowW = 0
    bodyShaderW = 0
    bodyShaderH = 0
    edgeShaderW = 0
  }

  fun onDropped() = release()

  private fun release() {
    timing = null
    AuroraClock.remove(slideDriver)
    loopA = null
    loopB = null
    AuroraClock.remove(hueDriver)
    // a strip that goes away takes its panel's slide with it (the rail is gone)
    if (part == PART_STRIP && slide != 0.0) {
      slide = 0.0
      link?.publish(0L, 0.0)
    }
    dropLink()
  }

  companion object {
    const val PART_STRIP = "strip"
    const val PART_PANEL = "panel"

    /** PROTOCOL.md §4. The JS rail traces the same ids. */
    const val TRACE_SLIDE = "rail.slide"
    const val TRACE_STRIP = "rail.strip"

    private const val SHUT = 0
    private const val OPEN = 1
    private const val CLOSING = 2
  }
}
