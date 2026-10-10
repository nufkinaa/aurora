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
      clearIfAsked(ctx)
      if (!ArtFormat.probe) return
      // whatever is already there (React Native's own, the QA logging listener) stays
      val listeners = HashSet<RequestListener>(builder.requestListeners ?: emptySet())
      listeners.add(Listener())
      builder.setRequestListeners(listeners)
    } catch (t: Throwable) {
      Log.w(ArtFormat.TAG, "probe not attached: $t")
    }
  }

  /**
   * A cold image cache for the next launch: `adb shell touch …/files/art-clear`. The shell
   * cannot reach the app's cache dir on Android 14 (and `pm clear` would sign the app out),
   * so the app empties it itself — Fresco's disk caches (`image_cache*`) and OkHttp's
   * (`http-cache`), BEFORE Fresco is configured — and removes the marker: one launch only.
   */
  private fun clearIfAsked(ctx: Context) {
    val marker = java.io.File(ctx.applicationContext.getExternalFilesDir(null) ?: return, "art-clear")
    if (!marker.exists()) return
    var n = 0
    var bytes = 0L
    ctx.applicationContext.cacheDir?.listFiles()?.forEach { d ->
      if (d.name.startsWith("image_cache") || d.name == "http-cache") {
        d.walkBottomUp().forEach { f -> if (f.isFile) { n++; bytes += f.length() }; f.delete() }
      }
    }
    val gone = marker.delete()
    Log.i(ArtFormat.TAG, "cleared files=$n bytes=$bytes marker=${if (gone) "removed" else "STILL THERE"}")
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
    val cpu = ConcurrentHashMap<String, LongArray>() // producer -> [thread id, that thread's CPU ns] at its start
    @Volatile var decodeCpuMs = -1.0
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
      val r = live[requestId] ?: return
      r.stages[producerName] = SystemClock.uptimeMillis()
      if (producerName == "DecodeProducer") r.cpu[producerName] = longArrayOf(Thread.currentThread().id, android.os.Debug.threadCpuTimeNanos())
    }

    override fun onProducerFinishWithSuccess(requestId: String, producerName: String, extraMap: Map<String, String>?) {
      val r = live[requestId] ?: return
      val t0 = r.stages.remove(producerName) ?: return
      val ms = SystemClock.uptimeMillis() - t0
      var cpuNote = ""
      when (producerName) {
        "DecodeProducer" -> {
          // the decode starts and ends on one executor thread: its CPU time is the decode's own
          // cost, without whatever else the box was doing (wall ms carries that)
          r.cpu.remove(producerName)?.let { c ->
            if (c[0] == Thread.currentThread().id) {
              val d = (android.os.Debug.threadCpuTimeNanos() - c[1]) / 1e6
              r.decodeCpuMs = (if (r.decodeCpuMs < 0) 0.0 else r.decodeCpuMs) + d
              cpuNote = " cpuMs=${"%.1f".format(java.util.Locale.US, d)}"
            }
          }
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
      Log.i(ArtFormat.TAG, "stage kind=${r.kind} p=$producerName ms=$ms$cpuNote $extras id=$requestId")
    }

    override fun onRequestSuccess(request: ImageRequest, requestId: String, isPrefetch: Boolean) {
      val r = live.remove(requestId) ?: return
      Log.i(
        ArtFormat.TAG,
        "done kind=${r.kind} fmt=${r.fmt} bytes=${r.bytes} fetchMs=${r.fetchMs} decodeMs=${r.decodeMs} decodeCpuMs=${if (r.decodeCpuMs < 0) "-1" else "%.1f".format(java.util.Locale.US, r.decodeCpuMs)} " +
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
