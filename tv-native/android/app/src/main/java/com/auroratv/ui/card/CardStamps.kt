package com.auroratv.ui.card

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.os.Build
import android.text.BoringLayout
import android.text.Layout
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.AbsoluteSizeSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.common.ReactConstants
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.LengthPercentage
import com.facebook.react.uimanager.LengthPercentageType
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.style.BackgroundImageLayer
import com.facebook.react.uimanager.style.BorderRadiusProp
import com.facebook.react.uimanager.style.LogicalEdge
import com.facebook.react.views.text.ReactTextView
import com.facebook.react.views.text.ReactTypefaceUtils
import com.facebook.react.views.text.TextAttributeProps
import com.facebook.react.views.view.ReactViewGroup
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min

/**
 * render switch `cardtext`: React Native's OWN views, used as stamps. The single-view card
 * (AuroraCardView in decor mode) draws its words, pills, progress bar and ✕ by asking a
 * DETACHED ReactTextView / ReactViewGroup — styled exactly as Fabric styles Card.tsx's views
 * (the same setters: ReactTextView.setFontSize / setLetterSpacing / setNumberOfLines,
 * BackgroundStyleApplicator for background, border, radius, box-shadow, gradient, overflow)
 * — to draw itself into the card's recording canvas. The ops recorded are therefore the ops
 * React Native's own views issue (TextView's clip and layout, the BorderDrawable, the
 * OutsetBoxShadowDrawable, the gradient's shader), only without a RenderNode, a Fabric view
 * and a mount per piece. The kind icon is react-native-svg's: its own path parser, the same
 * software bitmap SvgView.drawOutput paints, drawn with SvgView's paint.
 *
 * What is NOT React Native's here and is re-implemented line for line: the Spannable
 * (TextLayoutManager.buildSpannableFromFragments with one fragment — its span classes are
 * `internal`, so equivalents with the same effect are used), the measurement Yoga asks for
 * (TextLayoutManager.createLayout / measureText) and the layout of the boxes (CardGeometry).
 *
 * UI thread only (the stamps are shared by every card of a context).
 */
class CardStamps private constructor(private val ctx: Context, private val decor: CardDecor) {

  private val density = PixelUtil.getDisplayMetricDensity().toDouble()

  // ---- text stamps ----------------------------------------------------------------------------

  /** One detached ReactTextView per Text style, configured once as Fabric configures it. */
  inner class TextStamp(val st: CardDecor.Text, val numberOfLines: Int) {
    val view: ReactTextView =
      ReactTextView(ctx).apply {
        // ReactTextView.setText(ReactTextUpdate) does the same: TextView needs LayoutParams to relayout
        layoutParams = ViewGroup.LayoutParams(0, 0)
        // ReactTextViewManager: numberOfLines, ellipsizeMode "tail", fontSize, letterSpacing,
        // includeFontPadding (default true), then onAfterUpdateTransaction → updateView()
        setNumberOfLines(numberOfLines)
        setEllipsizeLocation(TextUtils.TruncateAt.END)
        setFontSize(st.size.toFloat())
        st.letterSpacing?.let { letterSpacing = it.toFloat() } // ReactTextView.setLetterSpacing (dp)
        includeFontPadding = true
        updateView()
        // the update's break strategy (TextAttributeProps.getTextBreakStrategy: the paragraph's, default)
        breakStrategy = TextAttributeProps.getTextBreakStrategy(null)
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
      }

    /** paragraphAttributes.maximumNumberOfLines as TextLayoutManager reads it (UNSET when none). */
    private val maxLines: Int = if (numberOfLines > 0) numberOfLines else ReactConstants.UNSET

    /** TextAttributeProps.fontSize: ceil(toPixelFromSP(size)) (allowFontScaling, no maxFontSizeMultiplier). */
    val fontPx: Int = ceil(PixelUtil.toPixelFromSP(st.size.toFloat(), Float.NaN).toDouble()).toInt()

    /** TextLayoutManager.buildSpannableFromFragments for one fragment with these attributes. */
    fun spannable(text: String): Spannable {
      val sb = SpannableStringBuilder()
      val start = sb.length
      sb.append(text)
      val end = sb.length
      val ops = ArrayList<Any>()
      st.color?.let { ops.add(ForegroundColorSpan(it)) } // ReactForegroundColorSpan
      st.letterSpacing?.let {
        // TextAttributeProps.letterSpacing: toPixelFromSP(ls) / fontSize (ems)
        ops.add(LetterSpacing(PixelUtil.toPixelFromSP(it.toFloat(), Float.NaN) / fontPx))
      }
      ops.add(AbsoluteSizeSpan(fontPx)) // ReactAbsoluteSizeSpan
      if (st.weight != null) ops.add(StyleSpan(ReactTypefaceUtils.parseFontWeight(st.weight), ctx))
      val sc = st.shadowColor
      if (sc != null && (st.shadowDx != 0.0 || st.shadowDy != 0.0 || st.shadowRadius != 0.0) && Color.alpha(sc) != 0) {
        // ShadowStyleSpan: offsets toPixelFromDIP, the radius as given
        ops.add(Shadow(PixelUtil.toPixelFromDIP(st.shadowDx.toFloat()), PixelUtil.toPixelFromDIP(st.shadowDy.toFloat()), st.shadowRadius.toFloat(), sc))
      }
      st.lineHeight?.let { ops.add(LineHeight(PixelUtil.toPixelFromSP(it.toFloat(), Float.NaN))) }
      // SetSpanOperation: executed last-first, the last op with the highest priority
      for (priorityIndex in ops.indices) {
        val what = ops[ops.size - priorityIndex - 1]
        var flags = if (start == 0) Spannable.SPAN_INCLUSIVE_INCLUSIVE else Spannable.SPAN_EXCLUSIVE_INCLUSIVE
        val priority = maxOf(SPAN_MAX_PRIORITY - priorityIndex, 0)
        flags = flags and Spannable.SPAN_PRIORITY.inv()
        flags = flags or ((priority shl Spannable.SPAN_PRIORITY_SHIFT) and Spannable.SPAN_PRIORITY)
        sb.setSpan(what, start, end, flags)
      }
      return sb
    }

    /** TextLayoutManager.updateTextPaint on its scratch paint (the base attributes). */
    private fun basePaint(): TextPaint {
      val p = scratch
      p.typeface = null
      p.textSize = 12f
      p.isFakeBoldText = false
      p.textSkewX = 0f
      p.textSize = fontPx.toFloat()
      if (st.weight != null) {
        p.typeface = ReactTypefaceUtils.applyStyles(null, ReactConstants.UNSET, ReactTypefaceUtils.parseFontWeight(st.weight), null, ctx.assets)
      }
      return p
    }

    /**
     * What Yoga's measure func gets back (TextLayoutManager.measureText): [width px, height px].
     * `exact` = YogaMeasureMode.EXACTLY (a stretched Text), else AT_MOST.
     */
    fun measure(text: Spannable, widthPx: Float, exact: Boolean, rtlParagraph: Boolean): IntArray {
      val paint = basePaint()
      val boring = isBoring(text, paint)
      val breakStrategy = TextAttributeProps.getTextBreakStrategy(null)
      val hyphenation = TextAttributeProps.getHyphenationFrequency(null)
      val alignment = alignmentOf(text, rtlParagraph)
      val justification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Layout.JUSTIFICATION_MODE_NONE else -1
      val layout: Layout =
        if (boring != null && boring.width <= floor(widthPx)) {
          val lw = if (exact) ceil(widthPx).toInt() else boring.width
          BoringLayout.make(text, paint, lw, alignment, 1f, 0f, boring, true)
        } else {
          val desired = ceil(Layout.getDesiredWidth(text, paint)).toInt()
          val lw = if (exact) ceil(widthPx).toInt() else min(desired, floor(widthPx).toInt())
          val b = StaticLayout.Builder.obtain(text, 0, text.length, paint, lw)
            .setAlignment(alignment)
            .setLineSpacing(0f, 1f)
            .setIncludePad(true)
            .setBreakStrategy(breakStrategy)
            .setHyphenationFrequency(hyphenation)
          if (maxLines != ReactConstants.UNSET && maxLines != 0) b.setEllipsize(TextUtils.TruncateAt.END).setMaxLines(maxLines)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) b.setJustificationMode(justification)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setUseLineSpacingFromFallbacks(true)
          b.build()
        }
      val lines = if (maxLines == ReactConstants.UNSET || maxLines == 0) layout.lineCount else min(maxLines, layout.lineCount)
      val w = if (exact) ceil(widthPx).toInt() else layout.width
      val h = if (lines > 0) layout.getLineBottom(lines - 1) else 0
      return intArrayOf(w, h)
    }

    /** TextLayoutManager.getTextAlignment. */
    private fun alignmentOf(text: Spanned, rtlParagraph: Boolean): Layout.Alignment {
      val scriptRtl = TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(text, 0, text.length)
      val swap = rtlParagraph != scriptRtl
      var a = if (swap) Layout.Alignment.ALIGN_OPPOSITE else Layout.Alignment.ALIGN_NORMAL
      when (st.align) {
        "center" -> a = Layout.Alignment.ALIGN_CENTER
        "right" -> a = if (swap) Layout.Alignment.ALIGN_NORMAL else Layout.Alignment.ALIGN_OPPOSITE
      }
      return a
    }

    /** TextLayoutManager.getTextGravity → ReactTextView.setGravityHorizontal (vertical stays TOP). */
    private fun gravityOf(text: Spanned, rtlParagraph: Boolean): Int {
      val swapLR = TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(text, 0, text.length)
      return when (alignmentOf(text, rtlParagraph)) {
        Layout.Alignment.ALIGN_NORMAL -> if (swapLR) Gravity.RIGHT else Gravity.LEFT
        Layout.Alignment.ALIGN_OPPOSITE -> if (swapLR) Gravity.LEFT else Gravity.RIGHT
        else -> Gravity.CENTER_HORIZONTAL
      }
    }

    /** Fabric's mount of this Text at `box`, then its draw into `canvas` (the card's coordinates). */
    fun draw(canvas: Canvas, text: Spannable, box: CardGeometry.Box, rtlParagraph: Boolean) {
      if (box.w <= 0 || box.h <= 0) return
      val v = view
      v.layoutDirection = if (rtlParagraph) View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
      v.gravity = Gravity.TOP or gravityOf(text, rtlParagraph)
      v.text = text
      v.measure(View.MeasureSpec.makeMeasureSpec(box.w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(box.h, View.MeasureSpec.EXACTLY))
      v.layout(0, 0, box.w, box.h)
      val save = canvas.save()
      canvas.translate(box.x.toFloat(), box.y.toFloat())
      v.draw(canvas)
      canvas.restoreToCount(save)
    }
  }

  val labelText = TextStamp(decor.labelText, 1)
  val labelSub = TextStamp(decor.labelSub, 1)
  // [household] the card's line under its title ("From Dana and Ben"): up to two lines, as Card.tsx
  val labelMeta = TextStamp(decor.labelSub, 2)
  val frameTitle = TextStamp(decor.frameTitle, 1)
  val frameSub = TextStamp(decor.frameSub, 1)
  val frameMeta = TextStamp(decor.frameMeta, 0)
  val fallbackText = TextStamp(decor.fallbackText, 3)
  val newText = TextStamp(decor.newText, 0)
  val removeGlyph = TextStamp(decor.removeGlyph, 0)

  // ---- box stamps -------------------------------------------------------------------------

  /** A detached ReactViewGroup styled through BackgroundStyleApplicator as ReactViewManager would. */
  private fun styled(b: CardDecor.Box): ReactViewGroup =
    ReactViewGroup(ctx).apply {
      b.background?.let { BackgroundStyleApplicator.setBackgroundColor(this, it) }
      if (b.borderWidth != 0.0) BackgroundStyleApplicator.setBorderWidth(this, LogicalEdge.ALL, b.borderWidth.toFloat())
      b.borderColor?.let { BackgroundStyleApplicator.setBorderColor(this, LogicalEdge.ALL, it) }
      if (b.borderRadius != 0.0) {
        BackgroundStyleApplicator.setBorderRadius(this, BorderRadiusProp.BORDER_RADIUS, LengthPercentage(b.borderRadius.toFloat(), LengthPercentageType.POINT))
      }
      b.shadow?.let { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) BackgroundStyleApplicator.setBoxShadow(this, it) }
      b.image?.let { setImage(this, it) }
      if (b.clip) overflow = "hidden"
    }

  private fun setImage(v: View, arr: ReadableArray) {
    val layers = ArrayList<BackgroundImageLayer>(arr.size())
    for (i in 0 until arr.size()) BackgroundImageLayer.parse(arr.getMap(i), ctx)?.let { layers.add(it) }
    BackgroundStyleApplicator.setBackgroundImage(v, layers)
  }

  private val newPill = styled(decor.newPill)
  private val filmPill = styled(decor.filmPill)
  private val seriesPill = styled(decor.seriesPill)
  private val removeBox = styled(decor.remove)
  // the bar: track ⊃ fill ⊃ bead, a real (detached) tree so the track's overflow clip applies
  private val track = styled(decor.progress)
  private val trackFrame = styled(decor.progressFrame)
  private val fill = styled(decor.progressFill)
  private val head = styled(decor.progressHead)

  /** Draw a styled box stamp at `box` (its background, border and shadow, as the View would). */
  fun drawBox(canvas: Canvas, which: String, box: CardGeometry.Box) {
    val v = when (which) {
      "new" -> newPill
      "film" -> filmPill
      "series" -> seriesPill
      "remove" -> removeBox
      else -> return
    }
    v.layout(0, 0, box.w, box.h)
    val save = canvas.save()
    canvas.translate(box.x.toFloat(), box.y.toFloat())
    v.draw(canvas)
    canvas.restoreToCount(save)
  }

  /** The progress bar: [track, fill, head] boxes from CardGeometry.progress (absolute px). */
  fun drawProgress(canvas: Canvas, frameBar: Boolean, boxes: List<CardGeometry.Box>) {
    val t = if (frameBar) trackFrame else track
    val (tb, fb, hb) = Triple(boxes[0], boxes[1], boxes[2])
    if (fill.parent !== t) {
      (fill.parent as? ViewGroup)?.removeView(fill)
      t.addView(fill)
    }
    if (head.parent !== fill) fill.addView(head)
    t.layout(0, 0, tb.w, tb.h)
    fill.layout(fb.x - tb.x, fb.y - tb.y, fb.x - tb.x + fb.w, fb.y - tb.y + fb.h)
    head.layout(hb.x - fb.x, hb.y - fb.y, hb.x - fb.x + hb.w, hb.y - fb.y + hb.h)
    val save = canvas.save()
    canvas.translate(tb.x.toFloat(), tb.y.toFloat())
    t.draw(canvas)
    canvas.restoreToCount(save)
  }

  // ---- the kind icon (react-native-svg) ---------------------------------------------------

  private val icons = HashMap<String, Bitmap>()
  private val iconPaint =
    Paint().apply {
      // SvgView.onDraw: mPaint.reset(); flags; typeface DEFAULT; drawBitmap(mBitmap, 0, 0, mPaint)
      flags = Paint.ANTI_ALIAS_FLAG or Paint.DEV_KERN_TEXT_FLAG or Paint.SUBPIXEL_TEXT_FLAG or Paint.FILTER_BITMAP_FLAG
      typeface = Typeface.DEFAULT
    }

  /** SvgView.drawOutput for `<Svg width={11} height={11} viewBox="0 0 24 24" fill={color}>` + the glyph. */
  private fun iconBitmap(kind: String, wPx: Int, hPx: Int): Bitmap? {
    if (wPx < 1 || hPx < 1) return null
    val key = "$kind:$wPx:$hPx"
    icons[key]?.let { return it }
    val scale = DisplayMetricsHolder.getScreenDisplayMetrics().density
    val bmp = Bitmap.createBitmap(wPx, hPx, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    // ViewBox.getTransform(vbRect = viewBox × mScale, eRect = (0,0,w,h), "xMidYMid", meet)
    val vbW = (24f * scale).toDouble()
    val vbH = (24f * scale).toDouble()
    val s = min(wPx / vbW, hPx / vbH)
    var tx = 0.0 - 0.0 * s
    var ty = 0.0 - 0.0 * s
    tx += (wPx - vbW * s) / 2.0
    ty += (hPx - vbH * s) / 2.0
    val m = Matrix()
    m.postTranslate(tx.toFloat(), ty.toFloat())
    m.preScale(s.toFloat(), s.toFloat())
    c.concat(m)
    val paint = Paint().apply {
      // RenderableView.setupFillPaint
      reset()
      flags = Paint.ANTI_ALIAS_FLAG or Paint.DEV_KERN_TEXT_FLAG or Paint.SUBPIXEL_TEXT_FLAG
      style = Paint.Style.FILL
      color = if (kind == "series") decor.iconSeriesColor else decor.iconFilmColor
    }
    for (p in glyph(kind, scale)) c.drawPath(p, paint)
    // an IMMUTABLE copy: HWUI uploads it once (SvgView's mutable bitmap is re-pinned every frame)
    val out = bmp.copy(Bitmap.Config.ARGB_8888, false) ?: bmp
    if (out !== bmp) bmp.recycle()
    icons[key] = out
    return out
  }

  /** Icon.tsx's 'film' Path and 'series' Rects, in px as react-native-svg builds them. */
  private fun glyph(kind: String, scale: Float): List<Path> =
    if (kind == "series") {
      listOf(rect(2.0, 4.0, 20.0, 13.0, 2.0, scale), rect(8.0, 19.0, 8.0, 2.0, 1.0, scale))
    } else {
      listOf(com.horcrux.svg.AuroraSvgPaths.parse(FILM_D, scale))
    }

  /** RectView.getPath (x, y, w, h, rx in user units × mScale; ry = rx; clamped to half). */
  private fun rect(x: Double, y: Double, w: Double, h: Double, rxIn: Double, scale: Float): Path {
    val px = x * scale; val py = y * scale; val pw = w * scale; val ph = h * scale
    var rx = rxIn * scale
    var ry = rx
    if (rx > pw / 2) rx = pw / 2
    if (ry > ph / 2) ry = ph / 2
    return Path().apply { addRoundRect(px.toFloat(), py.toFloat(), (px + pw).toFloat(), (py + ph).toFloat(), rx.toFloat(), ry.toFloat(), Path.Direction.CW) }
  }

  /** The SvgView at `box` (its own Yoga box): its bitmap drawn at its origin. */
  fun drawIcon(canvas: Canvas, kind: String, box: CardGeometry.Box) {
    val bmp = iconBitmap(kind, box.w, box.h) ?: return
    canvas.drawBitmap(bmp, box.x.toFloat(), box.y.toFloat(), iconPaint)
  }

  // ---- span equivalents of React Native's internal ones -----------------------------------

  /** CustomLetterSpacingSpan. */
  private class LetterSpacing(val ems: Float) : MetricAffectingSpan() {
    override fun updateDrawState(tp: TextPaint) { if (!ems.isNaN()) tp.letterSpacing = ems }
    override fun updateMeasureState(tp: TextPaint) { if (!ems.isNaN()) tp.letterSpacing = ems }
  }

  /** CustomStyleSpan (no family, no italic, no font features). */
  private class StyleSpan(val weight: Int, val ctx: Context) : MetricAffectingSpan() {
    private fun apply(p: Paint) {
      val tf = ReactTypefaceUtils.applyStyles(p.typeface, ReactConstants.UNSET, weight, null, ctx.assets)
      p.fontFeatureSettings = null
      p.typeface = tf
      p.isSubpixelText = true
      p.isLinearText = true
    }
    override fun updateDrawState(tp: TextPaint) = apply(tp)
    override fun updateMeasureState(tp: TextPaint) = apply(tp)
  }

  /** ShadowStyleSpan. */
  private class Shadow(val dx: Float, val dy: Float, val radius: Float, val color: Int) : CharacterStyle() {
    override fun updateDrawState(tp: TextPaint) = tp.setShadowLayer(radius, dx, dy, color)
  }

  /** CustomLineHeightSpan. */
  private class LineHeight(height: Float) : LineHeightSpan {
    val lineHeight: Int = ceil(height.toDouble()).toInt()
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, v: Int, fm: Paint.FontMetricsInt) {
      val leading = lineHeight - ((-fm.ascent) + fm.descent)
      fm.ascent -= ceil(leading / 2.0f).toInt()
      fm.descent += floor(leading / 2.0f).toInt()
      if (start == 0) fm.top = fm.ascent
      if (end == text.length) fm.bottom = fm.descent
    }
  }

  companion object {
    /** Icon.tsx 'film' (the site's ui.js path). __tests__/logic/card-decor.test.ts checks it against Icon.tsx. */
    const val FILM_D = "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z"
    private val SPAN_MAX_PRIORITY = Spanned.SPAN_PRIORITY shr Spanned.SPAN_PRIORITY_SHIFT
    private val scratch = TextPaint(TextPaint.ANTI_ALIAS_FLAG)

    private fun isBoring(text: Spannable, paint: TextPaint): BoringLayout.Metrics? {
      val m =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) BoringLayout.isBoring(text, paint)
        else BoringLayout.isBoring(text, paint, TextDirectionHeuristics.FIRSTSTRONG_LTR, true, null)
      return if (m == null || m.width < 0) null else m
    }

    private var last: CardStamps? = null
    private var lastCtx: Context? = null
    private var lastDecor: CardDecor? = null

    /** The stamps of this context and decor (made once; UI thread). */
    fun of(ctx: Context, decor: CardDecor): CardStamps {
      val l = last
      if (l != null && lastCtx === ctx && lastDecor === decor) return l
      return CardStamps(ctx, decor).also {
        last = it
        lastCtx = ctx
        lastDecor = decor
      }
    }
  }
}
