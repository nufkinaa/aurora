package com.auroratv.ui.view

import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewTreeObserver
import android.widget.TextView
import com.facebook.react.views.view.ReactViewGroup

/**
 * render switch `herotext` (AuroraRender.kt; docs/qa/native-deep/DEVICE-PLAN.md §herotext):
 * Home's billboard words in one hardware layer while they are drawn whole.
 *
 * WHY. The lockup's four Texts carry blurred text shadows (kicker r 6, title r 16, facts and
 * synopsis r 8). Text with a shadow layer is re-blurred by the RenderThread on every frame the
 * words are on screen — and the hero is on screen, still, under every Home frame while the
 * shelves move below it and while a trailer plays behind it.
 *
 * WHAT. A hardware layer holds the words while the layer would be drawn 1:1 and opaque: this
 * view's and every ancestor's alpha is 1 and scale is 1 (checked before each frame,
 * ViewTreeObserver.OnPreDrawListener; a dozen parents, no allocation). Then they are rendered
 * once per change of text and composited as a quad. The moment that stops being true — the
 * slide's crossfade (`swap` animates the lockup's opacity), the app canvas scaled for another
 * panel (src/canvas.tsx) — the layer is dropped and every frame is drawn exactly as without
 * the switch (no group-opacity difference mid-fade, no stretched layer). Nothing can be drawn
 * outside this view: TextView clips each Text's shadow to its own box, and the four boxes lie
 * inside this column.
 *
 * React Native resets the layer type at the end of every props transaction
 * (BaseViewManager.onAfterUpdateTransaction), the cardlayer lesson; the manager calls [sync]
 * after it, and [sync] compares the REAL layer type.
 */
class AuroraTextLayerView(context: Context) : ReactViewGroup(context) {

  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    sync()
    true
  }
  private var observer: ViewTreeObserver? = null

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    observer = viewTreeObserver.also { it.addOnPreDrawListener(preDraw) }
    sync()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    observer?.let { if (it.isAlive) it.removeOnPreDrawListener(preDraw) }
    observer = null
    if (layerType != LAYER_TYPE_NONE) setLayerType(LAYER_TYPE_NONE, null)
  }

  fun sync() {
    val want = ON && isAttachedToWindow && drawnWhole()
    if (want != (layerType == LAYER_TYPE_HARDWARE)) setLayerType(if (want) LAYER_TYPE_HARDWARE else LAYER_TYPE_NONE, null)
  }

  private fun drawnWhole(): Boolean {
    if (width <= 0 || height <= 0 || visibility != VISIBLE) return false
    var v: View? = this
    while (v != null) {
      if (v.alpha != 1f || v.scaleX != 1f || v.scaleY != 1f) return false
      v = v.parent as? View
    }
    return true
  }

  /**
   * THE FAINT BOX BEHIND THE TITLE. A TextView clips its own drawing to its text box
   * (TextView.onDraw → clipRect, the horizontal padding excluded), widened only by the
   * TextView's OWN shadow layer; React Native draws `textShadow*` through a span
   * (ShadowStyleSpan), which TextView does not know about — so the title's 16 dp shadow
   * was cut off at the edges of the text box, a faintly darker rectangle behind the words,
   * plain on a scaled canvas (Mi TV at density 160, 2026-10-18) and there, fainter, at 1:1.
   * Each Text in here is given a TRANSPARENT shadow layer of [SHADOW_ROOM_DP]: it draws
   * nothing (Skia skips a fully transparent paint) and widens the clip to hold the span's
   * shadow (the Texts are also overflow 'visible' — RN's Text clips to its box by default).
   * The JS side gives this view the same room around the words (Home.tsx HeroWords,
   * padding with an equal negative margin), so the hardware layer does not cut it either.
   */
  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    if (child is TextView) {
      val r = SHADOW_ROOM_DP * resources.displayMetrics.density
      child.setShadowLayer(r, 0f, 0f, Color.TRANSPARENT)
    }
  }

  fun resetForRecycle() {
    if (layerType != LAYER_TYPE_NONE) setLayerType(LAYER_TYPE_NONE, null)
  }

  companion object {
    /** In step with Home.tsx HERO_SHADOW_ROOM (the title's shadow: radius 16, offset 2). */
    const val SHADOW_ROOM_DP = 20f
    private val ON = com.auroratv.ui.AuroraRender.on("herotext")
  }
}
