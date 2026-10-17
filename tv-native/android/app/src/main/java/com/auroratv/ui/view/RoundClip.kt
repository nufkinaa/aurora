package com.auroratv.ui.view

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.os.Build
import android.view.View

/**
 * How React Native clips an `<Image>` (or any View with `overflow: hidden`) to its rounded
 * padding box: `BackgroundStyleApplicator.clipToPaddingBoxWithAntiAliasing` (react-android
 * 0.86.0-2, BackgroundStyleApplicator.kt:512-626), reproduced for a rect inside one View so
 * the native card's picture / blur / shade layers get the same edge pixels as the RN Images
 * they replace:
 *
 *  - API > 28: `canvas.clipPath(roundRect)` (hardware anti-aliased clip);
 *  - API ≤ 28: draw into a layer, then mask it with the inverse path in DST_IN (API 28), or
 *    a nested DST_IN layer holding the shape (API < 28) — the same compositing RN uses.
 */
internal object RoundClip {
  private val path = Path()
  private val maskPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val dstInPaint = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) }

  fun draw(view: View, canvas: Canvas, rect: RectF, radiusPx: Float, drawContent: () -> Unit) {
    if (radiusPx <= 0f) {
      val s = canvas.save()
      canvas.clipRect(rect)
      drawContent()
      canvas.restoreToCount(s)
      return
    }
    path.rewind()
    path.fillType = Path.FillType.WINDING
    path.addRoundRect(rect, radiusPx, radiusPx, Path.Direction.CW)
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && view.width > 0 && view.height > 0) {
      val w = view.width.toFloat()
      val h = view.height.toFloat()
      val saveCount = canvas.saveLayer(0f, 0f, w, h, null)
      canvas.clipRect(0, 0, view.width, view.height)
      drawContent()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        maskPaint.xfermode = dstInPaint.xfermode
        maskPaint.color = Color.TRANSPARENT
        path.fillType = Path.FillType.INVERSE_WINDING
        canvas.drawPath(path, maskPaint)
      } else {
        val maskSave = canvas.saveLayer(0f, 0f, w, h, dstInPaint)
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        maskPaint.xfermode = null
        maskPaint.color = Color.BLACK
        canvas.drawPath(path, maskPaint)
        canvas.restoreToCount(maskSave)
      }
      canvas.restoreToCount(saveCount)
    } else {
      val s = canvas.save()
      canvas.clipPath(path)
      drawContent()
      canvas.restoreToCount(s)
    }
  }
}
