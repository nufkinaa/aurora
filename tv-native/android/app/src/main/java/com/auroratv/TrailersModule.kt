package com.auroratv

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.VideoStream

/**
 * AuroraTrailers: a YouTube trailer turned into something ExoPlayer plays, ON THE TV.
 *
 * YouTube's stream URLs are bound to the address that asked for them, so the server cannot
 * resolve them for the TV; the TV does it itself, the way NewPipe and VLC do, with
 * NewPipeExtractor (com.github.TeamNewPipe:NewPipeExtractor in app/build.gradle). When YouTube
 * changes its player the extractor needs a newer release — that is a version bump there and
 * nothing here (the server's healer says so when the TVs report resolve failures).
 *
 * resolve(youtubeId) → { url, mime, kind: "dash"|"hls"|"progressive", quality }
 *   1. "dash": the video-only H.264 renditions up to 1080p plus the best AAC audio, written as
 *      ONE local DASH manifest (file://…mpd, SegmentBase byte ranges into YouTube's own
 *      files, the way NewPipe's player does it) — ExoPlayer adapts between the renditions.
 *   2. YouTube's own DASH manifest (live streams only, in practice).
 *   3. "progressive": the best muxed H.264 file with sound (360p, these days).
 *   4. "hls": YouTube's HLS manifest — last, because for the client the extractor uses it
 *      listed only 240p when tested (2026-10-09).
 * Rejects with a short code: blocked (YouTube refused this device: bot check, 403/429),
 * unavailable (removed, private, age/region-locked, or nothing ExoPlayer can play), parse
 * (the extractor could not read YouTube's answer — the usual sign it needs updating),
 * network (no connection), timeout (15 s).
 */
class TrailersModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraTrailers"

  companion object {
    private const val TIMEOUT_S = 15L
    // The whole extraction: several pages and API calls, then the player
    // script's cipher run through a JavaScript interpreter on the box — a
    // Mi TV took 10-20 s for one video (2026-10-09), so 15 s cut off most of
    // them. Callers start it when a page opens, not when the trailer is due.
    private const val RESOLVE_S = 30L
    private const val MAX_HEIGHT = 1080
    // A desktop Chrome UA. NewPipe's own Firefox/140 string is answered by
    // Google's abuse wall ("Sorry...", 403, text/html) for every youtubei call
    // from a home line, while the same request as Chrome gets JSON — replayed
    // from the PC on the TV's network, 2026-10-09.
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
    private const val CONSENT_COOKIE = "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgOqtpwY"
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "aurora-trailers").apply { isDaemon = true } }
    @Volatile private var ready = false

    private fun init() {
      if (ready) return
      synchronized(this) {
        if (ready) return
        val client = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(TIMEOUT_S, TimeUnit.SECONDS)
            .build()
        NewPipe.init(OkDownloader(client), Localization("en", "US"))
        // Ask as the iOS app too, not only as the web player: Google's abuse
        // wall answers a share of the web `player` calls from a home line with
        // its "Sorry..." page (seen on the Mi TV, 2026-10-09), and the iOS
        // client's answer carries playable addresses without a proof token.
        org.schabi.newpipe.extractor.services.youtube.extractors.YoutubeStreamExtractor.setFetchIosClient(true)
        ready = true
      }
    }
  }

  /** The Downloader NewPipeExtractor asks every page and API call through. */
  private class OkDownloader(private val client: OkHttpClient) : Downloader() {
    override fun execute(request: Request): Response {
      val method = request.httpMethod()
      val data = request.dataToSend()
      val body = data?.toRequestBody(null) ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(null) else null
      val b = okhttp3.Request.Builder().url(request.url()).method(method, body).header("User-Agent", UA)
      var hasCookie = false
      for ((k, vs) in request.headers()) {
        b.removeHeader(k)
        for (v in vs) b.addHeader(k, v)
        if (k.equals("Cookie", ignoreCase = true)) hasCookie = true
      }
      // Google's consent wall: without this cookie a YouTube request from a
      // fresh client can be answered with the "Before you continue" HTML page
      // instead of JSON (seen on the Mi TV, 2026-10-09). NewPipe's own
      // downloader sends the same value.
      if (!hasCookie && request.url().contains("youtube")) b.header("Cookie", CONSENT_COOKIE)
      client.newCall(b.build()).execute().use { r ->
        if (r.code == 429) throw ReCaptchaException("reCaptcha challenge requested", request.url())
        val text = r.body?.string() ?: ""
        val ct = r.header("Content-Type") ?: ""
        // What Google actually answered when it was not what the extractor
        // expected — the only way to read a failure off the TV (adb logcat -s AuroraTrailers).
        if (request.url().contains("youtubei") && !ct.contains("json")) {
          android.util.Log.w("AuroraTrailers", "youtubei ${r.code} ${ct.take(40)} final=${r.request.url.toString().take(120)} body=${text.replace(Regex("\\s+"), " ").take(200)}")
        }
        return Response(r.code, r.message, r.headers.toMultimap(), text, r.request.url.toString())
      }
    }
  }

  private class Fail(val code: String, msg: String) : Exception(msg)

  @ReactMethod
  fun resolve(youtubeId: String, promise: Promise) {
    if (!Regex("^[\\w-]{6,20}$").matches(youtubeId)) {
      promise.reject("unavailable", "not a YouTube id")
      return
    }
    val job = pool.submit(Callable { work(youtubeId) })
    pool.execute {
      try {
        val r = job.get(RESOLVE_S, TimeUnit.SECONDS)
        val out = Arguments.createMap()
        out.putString("url", r.url)
        out.putString("mime", r.mime)
        out.putString("kind", r.kind)
        out.putInt("quality", r.quality)
        promise.resolve(out)
      } catch (e: TimeoutException) {
        job.cancel(true)
        promise.reject("timeout", "YouTube did not answer in ${RESOLVE_S} s")
      } catch (e: ExecutionException) {
        val c = e.cause ?: e
        val (code, msg) = classify(c)
        promise.reject(code, msg)
      } catch (e: Throwable) {
        promise.reject("parse", e.toString().take(200))
      }
    }
  }

  private fun classify(e: Throwable): Pair<String, String> {
    val msg = "${e.javaClass.simpleName}: ${e.message ?: ""}".take(200)
    return when {
      e is Fail -> e.code to (e.message ?: e.code)
      e is ReCaptchaException || e is SignInConfirmNotBotException -> "blocked" to msg
      e is ContentNotAvailableException -> "unavailable" to msg
      e is ExtractionException -> "parse" to msg
      e is IOException && Regex("\\b(403|429)\\b").containsMatchIn(e.message ?: "") -> "blocked" to msg
      e is java.net.SocketTimeoutException || e is java.io.InterruptedIOException -> "timeout" to msg
      e is IOException -> "network" to msg
      else -> "parse" to msg
    }
  }

  private data class Resolved(val url: String, val mime: String, val kind: String, val quality: Int)

  private fun work(id: String): Resolved {
    init()
    val info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=$id")
    val durationS = info.duration.coerceAtLeast(1)

    // 1. our own DASH manifest over YouTube's progressive renditions
    val videos = info.videoOnlyStreams
        .filter { usable(it) && it.format == MediaFormat.MPEG_4 && (it.codec ?: "").startsWith("avc1") && it.height in 1..MAX_HEIGHT }
        .groupBy { it.height }
        .map { (_, same) -> same.maxByOrNull { it.bitrate }!! }
        .sortedByDescending { it.height }
    val audio = pickAudio(info.audioStreams)
    if (videos.isNotEmpty() && audio != null) {
      val file = writeManifest(id, buildMpd(videos, audio, durationS))
      return Resolved("file://${file.absolutePath}", "application/dash+xml", "dash", videos.first().height)
    }
    // 2. YouTube's own DASH (live)
    info.dashMpdUrl?.takeIf { it.isNotBlank() }?.let {
      return Resolved(it, "application/dash+xml", "dash", MAX_HEIGHT)
    }
    // 3. a muxed file with sound
    info.videoStreams
        .filter { it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && it.format == MediaFormat.MPEG_4 && it.height <= MAX_HEIGHT }
        .maxByOrNull { it.height }
        ?.let { return Resolved(it.content, "video/mp4", "progressive", it.height) }
    // 4. HLS
    info.hlsUrl?.takeIf { it.isNotBlank() }?.let {
      return Resolved(it, "application/x-mpegURL", "hls", 0)
    }
    throw Fail("unavailable", "no stream this TV can play")
  }

  private fun usable(v: VideoStream): Boolean =
      v.isUrl && v.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && v.itagItem != null &&
          v.initEnd > 0 && v.indexEnd > v.indexStart && v.indexStart > v.initEnd

  // AAC in MP4, the film's own language track first (a dubbed or described track only when
  // nothing else exists), then the best bitrate.
  private fun pickAudio(list: List<AudioStream>): AudioStream? =
      list.filter {
            it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP && it.format == MediaFormat.M4A &&
                it.itagItem != null && it.initEnd > 0 && it.indexEnd > it.indexStart
          }
          .sortedWith(
              compareBy<AudioStream> { if (it.audioTrackType == null || it.audioTrackType == AudioTrackType.ORIGINAL) 0 else 1 }
                  .thenByDescending { if ((it.codec ?: "").startsWith("mp4a.40.2")) 1 else 0 }
                  .thenByDescending { it.averageBitrate })
          .firstOrNull()

  private fun xml(s: String) =
      s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

  private fun buildMpd(videos: List<VideoStream>, audio: AudioStream, durationS: Long): String {
    val sb = StringBuilder()
    sb.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
    sb.append("<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" profiles=\"urn:mpeg:dash:profile:isoff-on-demand:2011\" type=\"static\" ")
    sb.append("minBufferTime=\"PT1.500S\" mediaPresentationDuration=\"PT${durationS}.000S\">\n<Period>\n")
    sb.append("<AdaptationSet id=\"0\" contentType=\"video\" mimeType=\"video/mp4\" subsegmentAlignment=\"true\" subsegmentStartsWithSAP=\"1\">\n")
    for (v in videos) {
      val fps = if (v.fps > 0) " frameRate=\"${v.fps}\"" else ""
      sb.append("<Representation id=\"v${v.itag}\" codecs=\"${xml(v.codec ?: "avc1")}\" bandwidth=\"${v.bitrate.coerceAtLeast(1)}\" width=\"${v.width}\" height=\"${v.height}\"$fps>\n")
      sb.append("<BaseURL>${xml(v.content)}</BaseURL>\n")
      sb.append("<SegmentBase indexRange=\"${v.indexStart}-${v.indexEnd}\"><Initialization range=\"${v.initStart}-${v.initEnd}\"/></SegmentBase>\n")
      sb.append("</Representation>\n")
    }
    sb.append("</AdaptationSet>\n")
    val item = audio.itagItem!!
    val rate = if (item.sampleRate > 0) " audioSamplingRate=\"${item.sampleRate}\"" else ""
    val channels = if (item.audioChannels > 0) item.audioChannels else 2
    sb.append("<AdaptationSet id=\"1\" contentType=\"audio\" mimeType=\"audio/mp4\" subsegmentAlignment=\"true\" subsegmentStartsWithSAP=\"1\">\n")
    sb.append("<Representation id=\"a${audio.itag}\" codecs=\"${xml(audio.codec ?: "mp4a.40.2")}\" bandwidth=\"${audio.bitrate.coerceAtLeast(1)}\"$rate>\n")
    sb.append("<AudioChannelConfiguration schemeIdUri=\"urn:mpeg:dash:23003:3:audio_channel_configuration:2011\" value=\"$channels\"/>\n")
    sb.append("<BaseURL>${xml(audio.content)}</BaseURL>\n")
    sb.append("<SegmentBase indexRange=\"${audio.indexStart}-${audio.indexEnd}\"><Initialization range=\"${audio.initStart}-${audio.initEnd}\"/></SegmentBase>\n")
    sb.append("</Representation>\n</AdaptationSet>\n</Period>\n</MPD>\n")
    return sb.toString()
  }

  // One small file per resolve in the app's cache; anything older than an hour goes (the
  // stream URLs inside expire within hours anyway).
  private fun writeManifest(id: String, text: String): File {
    val dir = File(ctx.cacheDir, "trailers")
    dir.mkdirs()
    val cutoff = System.currentTimeMillis() - 3600_000L
    dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    val f = File(dir, "$id-${System.currentTimeMillis()}.mpd")
    f.writeText(text)
    return f
  }
}
