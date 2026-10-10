package com.auroratv.ui.art

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.listener.BaseRequestListener
import com.facebook.imagepipeline.listener.RequestListener
import com.facebook.imagepipeline.request.ImageRequest
import java.util.concurrent.ConcurrentHashMap

/**
 * LAB — what the box pays for a hero / backdrop picture, per request, to logcat tag
 * `AuroraArt` (docs/qa/native-bench/ART-FORMAT-PLAN.md). Off unless ArtFormat.probe.
 *
 *     adb logcat -s AuroraArt
 *
 *     AuroraArt: stage kind=hero-b1 p=NetworkFetchProducer ms=41 image_size=38112 … id=17
 *     AuroraArt: stage kind=hero-b1 p=DecodeProducer ms=23 imageFormat=WEBP_SIMPLE bitmapSize=1280x720 … id=17
 *     AuroraArt: done kind=hero-b1 fmt=WEBP_SIMPLE bytes=38112 fetchMs=41 decodeMs=23 bitmap=1280x720 totalMs=71 prefetch=0 id=17 url=…
 *
 * `decodeMs` is DecodeProducer's own start → finish, which Fresco brackets around the
 * decode call alone (the wait for the bytes is not in it). `bytes` is the network
 * fetcher's `image_size` and is -1 when the picture came from Fresco's disk cache —
 * clear the app's cache for a run that needs bytes. A picture served from the decoded
 * memory cache never reaches the decoder: its `done` line has decodeMs=-1 too.
 * Every producer of a followed request gets a `stage` line — among them
 * ResizeAndRotateProducer, the on-box JPEG re-encode `resizeMethod="resize"` asks for on
 * the title page (a WebP passes straight through it).
 *
 * Which requests: a blurred one (`blur=` — only the home hero asks for those) and the
 * catalogue's backdrops (`background`, raw or behind /img/ext) at hero / title-page
 * sizes — a shelf card's small `w=` variant of the same backdrop is not followed.
 */
object ArtProbe {
  /** MainApplication.frescoConfig calls this with the builder it is about to build. */
  @JvmStatic
  fun attach(ctx: Context, builder: ImagePipelineConfig.Builder) {
    try {
      ArtFormat.load(ctx)
      if (!ArtFormat.probe) return
      // whatever is already there (React Native's own, the QA logging listener) stays
      val listeners = HashSet<RequestListener>(builder.requestListeners ?: emptySet())
      listeners.add(Listener())
      builder.setRequestListeners(listeners)
    } catch (t: Throwable) {
      Log.w(ArtFormat.TAG, "probe not attached: $t")
    }
  }

  private val BLUR = Regex("[?&]blur=(\\d+)")
  private val WIDTH = Regex("[?&]w=(\\d+)")

  /** "hero-b1" / "hero-b2" / "backdrop", or null for a picture this probe does not follow. */
  fun kindOf(uri: String): String? {
    val blur = BLUR.find(uri)?.groupValues?.get(1)
    if (blur != null) return "hero-b$blur"
    if (!uri.contains("background")) return null
    val w = WIDTH.find(uri)?.groupValues?.get(1)?.toIntOrNull()
    return if (w == null || w >= 1280) "backdrop" else null
  }

  private class Req(val uri: String, val kind: String, val prefetch: Boolean) {
    val start = SystemClock.uptimeMillis()
    val stages = ConcurrentHashMap<String, Long>()
    @Volatile var bytes = -1L
    @Volatile var fetchMs = -1L
    @Volatile var decodeMs = -1L
    @Volatile var fmt = "-"
    @Volatile var bitmap = "-"
  }

  private class Listener : BaseRequestListener() {
    private val live = ConcurrentHashMap<String, Req>()

    override fun onRequestStart(request: ImageRequest, callerContext: Any, requestId: String, isPrefetch: Boolean) {
      val uri = request.sourceUri.toString()
      val kind = kindOf(uri) ?: return
      if (live.size > 256) live.clear() // a leak guard; never reached in a real run
      live[requestId] = Req(uri, kind, isPrefetch)
    }

    // extras (image_size, imageFormat, bitmapSize…) are only built when someone asks
    override fun requiresExtraMap(requestId: String): Boolean = live.containsKey(requestId)

    override fun onProducerStart(requestId: String, producerName: String) {
      live[requestId]?.stages?.put(producerName, SystemClock.uptimeMillis())
    }

    override fun onProducerFinishWithSuccess(requestId: String, producerName: String, extraMap: Map<String, String>?) {
      val r = live[requestId] ?: return
      val t0 = r.stages.remove(producerName) ?: return
      val ms = SystemClock.uptimeMillis() - t0
      when (producerName) {
        "DecodeProducer" -> {
          r.decodeMs = (if (r.decodeMs < 0) 0 else r.decodeMs) + ms
          extraMap?.get("imageFormat")?.let { r.fmt = it }
          extraMap?.get("bitmapSize")?.let { r.bitmap = it }
        }
        "NetworkFetchProducer" -> {
          r.fetchMs = ms
          extraMap?.get("image_size")?.toLongOrNull()?.let { r.bytes = it }
        }
      }
      val extras = extraMap?.entries?.joinToString(" ") { "${it.key}=${it.value}" } ?: ""
      Log.i(ArtFormat.TAG, "stage kind=${r.kind} p=$producerName ms=$ms $extras id=$requestId")
    }

    override fun onRequestSuccess(request: ImageRequest, requestId: String, isPrefetch: Boolean) {
      val r = live.remove(requestId) ?: return
      Log.i(
        ArtFormat.TAG,
        "done kind=${r.kind} fmt=${r.fmt} bytes=${r.bytes} fetchMs=${r.fetchMs} decodeMs=${r.decodeMs} " +
          "bitmap=${r.bitmap} totalMs=${SystemClock.uptimeMillis() - r.start} prefetch=${if (r.prefetch) 1 else 0} id=$requestId url=${r.uri}",
      )
    }

    override fun onRequestFailure(request: ImageRequest, requestId: String, throwable: Throwable, isPrefetch: Boolean) {
      val r = live.remove(requestId) ?: return
      Log.i(ArtFormat.TAG, "failed kind=${r.kind} totalMs=${SystemClock.uptimeMillis() - r.start} err=$throwable url=${r.uri}")
    }

    override fun onRequestCancellation(requestId: String) {
      live.remove(requestId)
    }
  }
}
