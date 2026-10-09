package com.auroratv.ui.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * The baked pictures the native components draw themselves (tools/gen_ambient.py; copies of
 * the PNGs in src/assets, under res/drawable-nodpi, held byte-identical by the fixture generators):
 * decoded once per process at their raw size — Fresco reads a bundled `<Image>` resource's
 * raw stream too (no density scaling), ARGB_8888. UI thread only.
 */
object AuroraBitmaps {
  private val cache = HashMap<Int, Bitmap>()

  fun raw(context: Context, resId: Int): Bitmap? {
    cache[resId]?.let { return it }
    return try {
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
