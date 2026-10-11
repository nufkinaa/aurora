package com.auroratv

import android.net.Uri
import com.facebook.common.executors.CallerThreadExecutor
import com.facebook.datasource.BaseDataSubscriber
import com.facebook.datasource.DataSource
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.request.ImageRequest
import com.facebook.imagepipeline.request.ImageRequestBuilder
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.fresco.ReactNetworkImageRequest

/**
 * AuroraArt: a card's picture, fetched and DECODED before the card exists (artPrefetch.ts).
 *
 * React Native's own Image.prefetch cannot do this job: ImageLoaderModule.prefetchImage takes
 * a bare address — no headers, so a sign-in-required server answers 401 — and only fills the
 * disk cache (prefetchToDiskCache), which leaves the decode for the moment the card mounts.
 *
 * WHY THE CARD FINDS WHAT THIS FETCHED. Fresco looks a decoded picture up by
 * DefaultCacheKeyFactory.getBitmapCacheKey: the source address, the resize options, the
 * rotation options, the decode options and the postprocessor (BitmapMemoryCacheKey). The
 * encoded caches (memory and disk) are keyed by the address alone. Request headers are in
 * neither key. So the request below is built the way ReactImageView.maybeUpdateViewFromRequest
 * builds one for <Image resizeMethod="auto" source={{uri, headers}}> with no blurRadius and no
 * tiling:
 *   - postprocessor null (MultiPostprocessor.from(emptyList()) is null);
 *   - resize options null (shouldResize is false for an http address under AUTO);
 *   - setAutoRotateEnabled(true);
 *   - default decode options; lowest request level FULL_FETCH;
 *   - the headers ride on ReactNetworkImageRequest, which React Native's OkHttp fetcher reads.
 * A card's rounded corners are drawn by the drawee hierarchy (RoundingParams, BITMAP_ONLY) at
 * draw time and are not part of the request. artPrefetch.ts only sends addresses the card
 * draws with resizeMethod="auto" (cardArt.ts prefetchable); a picture drawn with "resize" is
 * keyed by the view's pixel size and is not sent here.
 *
 * Nothing is held: the decoded picture sits in Fresco's bitmap memory cache like any picture a
 * view has let go of — evicted by the cache's own limits and by the trims MainApplication wires.
 */
class ArtPrefetchModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "AuroraArt"

  private fun request(uri: String, headers: ReadableMap?): ImageRequest {
    val builder =
        ImageRequestBuilder.newBuilderWithSource(Uri.parse(uri))
            .setPostprocessor(null)
            .setResizeOptions(null)
            .setAutoRotateEnabled(true)
            .setProgressiveRenderingEnabled(false)
            .setLowestPermittedRequestLevel(ImageRequest.RequestLevel.FULL_FETCH)
            // decode into the bitmap cache whatever the pipeline's default for prefetches is
            .setShouldDecodePrefetches(true)
    // (a copy: the fetch outlives this call)
    return ReactNetworkImageRequest.fromBuilderWithHeaders(
        builder,
        headers?.let { JavaOnlyMap.deepClone(it) },
    )
  }

  /**
   * Resolves "hit" (already decoded in memory — nothing was done), "ok" (fetched from the
   * network or the disk cache and decoded) or "fail". Never rejects.
   */
  @ReactMethod
  fun prefetch(uri: String?, headers: ReadableMap?, promise: Promise) {
    try {
      if (uri.isNullOrEmpty() || !Fresco.hasBeenInitialized()) {
        promise.resolve("fail")
        return
      }
      val pipeline = Fresco.getImagePipeline()
      val req = request(uri, headers)
      if (pipeline.isInBitmapMemoryCache(req)) {
        promise.resolve("hit")
        return
      }
      val source: DataSource<Void?> = pipeline.prefetchToBitmapCache(req, this)
      source.subscribe(
          object : BaseDataSubscriber<Void?>() {
            override fun onNewResultImpl(dataSource: DataSource<Void?>) {
              if (!dataSource.isFinished) return
              dataSource.close()
              promise.resolve("ok")
            }

            override fun onFailureImpl(dataSource: DataSource<Void?>) {
              dataSource.close()
              promise.resolve("fail")
            }
          },
          CallerThreadExecutor.getInstance(),
      )
    } catch (_: Throwable) {
      promise.resolve("fail")
    }
  }
}
