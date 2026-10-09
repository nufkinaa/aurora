package com.auroratv.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.view.View
import com.auroratv.R
import com.auroratv.ui.anim.AuroraClock
import com.auroratv.ui.anim.AuroraDriver
import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.anim.Interpolation
import com.auroratv.ui.home.ColumnLink
import com.auroratv.ui.home.HomeMath
import com.auroratv.ui.image.AuroraBitmaps
import com.auroratv.ui.image.AuroraImages
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.drawee.drawable.ScalingUtils
import com.facebook.drawee.generic.GenericDraweeHierarchy
import com.facebook.drawee.view.DraweeHolder
import com.facebook.react.views.view.ReactViewGroup

/**
 * "AuroraHeroArt" — Home's billboard art stack (P4; src/specs/AuroraHeroArtNativeComponent.ts).
 *
 * It stands where Home.tsx's `HeroArt` root view (`styles.artLayer`, the window's height)
 * stands, and also carries what the `artFade` wrapper around it carried. One view draws what
 * were five (Home.tsx:148-168), in the same order:
 *
 *   1. the REST art     `<Image resizeMode="cover" blurRadius fadeDuration={260}>`
 *   2. the SCROLLED art `<Animated.Image … fadeDuration={0}>`, opacity `1 - atTop`
 *   3. the React children — the trailer layer, still an RN subtree, so the picture moves
 *      UNDER the two scrims exactly as before
 *   4. the dim          black, opacity `atTop` [0, 1] → [SCROLLED.dim, REST.dim]
 *   5. hero-scrim.png   stretched over the whole view
 *
 * PICTURES. Each art layer is a Fresco `DraweeHolder` with the request and the hierarchy
 * React Native's own `<Image>` builds for the same source ([AuroraImages]: the URL Home.tsx
 * resolved — `?w=1280&blur=1|2` when the server blurs — with its `X-Session` / `X-Profile`
 * headers, no resize, the on-box blur post-processor only when `blurRadius` > 0), so the
 * bitmap is the one the JS billboard has in the cache. The rest layer keeps
 * `fadeDuration 260`: when the billboard rotates, the new address replaces the controller
 * and Fresco's own FadeDrawable brings the picture in, as it does for the `<Image>` — that
 * fade is not re-timed here (it is Fresco's clock in both implementations).
 *
 * `atTop` — the 280 ms `bezier(0.2, 0.7, 0.2, 1)` timing Home.tsx's `setTop` starts — runs
 * here ([AuroraTiming]), started by the column's focus change through the [ColumnLink]:
 * no JS between the key and the first frame.
 *
 * THE FADE WITH THE SCROLL. `artFade.opacity = ty.interpolate([-round(heroH*0.9),
 * -round(heroH*0.3), 0] → [0, 1, 1], clamp)`: the two stops arrive as props, the offset
 * from the link on every spring step, and the result is this view's `alpha`.
 *
 * ALPHA, EXACTLY. None of the JS views involved has overlapping rendering (ReactViewGroup,
 * ReactImageView), so HWUI never composites them as a group: each view's alpha is multiplied
 * into each drawing op, truncated to 8 bits, innermost view first. This view is a
 * ReactViewGroup too, so its own `alpha` (the scroll fade) is applied by HWUI the same way
 * to every op below; and the two inner alphas — the scrolled picture's and the dim's — are
 * set on the paints as HWUI would have left them ([Interpolation.alpha8]).
 */
class AuroraHeroArtView(context: Context) : ReactViewGroup(context), ColumnLink.Listener {

  // ---- props (AuroraHeroArtManager) --------------------------------------------------------
  var restUri = ""
  var restHeadersJson = ""
  var restBlur = 0f
  var scrolledUri = ""
  var scrolledHeadersJson = ""
  var scrolledBlur = 0f
  var restDim = 0.45
  var scrolledDim = 0.42
  var fadeOutAt = 0.0
  var fadeInAt = 0.0
  var linkProp = ""

  // ---- applied -----------------------------------------------------------------------------
  private var appliedRest: String? = null
  private var appliedScrolled: String? = null
  private var linkKey = ""
  private var link: ColumnLink? = null

  private val restHolder: DraweeHolder<GenericDraweeHierarchy> =
    DraweeHolder.create(AuroraImages.hierarchy(context, ScalingUtils.ScaleType.CENTER_CROP, HomeMath.REST_FADE_MS), context)
  private val scrolledHolder: DraweeHolder<GenericDraweeHierarchy> =
    DraweeHolder.create(AuroraImages.hierarchy(context, ScalingUtils.ScaleType.CENTER_CROP, 0), context)

  // ---- atTop -------------------------------------------------------------------------------
  private var atTopValue = 1.0
  private var atTopTarget = true
  private var timing: AuroraTiming? = null
  private val driver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = timing ?: return true
      atTopValue = d.step(frameTimeNanos, atTopValue)
      invalidate()
      AuroraClock.trace(frameTimeNanos, TRACE_AT_TOP, atTopValue)
      if (d.finished) timing = null
      return d.finished
    }
  }

  private var offset = 0.0
  private val rect = RectF()
  private val dimPaint = Paint().apply { color = 0xFF000000.toInt() }
  private var attachedToWindow = false

  init {
    isFocusable = false
    isClickable = false
    restHolder.topLevelDrawable?.callback = this
    scrolledHolder.topLevelDrawable?.callback = this
  }

  // =========================================================================================
  // Props
  // =========================================================================================

  fun applyProps() {
    val rest = "$restUri\n$restHeadersJson\n$restBlur"
    if (rest != appliedRest) {
      appliedRest = rest
      submit(restHolder, restUri, restHeadersJson, restBlur)
    }
    val scrolled = "$scrolledUri\n$scrolledHeadersJson\n$scrolledBlur"
    if (scrolled != appliedScrolled) {
      appliedScrolled = scrolled
      submit(scrolledHolder, scrolledUri, scrolledHeadersJson, scrolledBlur)
    }
    if (linkProp != linkKey) {
      dropLink()
      linkKey = linkProp
      if (linkKey.isNotEmpty()) {
        link = ColumnLink.acquire(linkKey).also {
          it.add(this)
          // join where the column is: no animation for a state that is already there
          offset = it.offset
          placeTop(it.atTop)
        }
      }
    }
    applyFade()
    invalidate()
  }

  /** `ReactImageView.maybeUpdateViewFromRequest`: a new controller on the same hierarchy, the old one handed over. */
  private fun submit(holder: DraweeHolder<GenericDraweeHierarchy>, uri: String, headersJson: String, blurDp: Float) {
    if (uri.isEmpty()) {
      holder.controller = null
      return
    }
    val req = AuroraImages.request(AuroraImages.uriOf(context, uri), AuroraImages.headersOf(headersJson), null, blurDp)
    holder.controller =
      Fresco.newDraweeControllerBuilder()
        .setImageRequest(req)
        .setAutoPlayAnimations(true)
        .setOldController(holder.controller)
        .build()
  }

  private fun dropLink() {
    link?.remove(this)
    if (linkKey.isNotEmpty()) ColumnLink.release(linkKey)
    link = null
    linkKey = ""
  }

  // =========================================================================================
  // The column
  // =========================================================================================

  override fun onColumnOffset(frameTimeNanos: Long, offset: Double) {
    this.offset = offset
    val a = applyFade()
    if (frameTimeNanos != 0L) AuroraClock.trace(frameTimeNanos, TRACE_ART, a)
  }

  /** Home.tsx setTop: `if (next === isTop.current) return;` then the 280 ms timing toward 1 / 0. */
  override fun onColumnTop(atTop: Boolean) {
    if (atTop == atTopTarget) return
    atTopTarget = atTop
    timing = AuroraTiming(HomeMath.AT_TOP_FRAMES, if (atTop) 1.0 else 0.0)
    AuroraClock.add(driver)
  }

  private fun placeTop(atTop: Boolean) {
    timing = null
    AuroraClock.remove(driver)
    atTopTarget = atTop
    atTopValue = if (atTop) 1.0 else 0.0
  }

  private fun applyFade(): Double {
    val a = if (fadeOutAt < fadeInAt && fadeInAt <= 0.0) HomeMath.artFade(offset, fadeOutAt, fadeInAt) else 1.0
    val f = a.toFloat()
    if (alpha != f) alpha = f
    return a
  }

  // =========================================================================================
  // Drawing: art → scrolled art → children → dim → scrim
  // =========================================================================================

  override fun dispatchDraw(canvas: Canvas) {
    val w = width
    val h = height
    if (w > 0 && h > 0) {
      if (restUri.isNotEmpty()) {
        restHolder.topLevelDrawable?.let { d ->
          d.setBounds(0, 0, w, h)
          d.draw(canvas)
        }
      }
      if (scrolledUri.isNotEmpty()) {
        val a = Interpolation.alpha8(HomeMath.scrolledAlpha(atTopValue))
        if (a > 0) {
          scrolledHolder.topLevelDrawable?.let { d ->
            d.setBounds(0, 0, w, h)
            d.alpha = a
            d.draw(canvas)
          }
        }
      }
    }
    super.dispatchDraw(canvas)
    if (w > 0 && h > 0) {
      rect.set(0f, 0f, w.toFloat(), h.toFloat())
      dimPaint.alpha = Interpolation.alpha8(HomeMath.dim(atTopValue, scrolledDim, restDim))
      canvas.drawRect(rect, dimPaint)
      AuroraBitmaps.raw(context, R.drawable.aurora_hero_scrim)?.let { bmp ->
        canvas.drawBitmap(bmp, null, rect, AuroraImages.BITMAP_PAINT)
      }
    }
  }

  // =========================================================================================
  // DraweeHolder plumbing (what DraweeView does)
  // =========================================================================================

  override fun verifyDrawable(who: Drawable): Boolean =
    who === restHolder.topLevelDrawable || who === scrolledHolder.topLevelDrawable || super.verifyDrawable(who)

  override fun invalidateDrawable(drawable: Drawable) {
    if (drawable === restHolder.topLevelDrawable || drawable === scrolledHolder.topLevelDrawable) invalidate()
    else super.invalidateDrawable(drawable)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attachedToWindow = true
    syncAttach()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    attachedToWindow = false
    syncAttach()
  }

  override fun onStartTemporaryDetach() {
    super.onStartTemporaryDetach()
    attachedToWindow = false
    syncAttach()
  }

  override fun onFinishTemporaryDetach() {
    super.onFinishTemporaryDetach()
    attachedToWindow = true
    syncAttach()
  }

  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    syncAttach()
  }

  /** DraweeView's legacy visibility handling (ReactImageView.init: setLegacyVisibilityHandlingEnabled(true)). */
  private fun syncAttach() {
    if (attachedToWindow && isShown) {
      restHolder.onAttach()
      scrolledHolder.onAttach()
    } else {
      restHolder.onDetach()
      scrolledHolder.onDetach()
    }
  }

  // =========================================================================================
  // Lifecycle
  // =========================================================================================

  /** Fabric view recycling: nothing of the old node may survive. */
  fun resetForRecycle() {
    release()
    restUri = ""; restHeadersJson = ""; restBlur = 0f
    scrolledUri = ""; scrolledHeadersJson = ""; scrolledBlur = 0f
    restDim = 0.45; scrolledDim = 0.42; fadeOutAt = 0.0; fadeInAt = 0.0; linkProp = ""
    appliedRest = null; appliedScrolled = null
    offset = 0.0
    atTopValue = 1.0
    atTopTarget = true
    alpha = 1f
  }

  fun onDropped() = release()

  private fun release() {
    timing = null
    AuroraClock.remove(driver)
    dropLink()
    restHolder.controller = null
    scrolledHolder.controller = null
  }

  companion object {
    /** PROTOCOL.md §4. The JS billboard traces the same ids. */
    const val TRACE_AT_TOP = "hero.atTop"
    const val TRACE_ART = "hero.art"
  }
}
