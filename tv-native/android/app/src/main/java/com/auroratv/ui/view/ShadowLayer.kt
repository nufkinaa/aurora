package com.auroratv.ui.view

import android.content.Context
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.LengthPercentage
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.style.BorderRadiusProp
import com.facebook.react.views.view.ReactViewGroup
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max

/**
 * LAB experiment `shadowcache` (AuroraExp.kt; docs/qa/native-bench/RENDER.md).
 *
 * WHY. React Native paints `box-shadow` with `OutsetBoxShadowDrawable`: a `clipOutPath` and a
 * `drawPath` through a `BlurMaskFilter`, re-issued on EVERY frame the view is on screen. On
 * the Mi TV that is render-thread time per shadow per frame even when nothing about the
 * shadow changes (a lit card sliding, the Play button sitting on the billboard).
 *
 * WHAT. The shadow gets a view of its own — this host — big enough to hold the whole blur,
 * with ONE child the size of the element that carries RN's own shadow drawable (same code,
 * same numbers, same pixels). The host is a hardware layer, so HWUI runs that drawable once
 * and afterwards composites a single textured quad; the fade of a focus ring becomes the
 * layer's alpha instead of a re-blur per step. No layer is held while the shadow is
 * invisible.
 */
internal class ShadowLayer(context: Context) : ReactViewGroup(context) {
  private val inner = ReactViewGroup(context)
  private var extent = 0

  init {
    isFocusable = false
    isClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    inner.isFocusable = false
    inner.isClickable = false
    inner.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(inner)
  }

  /** `shadows`: the array RN's `boxShadow` setter receives (dp); `radius`: the element's corner radius. */
  fun set(shadows: ReadableArray, radius: LengthPercentage?) {
    BackgroundStyleApplicator.setBorderRadius(inner, BorderRadiusProp.BORDER_RADIUS, radius)
    BackgroundStyleApplicator.setBoxShadow(inner, shadows)
    extent = extentPx(shadows)
  }

  /** The element's rect in the parent's coordinates (px): the host reaches `extent` past it on every side. */
  fun place(l: Int, t: Int, r: Int, b: Int) {
    layout(l - extent, t - extent, r + extent, b + extent)
    inner.layout(extent, extent, extent + (r - l), extent + (b - t))
  }

  /** The shadow's opacity (a ring's fade value, or 1 for a permanent shadow). */
  fun show(opacity: Float) {
    val want = if (opacity > 0f) LAYER_TYPE_HARDWARE else LAYER_TYPE_NONE
    if (layerType != want) setLayerType(want, null)
    setOpacityIfPossible(opacity)
  }

  companion object {
    /**
     * How far a list of outset shadows can reach past the box, in px: |offset| + spread + the
     * blur's support. CSS blur B is a Gaussian of sigma B/2, drawn out to 3 sigma = 1.5 B;
     * 2 B and 2 px more are taken so the layer can never cut it.
     */
    fun extentPx(shadows: ReadableArray): Int {
      var dp = 0.0
      for (i in 0 until shadows.size()) {
        val m = shadows.getMap(i) ?: continue
        if (m.hasKey("inset") && m.getBoolean("inset")) continue
        val ox = if (m.hasKey("offsetX")) abs(m.getDouble("offsetX")) else 0.0
        val oy = if (m.hasKey("offsetY")) abs(m.getDouble("offsetY")) else 0.0
        val blur = if (m.hasKey("blurRadius")) m.getDouble("blurRadius") else 0.0
        val spread = if (m.hasKey("spreadDistance")) max(0.0, m.getDouble("spreadDistance")) else 0.0
        dp = max(dp, max(ox, oy) + spread + 2.0 * blur)
      }
      return ceil(PixelUtil.toPixelFromDIP(dp.toFloat()).toDouble()).toInt() + 2
    }
  }
}
