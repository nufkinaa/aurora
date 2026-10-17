package com.auroratv.ui.view

import android.content.Context
import android.view.View
import android.view.ViewTreeObserver
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

  fun resetForRecycle() {
    if (layerType != LAYER_TYPE_NONE) setLayerType(LAYER_TYPE_NONE, null)
  }

  companion object {
    private val ON = com.auroratv.ui.AuroraRender.on("herotext")
  }
}
