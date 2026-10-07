package com.auroratv

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.tvprovider.media.tv.Channel
import androidx.tvprovider.media.tv.ChannelLogoUtils
import androidx.tvprovider.media.tv.PreviewProgram
import androidx.tvprovider.media.tv.TvContractCompat
import androidx.tvprovider.media.tv.WatchNextProgram
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap

/**
 * Aurora on the TV's own home screen (elia, 2026-10-08: "like Disney+ does").
 *
 * Two things the launcher lets any app publish through the TV provider:
 *
 *   Watch Next — the launcher's "Continue watching" row. What the viewer
 *   stopped in the middle of, with its picture and how far in they are.
 *
 *   A preview channel — a row of Aurora's own ("Recommended on Aurora").
 *   The classic Android TV home shows it once enabled; the Google TV home
 *   mostly reserves such rows for partner apps, so it may not appear there.
 *
 * Every entry carries an `aurora://open?...` link that opens the app on that
 * title (the JS side reads it — homeScreen.ts). Both lists are REPLACED on
 * each call: the provider only ever shows this app its own rows, so deleting
 * "everything" deletes ours alone. The JS side only calls when the list has
 * actually changed.
 */
class HomeScreenModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraHomeScreen"

  private fun str(m: ReadableMap, k: String): String? = if (m.hasKey(k) && !m.isNull(k)) m.getString(k) else null
  private fun num(m: ReadableMap, k: String): Double = if (m.hasKey(k) && !m.isNull(k)) m.getDouble(k) else 0.0

  @ReactMethod
  fun setWatchNext(items: ReadableArray, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(0)
      return
    }
    Thread {
      try {
        val cr = ctx.contentResolver
        cr.delete(TvContractCompat.WatchNextPrograms.CONTENT_URI, null, null)
        var n = 0
        val now = System.currentTimeMillis()
        for (i in 0 until items.size()) {
          val m = items.getMap(i) ?: continue
          val link = str(m, "link") ?: continue
          val b = WatchNextProgram.Builder()
          val episode = m.hasKey("episode") && !m.isNull("episode")
          b.setType(if (episode) TvContractCompat.WatchNextPrograms.TYPE_TV_EPISODE else TvContractCompat.WatchNextPrograms.TYPE_MOVIE)
          b.setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
          // newest first: the launcher orders the row by this
          b.setLastEngagementTimeUtcMillis(now - i * 60000L)
          b.setTitle(str(m, "title") ?: "Aurora")
          str(m, "episodeTitle")?.let { b.setEpisodeTitle(it) }
          if (episode) {
            b.setSeasonNumber(num(m, "season").toInt())
            b.setEpisodeNumber(num(m, "episode").toInt())
          }
          str(m, "description")?.let { b.setDescription(it) }
          str(m, "art")?.let {
            b.setPosterArtUri(Uri.parse(it))
            b.setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_16_9)
          }
          val dur = (num(m, "duration") * 1000).toInt()
          val pos = (num(m, "position") * 1000).toInt()
          if (dur > 0) {
            b.setDurationMillis(dur)
            b.setLastPlaybackPositionMillis(pos.coerceIn(0, dur))
          }
          b.setIntentUri(Uri.parse(link))
          b.setInternalProviderId(str(m, "id") ?: link)
          if (cr.insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, b.build().toContentValues()) != null) n++
        }
        promise.resolve(n)
      } catch (e: Exception) {
        promise.reject("homescreen", e.message ?: "could not write the Continue watching row")
      }
    }.start()
  }

  // The row's icon: the app's own, drawn into a bitmap (the launcher icon is an
  // adaptive drawable, which BitmapFactory cannot decode — the first cut left
  // the row without one). Stored once per run.
  private var logoStored = false
  private fun storeLogo(id: Long) {
    if (logoStored) return
    try {
      val d = ctx.packageManager.getApplicationIcon(ctx.packageName)
      val bmp = android.graphics.Bitmap.createBitmap(160, 160, android.graphics.Bitmap.Config.ARGB_8888)
      val canvas = android.graphics.Canvas(bmp)
      d.setBounds(0, 0, 160, 160)
      d.draw(canvas)
      ChannelLogoUtils.storeChannelLogo(ctx as Context, id, bmp)
      logoStored = true
    } catch (e: Exception) {
      android.util.Log.w("AuroraHomeScreen", "logo not stored: ${e.message}")
    }
  }

  /**
   * A picture the launcher can actually load. The launcher fetches art itself,
   * with no session — and the server answers 401 without one (and a LAN server
   * is plain http, which the launcher refuses). So a picture that lives on the
   * Aurora server is fetched HERE, with the session, into the app's cache, and
   * handed over as a content:// address served by ArtProvider.
   * Anything else (a public catalogue poster) is passed through as it is.
   */
  private fun artUri(art: String, base: String?, session: String?): Uri {
    if (base.isNullOrEmpty() || !art.startsWith(base)) return Uri.parse(art)
    try {
      val dir = java.io.File(ctx.cacheDir, "homescreen")
      dir.mkdirs()
      val md = java.security.MessageDigest.getInstance("MD5").digest(art.toByteArray())
      val name = md.joinToString("") { "%02x".format(it) } + ".img"
      val file = java.io.File(dir, name)
      if (!file.exists() || file.length() < 500 || System.currentTimeMillis() - file.lastModified() > 3 * 24 * 3600 * 1000L) {
        val sep = if (art.contains("?")) "&" else "?"
        val conn = java.net.URL(art + sep + "w=640").openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 6000
        conn.readTimeout = 10000
        if (!session.isNullOrEmpty()) conn.setRequestProperty("X-Session", session)
        try {
          if (conn.responseCode !in 200..299) throw Exception("picture answered ${conn.responseCode}")
          val tmp = java.io.File(dir, "$name.tmp")
          conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
          tmp.renameTo(file)
        } finally {
          conn.disconnect()
        }
      }
      // our own exported, read-only provider (ArtProvider.kt)
      return Uri.parse("content://${ctx.packageName}.art/$name")
    } catch (e: Exception) {
      android.util.Log.w("AuroraHomeScreen", "art not cached: ${e.message}")
      return Uri.parse(art)
    }
  }

  /** Our one preview channel: found, or made (with its logo) the first time. */
  private fun channelId(name: String): Long {
    val cr = ctx.contentResolver
    cr.query(TvContractCompat.Channels.CONTENT_URI, arrayOf(TvContractCompat.Channels._ID), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val found = c.getLong(0)
        storeLogo(found)
        return found
      }
    }
    val channel = Channel.Builder()
      .setType(TvContractCompat.Channels.TYPE_PREVIEW)
      .setDisplayName(name)
      .setAppLinkIntentUri(Uri.parse("aurora://open"))
      .build()
    val uri = cr.insert(TvContractCompat.Channels.CONTENT_URI, channel.toContentValues()) ?: throw Exception("the TV refused the channel")
    val id = ContentUris.parseId(uri)
    storeLogo(id)
    // the first channel of an app is made visible without asking; later ones would prompt
    try { TvContractCompat.requestChannelBrowsable(ctx, id) } catch (_: Exception) {}
    return id
  }

  @ReactMethod
  fun setChannel(name: String, items: ReadableArray, base: String?, session: String?, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(0)
      return
    }
    Thread {
      try {
        val cr = ctx.contentResolver
        val id = channelId(name)
        cr.delete(TvContractCompat.buildPreviewProgramsUriForChannel(id), null, null)
        var n = 0
        for (i in 0 until items.size()) {
          val m = items.getMap(i) ?: continue
          val link = str(m, "link") ?: continue
          val b = PreviewProgram.Builder()
          b.setChannelId(id)
          b.setType(if (str(m, "kind") == "show") TvContractCompat.PreviewPrograms.TYPE_TV_SERIES else TvContractCompat.PreviewPrograms.TYPE_MOVIE)
          b.setTitle(str(m, "title") ?: "Aurora")
          str(m, "description")?.let { b.setDescription(it) }
          str(m, "art")?.let {
            b.setPosterArtUri(artUri(it, base, session))
            b.setPosterArtAspectRatio(
              if (str(m, "shape") == "poster") TvContractCompat.PreviewPrograms.ASPECT_RATIO_MOVIE_POSTER
              else TvContractCompat.PreviewPrograms.ASPECT_RATIO_16_9
            )
          }
          // an entry the viewer is part-way through carries its progress
          val dur = (num(m, "duration") * 1000).toInt()
          if (dur > 0) {
            b.setDurationMillis(dur)
            b.setLastPlaybackPositionMillis((num(m, "position") * 1000).toInt().coerceIn(0, dur))
          }
          b.setWeight(items.size() - i)
          b.setIntentUri(Uri.parse(link))
          b.setInternalProviderId(str(m, "id") ?: link)
          if (cr.insert(TvContractCompat.PreviewPrograms.CONTENT_URI, b.build().toContentValues()) != null) n++
        }
        promise.resolve(n)
      } catch (e: Exception) {
        promise.reject("homescreen", e.message ?: "could not write the channel")
      }
    }.start()
  }

  /** Signing out, or the viewer switching the feature off: take our rows away. */
  @ReactMethod
  fun clear(promise: Promise) {
    Thread {
      try {
        val cr = ctx.contentResolver
        cr.delete(TvContractCompat.WatchNextPrograms.CONTENT_URI, null, null)
        cr.delete(TvContractCompat.PreviewPrograms.CONTENT_URI, null, null)
        promise.resolve(true)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }.start()
  }
}
