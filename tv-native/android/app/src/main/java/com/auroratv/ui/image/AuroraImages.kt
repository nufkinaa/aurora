package com.auroratv.ui.image

import android.content.Context
import android.graphics.Paint
import android.net.Uri
import com.facebook.drawee.drawable.ScalingUtils
import com.facebook.drawee.generic.GenericDraweeHierarchy
import com.facebook.drawee.generic.GenericDraweeHierarchyBuilder
import com.facebook.drawee.generic.RoundingParams
import com.facebook.imagepipeline.common.ResizeOptions
import com.facebook.imagepipeline.postprocessors.IterativeBoxBlurPostProcessor
import com.facebook.imagepipeline.request.ImageRequest
import com.facebook.imagepipeline.request.ImageRequestBuilder
import com.facebook.imagepipeline.request.Postprocessor
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.fresco.ImageCacheControl
import com.facebook.react.modules.fresco.ReactNetworkImageRequest
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.views.imagehelper.ImageSource
import org.json.JSONObject

/**
 * One Fresco pipeline (01-architecture.md §7): the native card asks Fresco for a picture with
 * the SAME request React Native's own `<Image>` builds, so the two share every cache level
 * (bitmap / encoded / disk) and the JS and native cards draw the same decoded bitmap.
 *
 * Every line here is a copy of `ReactImageView.kt` (react-native-tvos 0.86.0-2,
 * node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/image/):
 *
 *  - the URI: `ImageSource(context, source)` (:283) — `Uri.parse`, a scheme-less string is a
 *    drawable resource;
 *  - the request (:466-479): `ImageRequestBuilder.newBuilderWithSource(uri)`,
 *    `.setPostprocessor(MultiPostprocessor.from(list))` (null for none, the one processor for
 *    one — MultiPostprocessor.kt:62-66), `.setResizeOptions(resizeOptions)` (null unless
 *    `resizeMethod="resize"`; :570-590 → `ResizeOptions(viewWidthPx, viewHeightPx)`),
 *    `.setAutoRotateEnabled(true)`, `.setProgressiveRenderingEnabled(false)` (the prop's
 *    default), `.setLowestPermittedRequestLevel(FULL_FETCH)` (cache control `default`,
 *    :330-335), wrapped by `ReactNetworkImageRequest.fromBuilderWithHeaders(builder,
 *    headers, DEFAULT)` so `X-Session` / `X-Profile` reach RN's OkHttp fetcher;
 *  - `blurRadius` (:199-209): `IterativeBoxBlurPostProcessor(2, dpToPx(blur).toInt() / 2)`,
 *    none when that is 0;
 *  - the hierarchy (:642-647 + :413-441): `RoundingParams.fromCornersRadius(0f)` with
 *    `setPaintFilterBitmap(true)`, `RoundingMethod.BITMAP_ONLY` (no overlay colour), the
 *    `resizeMode` scale type (`cover` → CENTER_CROP), `fadeDuration` 0 (every card Image
 *    passes `fadeDuration={0}`).
 *
 * Same URI + same options ⇒ same `CacheKey` (BitmapMemoryCacheKey = uri, resize, rotation,
 * decode options, postprocessor key) — that is what keeps memory flat in the mixed phase.
 */
object AuroraImages {
  /** The paint flags Android's BitmapDrawable draws with (FILTER_BITMAP | DITHER), for the shade strips. */
  val BITMAP_PAINT: Paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG)

  /** `ReactImageView.setSource` → `ImageSource(context, uri).uri` (:283). */
  fun uriOf(context: Context, source: String): Uri = ImageSource(context, source).uri

  /**
   * `ReactImageView.maybeUpdateViewFromRequest` (:448-479). `resize` is the view's px size when
   * the JS passed `resizeMethod="resize"`, null for `"auto"` on a network URI; `blurDp` is the
   * `blurRadius` prop (0 = none).
   */
  fun request(uri: Uri, headers: ReadableMap?, resize: ResizeOptions?, blurDp: Float): ImageRequest {
    val builder =
      ImageRequestBuilder.newBuilderWithSource(uri)
        .setPostprocessor(blurPostprocessor(blurDp))
        .setResizeOptions(resize)
        .setAutoRotateEnabled(true)
        .setProgressiveRenderingEnabled(false)
        .setLowestPermittedRequestLevel(ImageRequest.RequestLevel.FULL_FETCH)
    return ReactNetworkImageRequest.fromBuilderWithHeaders(builder, headers, ImageCacheControl.DEFAULT)
  }

  /** `ReactImageView.setBlurRadius` (:199-209): "Divide `blurRadius` by 2 to more closely match other platforms." */
  fun blurPostprocessor(blurDp: Float): Postprocessor? {
    if (blurDp <= 0f) return null
    val pixelBlurRadius = PixelUtil.toPixelFromDIP(blurDp).toInt() / 2
    return if (pixelBlurRadius == 0) null else IterativeBoxBlurPostProcessor(2, pixelBlurRadius)
  }

  /** `ReactImageView.buildHierarchy` (:642-647) + the per-update settings of `maybeUpdateView` (:413-441). */
  fun hierarchy(context: Context, scaleType: ScalingUtils.ScaleType, fadeDurationMs: Int): GenericDraweeHierarchy {
    val h =
      GenericDraweeHierarchyBuilder(context.resources)
        .setRoundingParams(RoundingParams.fromCornersRadius(0f).apply { setPaintFilterBitmap(true) })
        .build()
    h.actualImageScaleType = scaleType
    val rp = h.roundingParams
    if (rp != null) {
      // make sure the default rounding method is used (overlayColor is transparent)
      rp.roundingMethod = RoundingParams.RoundingMethod.BITMAP_ONLY
      h.roundingParams = rp
    }
    h.fadeDuration = fadeDurationMs
    return h
  }

  /** `{"X-Session":"…","X-Profile":"…"}` (api.ts imgSrc → ownHeaders) → the ReadableMap `<Image headers>` carries. */
  fun headersOf(json: String?): ReadableMap? {
    if (json.isNullOrEmpty()) return null
    return try {
      val o = JSONObject(json)
      if (o.length() == 0) return null
      val m: WritableMap = Arguments.createMap()
      val keys = o.keys()
      while (keys.hasNext()) {
        val k = keys.next()
        m.putString(k, o.optString(k, ""))
      }
      m
    } catch (_: Throwable) {
      null
    }
  }
}
