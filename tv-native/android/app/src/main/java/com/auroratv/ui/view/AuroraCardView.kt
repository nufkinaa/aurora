package com.auroratv.ui.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.RenderNode
import android.graphics.Shader
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import com.auroratv.R
import com.auroratv.ui.AuroraRender
import com.auroratv.ui.anim.AuroraClock
import com.auroratv.ui.anim.AuroraDriver
import com.auroratv.ui.anim.AuroraTiming
import com.auroratv.ui.card.CardContent
import com.auroratv.ui.card.CardDecor
import com.auroratv.ui.card.CardGeometry
import com.auroratv.ui.card.CardImageLadder
import com.auroratv.ui.card.CardStamps
import com.auroratv.ui.card.CardImageLadder.Show
import com.auroratv.ui.image.AuroraImages
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.drawee.controller.BaseControllerListener
import com.facebook.drawee.drawable.ScalingUtils
import com.facebook.drawee.generic.GenericDraweeHierarchy
import com.facebook.drawee.view.DraweeHolder
import com.facebook.imagepipeline.common.ResizeOptions
import com.facebook.imagepipeline.image.ImageInfo
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.UIManagerHelper
import kotlin.math.roundToInt

/**
 * The native card's DRAWN layers (P2 of docs/native-rewrite/00-plan.md; 10c-spec-card-row.md).
 * Not a focusable and not a container: `Card.tsx`'s native wrapper mounts two instances of
 * this view inside the one `Focusable` the JS card also uses (P1's switch — the ring, scale,
 * lift, press, long-press and focus events are that component's, nothing is duplicated here):
 *
 *   the ART instance   absolute-fill child of the Focusable, under the RN Text/tag children:
 *                      blur-up placeholder → picture (Fresco, RN's own request) → titled tile
 *                      (the 160° gradient; its title text is an RN child) → the shade at rest
 *                      (card-shade-v / card-frame-shade);
 *   the FOCUS instance inside the Focusable's `focusOverlay` (alpha = the ring value, driven
 *                      by the Focusable): the brighten wash (white @0.055) and, on a card
 *                      with no permanent label, the poster shade.
 *
 * What stays RN and why (chosen for 1:1, 01-architecture.md §2.2 allowed either):
 *  - every Text (labels, frame label, fallback title, "NEW", "✕"): text is RN's Text;
 *  - the NEW pill and the kind pill: their size comes from the Text/Icon inside, so the View
 *    that pads it is the exact RN View of Card.tsx (same StyleSheet entries);
 *  - the progress bar: its gradient fill, glow and bead are RN's box-shadow / backgroundImage
 *    drawables, and it is painted ABOVE the label's text shadow (Card.tsx:448-454 is the last
 *    child), which a layer under the RN children could not reproduce. Three RN views, only on
 *    cards with progress (Continue Watching).
 *
 * Pictures: `AuroraImages` builds the request `ReactImageView` would (shared Fresco caches);
 * `DraweeHolder` per layer, attached with the window as `DraweeView` does. The failure ladder
 * (`CardImageLadder`, Card.tsx:173-245) runs here with the same numbers: 1.5 s → `r=1`, the
 * backup poster at once, then the tile and slow rounds 30 s / 120 s / 480 s, then parked until
 * JS sends `unpark` (the realtime `welcome`). JS hears `onImageLoaded` / `onImageFailed` /
 * `onImageRetry` (CardEvents.kt) and keeps its `markDrawn` / `trackError` / tile-title duties.
 *
 * `card.fade`: the picture's alpha rides an AuroraTiming of `fadeDuration` = 0 ms (every card
 * Image passes `fadeDuration={0}`), i.e. one driver step 0 → 1 on the frame after Fresco set
 * the image; `[anim] <t> card.fade 1.000000` while tracing. The blur layer is released when it
 * reaches 1 (Card.tsx removes the placeholder on `onLoad`; the picture covers it either way).
 *
 * Geometry: this view IS the card's padding box (absoluteFill inside the 1 dp border), so the
 * picture/blur clip is radius 11 dp (`radius.m − 1`, Card.tsx:471/474) at (0,0,w,h) and the
 * shades/tile/brighten radius 12 dp (:473/:503/:373) at the same rect — exactly the rects the
 * RN Images had. dp → px by `PixelUtil` (01 §8).
 */
class AuroraCardView(context: Context) : View(context) {

  // ---- props (set by the manager; applyProps() after each transaction) -------------------
  var uri = ""
  var headersJson = ""
  var sized = false
  var retryUri = ""
  var backupUri = ""
  var backupHeadersJson = ""
  var blurUri = ""
  /** "none" | "poster" | "frame" — which strip to draw over the picture. */
  var shade = "none"
  var brighten = false
  /** No picture at all (Card.tsx `!src`): the tile. */
  var tile = false

  // ---- render switch `cardtext` (Card.tsx DeepCard; ui/card/CardDecor.kt) ------------------
  // With a `decor` this one view also draws what Card.tsx otherwise mounts as RN views: the
  // label / the frame card's words, the NEW and kind pills, the progress bar, the tile's title
  // and (the focus instance) the ✕ — through React Native's own views used as stamps
  // (CardStamps.kt), recorded ONCE per content into a RenderNode shared by every card that
  // shows the same thing (DecorNodes below). Empty `decor` = the two-layer native card.
  var decorJson = ""
  var textMode = ""
  var t1 = ""
  var t2 = ""
  var t3 = ""
  var raised = false
  var tagNew = false
  var tagKind = ""
  var pct = -1
  var frameBar = false
  var tileTitle = ""
  var xGlyph = false
  private var content = CardContent()

  // ---- applied state -----------------------------------------------------------------------
  private var appliedUri: String? = null
  private var appliedRetry = ""
  private var appliedBackup = ""
  private var appliedHeaders = ""
  private var appliedBackupHeaders = ""
  private var appliedSized = false
  private var appliedBlur: String? = null
  private var headers: ReadableMap? = null
  private var backupHeaders: ReadableMap? = null

  private val pictureHolder: DraweeHolder<GenericDraweeHierarchy> =
    DraweeHolder.create(AuroraImages.hierarchy(context, ScalingUtils.ScaleType.CENTER_CROP, 0), context)
  private val blurHolder: DraweeHolder<GenericDraweeHierarchy> =
    DraweeHolder.create(AuroraImages.hierarchy(context, ScalingUtils.ScaleType.CENTER_CROP, 0), context)

  private var ladder = CardImageLadder(false)
  /** Monotonic token: a Fresco callback from a superseded request is ignored. */
  private var requestSeq = 0
  /** The address whose request waits for a layout pass (resize needs the view's px size). */
  private var deferredShow: Show? = null
  private var loaded = false
  private var blurShown = false

  private val main = Handler(Looper.getMainLooper())
  private var pending: Runnable? = null

  // ---- fade (card.fade) --------------------------------------------------------------------
  private var fadeValue = 0.0
  private var fade: AuroraTiming? = null
  private val fadeDriver = object : AuroraDriver {
    override fun step(frameTimeNanos: Long): Boolean {
      val d = fade ?: return true
      fadeValue = d.step(frameTimeNanos, fadeValue)
      invalidate()
      AuroraClock.trace(frameTimeNanos, TRACE_FADE, fadeValue)
      if (d.finished) {
        fade = null
        onFadeDone()
      }
      return d.finished
    }
  }

  // ---- drawing -----------------------------------------------------------------------------
  private val rect = RectF()
  private val brightenPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BRIGHTEN_COLOR }
  private val tilePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var tileShaderW = 0
  private var tileShaderH = 0
  private var attachedToWindow = false

  init {
    isFocusable = false
    isClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    pictureHolder.topLevelDrawable?.callback = this
    blurHolder.topLevelDrawable?.callback = this
  }

  // =========================================================================================
  // Props → requests
  // =========================================================================================

  fun applyProps() {
    if (headersJson != appliedHeaders) {
      appliedHeaders = headersJson
      headers = AuroraImages.headersOf(headersJson)
    }
    if (backupHeadersJson != appliedBackupHeaders) {
      appliedBackupHeaders = backupHeadersJson
      backupHeaders = AuroraImages.headersOf(backupHeadersJson)
    }
    val pictureChanged =
      uri != appliedUri || retryUri != appliedRetry || backupUri != appliedBackup || sized != appliedSized
    if (pictureChanged) {
      appliedUri = uri
      appliedRetry = retryUri
      appliedBackup = backupUri
      appliedSized = sized
      restartPicture()
    }
    if (blurUri != appliedBlur) {
      appliedBlur = blurUri
      submitBlur()
    }
    content = CardContent(textMode, t1, t2, t3, raised, tagNew, tagKind, pct, frameBar, tileTitle, xGlyph)
    invalidate()
  }

  /** A new address (Card.tsx keys `fail` by it): the ladder, the fade and the blur start over. */
  private fun restartPicture() {
    cancelPending()
    ladder = CardImageLadder(hasBackup = backupUri.isNotEmpty()).also { it.restart(uri) }
    loaded = false
    fadeValue = 0.0
    fade = null
    AuroraClock.remove(fadeDriver)
    blurShown = blurUri.isNotEmpty()
    if (blurShown && blurHolder.controller == null) submitBlur()
    submit()
  }

  private fun submitBlur() {
    if (blurUri.isEmpty() || loaded) {
      blurHolder.controller = null
      blurShown = false
      return
    }
    // `<Image source={{uri: blur}} blurRadius={1} resizeMode="cover" fadeDuration={0}>` (Card.tsx:344):
    // no headers, no resize (resizeMethod auto on a data: URI), the box blur at 1 dp / 2.
    val req = AuroraImages.request(AuroraImages.uriOf(context, blurUri), null, null, BLUR_RADIUS_DP)
    blurHolder.controller =
      Fresco.newDraweeControllerBuilder()
        .setImageRequest(req)
        .setAutoPlayAnimations(true)
        .setOldController(blurHolder.controller)
        .build()
    blurShown = true
  }

  /** (Re)submit the picture for the ladder's current address. */
  private fun submit() {
    deferredShow = null
    if (uri.isEmpty() || tile) {
      clearPicture()
      return
    }
    when (val show = ladder.show()) {
      Show.TILE -> clearPicture()
      Show.FIRST -> request(show, uri, headers, resize = !sized)
      Show.RETRY -> request(show, retryUri.ifEmpty { uri + (if (uri.contains('?')) "&" else "?") + "r=1" }, headers, resize = !sized)
      Show.BACKUP -> request(show, backupUri, backupHeaders, resize = false) // Card.tsx:357 — the backup is 'auto'
    }
  }

  private fun request(show: Show, address: String, hdrs: ReadableMap?, resize: Boolean) {
    // ReactImageView.maybeUpdateView:402-405 — a resize needs the view's size; wait for layout
    if (resize && (width <= 0 || height <= 0)) {
      deferredShow = show
      return
    }
    val resizeOptions = if (resize) ResizeOptions(width, height) else null
    val req = AuroraImages.request(AuroraImages.uriOf(context, address), hdrs, resizeOptions, 0f)
    val token = ++requestSeq
    val listener = object : BaseControllerListener<ImageInfo>() {
      override fun onFinalImageSet(id: String?, imageInfo: ImageInfo?, animatable: Animatable?) {
        if (token == requestSeq) {
          onPictureLoaded(address)
        }
      }

      override fun onFailure(id: String?, throwable: Throwable?) {
        if (token == requestSeq) onPictureFailed(address, throwable)
      }
    }
    pictureHolder.controller =
      Fresco.newDraweeControllerBuilder()
        .setImageRequest(req)
        .setAutoPlayAnimations(true)
        .setOldController(pictureHolder.controller)
        .setControllerListener(listener)
        .build()
  }

  /** No picture request at all (the tile, or no address): drop the controller, ignore late callbacks. */
  private fun clearPicture() {
    requestSeq++
    pictureHolder.controller = null
    invalidate()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w > 0 && h > 0 && deferredShow != null) submit()
  }

  // =========================================================================================
  // Fresco callbacks → the ladder → JS
  // =========================================================================================

  private fun onPictureLoaded(shown: String) {
    loaded = true
    // fadeDuration 0: one step to 1 on the next frame, traced as card.fade
    fade = AuroraTiming(FADE_FRAMES, 1.0)
    AuroraClock.add(fadeDriver)
    dispatch(CardImageEvent.loaded(surfaceId(), id, uri, shown))
  }

  private fun onFadeDone() {
    // Card.tsx:260-264 — the placeholder goes once the real picture has loaded
    blurHolder.controller = null
    blurShown = false
    invalidate()
  }

  private fun onPictureFailed(shown: String, t: Throwable?) {
    val step = ladder.fail()
    dispatch(
      CardImageEvent.failed(
        surfaceId(), id, uri, shown, t?.message ?: "", step.tries,
        tile = step.now == Show.TILE, parked = step.parked,
      )
    )
    if (step.now == Show.TILE) clearPicture()
    cancelPending()
    val then = step.then ?: return
    val r = Runnable {
      pending = null
      ladder.apply(step)
      if (then == Show.FIRST) dispatch(CardImageEvent.retry(surfaceId(), id, uri, step.round))
      submit()
      invalidate()
    }
    pending = r
    main.postDelayed(r, step.delayMs)
  }

  /** The `unpark` command (the realtime socket's `welcome`, Card.tsx:195-202). */
  fun unpark() {
    if (!ladder.parked) return
    cancelPending()
    ladder.unpark()
    submit()
    invalidate()
  }

  private fun cancelPending() {
    pending?.let { main.removeCallbacks(it) }
    pending = null
  }

  // =========================================================================================
  // Drawing
  // =========================================================================================

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width
    val h = height
    if (w <= 0 || h <= 0) return
    rect.set(0f, 0f, w.toFloat(), h.toFloat())
    val r11 = PixelUtil.toPixelFromDIP(PICTURE_RADIUS_DP)
    val r12 = PixelUtil.toPixelFromDIP(CARD_RADIUS_DP)
    // The tile is drawn only where JsCard draws it: no picture at all (`tile`, i.e. `!src`)
    // or the ladder gave up on one. NOT merely "no uri": the FOCUS instance has none (it
    // carries only brighten + shade) and painted the opaque tile over the art on focus.
    val showTile = tile || (uri.isNotEmpty() && ladder.show() == Show.TILE)
    val decor = if (decorJson.isEmpty()) null else CardDecor.of(decorJson)
    if (showTile) {
      drawTile(canvas, w, h, r12)
      // JsCard's tile: the gradient, then its title (fallbackCentre), then the shade over both
      if (decor != null && content.tileTitle.isNotEmpty()) drawDecor(canvas, decor, w, h, tileOnly = true)
    } else {
      if (blurShown) {
        blurHolder.topLevelDrawable?.let { d ->
          d.setBounds(0, 0, w, h)
          RoundClip.draw(this, canvas, rect, r11) { d.draw(canvas) }
        }
      }
      if (loaded && fadeValue > 0.0) {
        pictureHolder.topLevelDrawable?.let { d ->
          d.setBounds(0, 0, w, h)
          d.alpha = (fadeValue * 255).roundToInt().coerceIn(0, 255)
          RoundClip.draw(this, canvas, rect, r11) { d.draw(canvas) }
        }
      }
    }
    if (brighten) canvas.drawRoundRect(rect, r12, r12, brightenPaint)
    shadeBitmap(shade)?.let { bmp ->
      RoundClip.draw(this, canvas, rect, r12) { canvas.drawBitmap(bmp, null, rect, AuroraImages.BITMAP_PAINT) }
    }
    if (decor != null && content.hasDecor) drawDecor(canvas, decor, w, h, tileOnly = false)
  }

  // =========================================================================================
  // `cardtext`: the words, pills and bar — Card.tsx's RN children, in their paint order
  // =========================================================================================

  private fun drawDecor(canvas: Canvas, d: CardDecor, w: Int, h: Int, tileOnly: Boolean) {
    val rtl = layoutDirection == LAYOUT_DIRECTION_RTL
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && canvas.isHardwareAccelerated) {
      val key = DecorNodes.key(d, content, w, h, rtl, tileOnly)
      val node = DecorNodes.get(key) ?: DecorNodes.record(key, w, h) { c -> paintDecor(c, d, w, h, rtl, tileOnly) }
      canvas.drawRenderNode(node)
    } else {
      paintDecor(canvas, d, w, h, rtl, tileOnly)
    }
  }

  private fun paintDecor(canvas: Canvas, d: CardDecor, w: Int, h: Int, rtl: Boolean, tileOnly: Boolean) {
    val st = CardStamps.of(context, d)
    val s = PixelUtil.getDisplayMetricDensity().toDouble()
    val root = CardGeometry.root(w, h)
    val wdp = w / s
    val hdp = h / s
    val c = content
    if (tileOnly) {
      // `.card-fallback`: fallbackCentre fills the poster box, padding 10, the title centred (AT_MOST)
      val fb = d.fallbackCentre
      val sp = st.fallbackText.spannable(c.tileTitle)
      val m = st.fallbackText.measure(sp, CardGeometry.atMostPx(wdp - fb.pl - fb.pr, s), false, rtl)
      val n = CardGeometry.centred(root, 0.0, 0.0, wdp, hdp, fb.pl, m[0], m[1], s)
      st.fallbackText.draw(canvas, sp, n[1].box, rtl)
      return
    }
    // the label (`.card-label`), or the frame card's words
    if (c.mode == "label" || c.mode == "labelEp" || c.mode == "frame" || c.mode == "frameEp") {
      val frame = c.mode.startsWith("frame")
      val box = if (frame) d.frameLabel else if (c.raised) d.labelRaised else d.label
      val parts = ArrayList<Pair<CardStamps.TextStamp, String>>()
      when (c.mode) {
        "label" -> parts.add(st.labelText to c.t1)
        "labelEp" -> {
          parts.add(st.labelSub to c.t1)
          parts.add(st.labelText to c.t2)
        }
        else -> {
          parts.add(st.frameTitle to c.t1)
          if (c.mode == "frameEp") parts.add(st.frameSub to c.t2)
          if (c.t3.isNotEmpty()) parts.add(st.frameMeta to c.t3)
        }
      }
      val left = box.left ?: 0.0
      val right = box.right ?: 0.0
      val widthPx = ((wdp - left - right) * s).toFloat()
      val spans = parts.map { (stamp, text) -> stamp.spannable(text) }
      val lines = parts.mapIndexed { i, (stamp, _) -> CardGeometry.Line(stamp.measure(spans[i], widthPx, true, rtl)[1], stamp.st.marginTop) }
      val nodes = CardGeometry.stack(root, wdp, hdp, left, right, box.bottom ?: 0.0, lines, s)
      parts.forEachIndexed { i, (stamp, _) -> stamp.draw(canvas, spans[i], nodes[i + 1].box, rtl) }
    }
    // NEW (`.card-tag` + tagLeft + tagNew)
    if (c.tagNew) {
      val b = d.newPill
      val sp = st.newText.spannable("NEW")
      val avail = (b.maxWidth ?: wdp) - b.pl - b.pr - 2 * b.borderWidth
      val m = st.newText.measure(sp, CardGeometry.atMostPx(avail, s), false, rtl)
      val n = CardGeometry.pill(root, wdp, b.top ?: 0.0, b.left ?: 0.0, null, m[0] / s, m[1] / s, b.pt, b.pr, b.pb, b.pl, b.borderWidth, s)
      st.drawBox(canvas, "new", n[0].box)
      st.newText.draw(canvas, sp, n[1].box, rtl)
    }
    // the kind pill: an icon-only tag (P11) at the right
    if (c.tagKind == "film" || c.tagKind == "series") {
      val b = if (c.tagKind == "series") d.seriesPill else d.filmPill
      val n = CardGeometry.pill(root, wdp, b.top ?: 0.0, b.left, b.right ?: 0.0, d.iconSize, d.iconSize, b.pt, b.pr, b.pb, b.pl, b.borderWidth, s)
      st.drawBox(canvas, c.tagKind, n[0].box)
      st.drawIcon(canvas, c.tagKind, n[1].box)
    }
    // the progress bar, last (above the label's shadow, as Card.tsx paints it)
    if (c.pct >= 0) {
      val t = if (c.frameBar) d.progressFrame else d.progress
      val hd = d.progressHead
      val n = CardGeometry.progress(
        root, wdp, hdp, t.left ?: 0.0, t.right ?: 0.0, t.bottom ?: 0.0, t.height ?: 0.0,
        c.pct.coerceIn(0, 100), hd.right ?: 0.0, hd.top ?: 0.0, hd.width ?: 0.0, hd.height ?: 0.0, s,
      )
      st.drawProgress(canvas, c.frameBar, n.map { it.box })
    }
    // the ✕ of a removable card (the focus instance; `.card-remove`, its glyph centred)
    if (c.xGlyph) {
      val b = d.remove
      val bw = b.width ?: 30.0
      val bh = b.height ?: 30.0
      val sp = st.removeGlyph.spannable("✕")
      val m = st.removeGlyph.measure(sp, CardGeometry.atMostPx(bw, s), false, rtl)
      val n = CardGeometry.centred(root, wdp - (b.right ?: 0.0) - bw, b.top ?: 0.0, bw, bh, 0.0, m[0], m[1], s)
      st.drawBox(canvas, "remove", n[0].box)
      st.removeGlyph.draw(canvas, sp, n[1].box, rtl)
    }
  }

  /**
   * The recorded decor, shared: every card that shows the same words, tags and bar at the same
   * size draws ONE RenderNode (a shelf scrolled back and forth re-mounts the same titles). An
   * LRU of [MAX] entries; a RenderNode is a display list, and any number of parents may draw it.
   */
  @androidx.annotation.RequiresApi(Build.VERSION_CODES.Q)
  private object DecorNodes {
    private const val MAX = 96
    private val map =
      object : LinkedHashMap<String, RenderNode>(MAX, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, RenderNode>?): Boolean = size > MAX
      }

    fun key(d: CardDecor, c: CardContent, w: Int, h: Int, rtl: Boolean, tileOnly: Boolean): String {
      val fs = android.content.res.Resources.getSystem().configuration.fontScale
      val part = if (tileOnly) "tile|${c.tileTitle}" else c.copy(tileTitle = "").toString()
      return "${System.identityHashCode(d)}|$w|$h|$rtl|${PixelUtil.getDisplayMetricDensity()}|$fs|$part"
    }

    fun get(key: String): RenderNode? = map[key]

    val size: Int get() = map.size

    fun record(key: String, w: Int, h: Int, draw: (Canvas) -> Unit): RenderNode {
      val node = RenderNode("AuroraCardDecor")
      node.setPosition(0, 0, w, h)
      node.clipToBounds = false
      val rc = node.beginRecording(w, h)
      try {
        draw(rc)
      } finally {
        node.endRecording()
      }
      map[key] = node
      return node
    }
  }

  /** `.card-fallback` (Card.tsx:365-374): `<Rect rx=12>` filled by a LinearGradient (0,0)→(0.34,0.94) #1b1d31 → #101120. */
  private fun drawTile(canvas: Canvas, w: Int, h: Int, r12: Float) {
    if (tileShaderW != w || tileShaderH != h) {
      tileShaderW = w
      tileShaderH = h
      tilePaint.shader = LinearGradient(0f, 0f, 0.34f * w, 0.94f * h, TILE_FROM, TILE_TO, Shader.TileMode.CLAMP)
    }
    canvas.drawRoundRect(rect, r12, r12, tilePaint)
  }

  private fun shadeBitmap(kind: String): Bitmap? =
    when (kind) {
      "poster" -> Shades.get(context, R.drawable.aurora_card_shade_v)
      "frame" -> Shades.get(context, R.drawable.aurora_card_frame_shade)
      else -> null
    }

  // =========================================================================================
  // DraweeHolder plumbing (what DraweeView does)
  // =========================================================================================

  override fun verifyDrawable(who: Drawable): Boolean =
    who === pictureHolder.topLevelDrawable || who === blurHolder.topLevelDrawable || super.verifyDrawable(who)

  override fun invalidateDrawable(drawable: Drawable) {
    if (drawable === pictureHolder.topLevelDrawable || drawable === blurHolder.topLevelDrawable) invalidate()
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
      pictureHolder.onAttach()
      blurHolder.onAttach()
    } else {
      pictureHolder.onDetach()
      blurHolder.onDetach()
    }
  }

  // =========================================================================================
  // Lifecycle
  // =========================================================================================

  /** Fabric view recycling: nothing of the old node may survive. */
  fun resetForRecycle() {
    release()
    uri = ""; headersJson = ""; sized = false; retryUri = ""; backupUri = ""; backupHeadersJson = ""; blurUri = ""
    shade = "none"; brighten = false; tile = false
    decorJson = ""; textMode = ""; t1 = ""; t2 = ""; t3 = ""; raised = false; tagNew = false; tagKind = ""
    pct = -1; frameBar = false; tileTitle = ""; xGlyph = false; content = CardContent()
    appliedUri = null; appliedRetry = ""; appliedBackup = ""; appliedHeaders = ""; appliedBackupHeaders = ""
    appliedSized = false; appliedBlur = null; headers = null; backupHeaders = null
    ladder = CardImageLadder(false)
  }

  fun onDropped() = release()

  private fun release() {
    cancelPending()
    requestSeq++
    deferredShow = null
    fade = null
    AuroraClock.remove(fadeDriver)
    fadeValue = 0.0
    loaded = false
    blurShown = false
    pictureHolder.controller = null
    blurHolder.controller = null
  }

  // =========================================================================================
  // Events
  // =========================================================================================

  private fun surfaceId() = UIManagerHelper.getSurfaceId(context)

  private fun dispatch(ev: com.facebook.react.uimanager.events.Event<*>) {
    val ctx = context as? ReactContext ?: return
    try {
      UIManagerHelper.getEventDispatcherForReactTag(ctx, id)?.dispatchEvent(ev)
    } catch (_: Throwable) {}
  }

  /** The two baked strips (tools/gen_ambient.py), decoded once per process at their raw 8×256. */
  private object Shades {
    private val cache = HashMap<Int, Bitmap>()

    fun get(context: Context, resId: Int): Bitmap? {
      cache[resId]?.let { return it }
      return try {
        // Fresco reads the resource's raw stream (no density scaling); so do we.
        val opts = BitmapFactory.Options().apply {
          inScaled = false
          inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        BitmapFactory.decodeResource(context.resources, resId, opts)?.also { cache[resId] = it }
      } catch (_: Throwable) {
        null
      }
    }
  }

  companion object {
    /** `cardtext`: how many recorded decors are kept (the QA `views` command). */
    fun decorNodes(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) DecorNodes.size else 0

    const val TRACE_FADE = "card.fade"
    // Card.tsx:27 BLUR_RADIUS = 1 (dp); :471/:474 radius.m − 1; :473/:503 radius.m
    const val BLUR_RADIUS_DP = 1f
    const val PICTURE_RADIUS_DP = 11f
    const val CARD_RADIUS_DP = 12f
    // Card.tsx:495-504 — white at opacity 0.055 (processColor('#ffffff') with the view's alpha)
    val BRIGHTEN_COLOR: Int = (0.055 * 255).roundToInt() shl 24 or 0xFFFFFF
    // Card.tsx:369-370
    const val TILE_FROM = 0xFF1B1D31.toInt()
    const val TILE_TO = 0xFF101120.toInt()
    // fadeDuration={0} (Card.tsx:358): a 0 ms timing is a single frame to the target
    val FADE_FRAMES: DoubleArray = AuroraTiming.sample(0.0) { it }
  }
}
