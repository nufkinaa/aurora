package com.auroratv.ui.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View

/**
 * The edge of a glass pane (src/components/GlassEdge.tsx, src/glass.ts; docs/glass-tv.md):
 * the soft shadow that falls outside the pane and the light just inside its rim, as the
 * baked pictures of tools/gen_glass_edge.py - a corner picture in each corner (the right
 * ones are the left ones mirrored) and a run stretched along each side.
 *
 * WHY A VIEW. In JS this is eight <Image>s in a box: nine views to create on the frame a
 * menu or a sheet opens. Measured on the Mi TV (2026-11-10), that frame of the player's menu
 * went from about 148 ms to about 170 ms. Here it is one view that draws eight bitmaps; it
 * never invalidates itself, so after the first frame the box only composites what it drew.
 *
 * The pictures are the app's own bundled ones: React Native packs every required picture as
 * a drawable resource, and the props carry those resource names (Image.resolveAssetSource).
 * A name that is not a resource (a Metro address) is never sent here - GlassEdge.tsx lays
 * out its <Image>s then. The sizes come from the bitmaps: a resource is decoded at the
 * screen's density, so a picture of N dp is N dp wide here.
 */
class AuroraGlassEdgeView(context: Context) : View(context) {

  var cornerTop: String = ""
  var cornerFoot: String = ""
  var runTop: String = ""
  var runFoot: String = ""
  var runSide: String = ""

  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val dst = RectF()

  private fun piece(name: String): Bitmap? {
    if (name.isEmpty()) return null
    synchronized(CACHE) {
      CACHE[name]?.let { return it }
      val id = resources.getIdentifier(name, "drawable", context.packageName)
      if (id == 0) return null
      val b = (try { BitmapFactory.decodeResource(resources, id) } catch (e: Throwable) { null }) ?: return null
      CACHE[name] = b
      return b
    }
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    val top = piece(cornerTop) ?: return
    val foot = piece(cornerFoot)
    val cw = top.width.toFloat()
    val th = top.height.toFloat()
    val fh = foot?.height?.toFloat() ?: 0f
    if (w < 2 * cw || h < th + fh) return

    // the left side, then the same again mirrored about the middle
    for (pass in 0..1) {
      val n = canvas.save()
      if (pass == 1) canvas.scale(-1f, 1f, w / 2f, 0f)
      canvas.drawBitmap(top, 0f, 0f, paint)
      if (foot != null) canvas.drawBitmap(foot, 0f, h - fh, paint)
      piece(runSide)?.let {
        dst.set(0f, th, it.width.toFloat(), h - fh)
        if (dst.height() > 0f) canvas.drawBitmap(it, null, dst, paint)
      }
      canvas.restoreToCount(n)
    }
    piece(runTop)?.let {
      dst.set(cw, 0f, w - cw, it.height.toFloat())
      if (dst.width() > 0f) canvas.drawBitmap(it, null, dst, paint)
    }
    if (foot != null) {
      piece(runFoot)?.let {
        dst.set(cw, h - it.height.toFloat(), w - cw, h)
        if (dst.width() > 0f) canvas.drawBitmap(it, null, dst, paint)
      }
    }
  }

  // No overlapping rendering: an alpha on a parent needs no offscreen buffer for this view.
  override fun hasOverlappingRendering(): Boolean = false

  companion object {
    // A dozen small pictures for the life of the process (under 1 MB together).
    private val CACHE = HashMap<String, Bitmap>()
  }
}
