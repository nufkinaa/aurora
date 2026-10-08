package com.auroratv

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.tvprovider.media.tv.Channel
import androidx.tvprovider.media.tv.ChannelLogoUtils
import androidx.tvprovider.media.tv.PreviewProgram
import androidx.tvprovider.media.tv.TvContractCompat
import androidx.tvprovider.media.tv.WatchNextProgram
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

/**
 * The writing of Aurora's rows on the TV's home screen, in one place, for the
 * two callers that need it:
 *
 *   HomeScreenModule — the app itself, each time Home has fresh rows;
 *   HomeScreenJob    — a background job every few hours, so the row stays
 *                      fresh on a TV where Aurora has not been opened.
 *
 * Both hand over the same thing: a list of entries, each a plain map
 * (id, title, art, link, position, duration …). The app builds its list in
 * TypeScript (homeScreen.ts); the job builds it here from /api/home
 * ([entriesFromHome]) — the two mappings are the same rules, written twice,
 * and MUST stay in step: the link format and its field whitelist above all,
 * because the app parses those links to open a title.
 *
 * Everything that touches the TV provider holds [lock], so the app and the
 * job can never interleave a delete with the other's inserts.
 */
object HomeScreenRows {
  const val TAG = "AuroraHomeScreen"

  // Where the app says who it is, for the background job. This is the app's
  // PRIVATE storage (MODE_PRIVATE; the manifest has allowBackup="false") — the
  // same place AsyncStorage already keeps the very same session id. Cleared
  // when the profile leaves this TV (clear()).
  const val PREFS = "aurora_homescreen"
  const val KEY_BASE = "base"
  const val KEY_SESSION = "session"
  const val KEY_PROFILE = "profileId"
  const val KEY_TOKEN = "profileToken"

  const val CHANNEL_NAME = "Aurora"
  private const val JOB_ID = 48151
  private const val PERIOD_MS = 3 * 60 * 60 * 1000L
  private const val MAX_NEXT = 8
  private const val MAX_CHANNEL = 20
  private const val DAY_MS = 24 * 60 * 60 * 1000L

  private val lock = Any()

  private fun str(m: Map<String, Any?>, k: String): String? = m[k] as? String
  private fun num(m: Map<String, Any?>, k: String): Double = (m[k] as? Number)?.toDouble() ?: 0.0

  // ---------------------------------------------------------------- Watch Next

  /** Replaces the launcher's "Continue watching" entries of this app. */
  fun writeWatchNext(ctx: Context, items: List<Map<String, Any?>>): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return 0
    synchronized(lock) {
      val cr = ctx.contentResolver
      cr.delete(TvContractCompat.WatchNextPrograms.CONTENT_URI, null, null)
      var n = 0
      val now = System.currentTimeMillis()
      for ((i, m) in items.withIndex()) {
        val link = str(m, "link") ?: continue
        val b = WatchNextProgram.Builder()
        val episode = m["episode"] != null
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
      return n
    }
  }

  // ------------------------------------------------------------------- the row

  // The row's icon: the app's own, drawn into a bitmap (the launcher icon is an
  // adaptive drawable, which BitmapFactory cannot decode — the first cut left
  // the row without one). Stored once per run.
  private var logoStored = false
  private fun storeLogo(ctx: Context, id: Long) {
    if (logoStored) return
    try {
      val d = ctx.packageManager.getApplicationIcon(ctx.packageName)
      val bmp = android.graphics.Bitmap.createBitmap(160, 160, android.graphics.Bitmap.Config.ARGB_8888)
      val canvas = android.graphics.Canvas(bmp)
      d.setBounds(0, 0, 160, 160)
      d.draw(canvas)
      ChannelLogoUtils.storeChannelLogo(ctx, id, bmp)
      logoStored = true
    } catch (e: Exception) {
      Log.w(TAG, "logo not stored: ${e.message}")
    }
  }

  private fun artDir(ctx: Context) = File(ctx.cacheDir, "homescreen")

  /**
   * A picture the launcher can actually load. The launcher fetches art itself,
   * with no session — and the server answers 401 without one (and a LAN server
   * is plain http, which the launcher refuses). So a picture that lives on the
   * Aurora server is fetched HERE, with the session, into the app's cache, and
   * handed over as a content:// address served by ArtProvider.
   * Anything else (a public catalogue poster) is passed through as it is.
   *
   * [used] collects the cache names this row refers to, so [sweepArt] knows
   * what it must keep.
   */
  private fun artUri(ctx: Context, art: String, base: String?, session: String?, used: MutableSet<String>): Uri {
    if (base.isNullOrEmpty() || !art.startsWith(base)) return Uri.parse(art)
    try {
      val dir = artDir(ctx)
      dir.mkdirs()
      val md = java.security.MessageDigest.getInstance("MD5").digest(art.toByteArray())
      val name = md.joinToString("") { "%02x".format(it) } + ".img"
      // named before the fetch: a picture that fails to refresh today keeps
      // yesterday's copy rather than losing it to the sweep
      used.add(name)
      val file = File(dir, name)
      if (!file.exists() || file.length() < 500 || System.currentTimeMillis() - file.lastModified() > 3 * DAY_MS) {
        val sep = if (art.contains("?")) "&" else "?"
        val conn = URL(art + sep + "w=640").openConnection() as HttpURLConnection
        conn.connectTimeout = 6000
        conn.readTimeout = 10000
        if (!session.isNullOrEmpty()) conn.setRequestProperty("X-Session", session)
        try {
          if (conn.responseCode !in 200..299) throw Exception("picture answered ${conn.responseCode}")
          val tmp = File(dir, "$name.tmp")
          conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
          tmp.renameTo(file)
        } finally {
          conn.disconnect()
        }
      }
      // our own exported, read-only provider (ArtProvider.kt)
      return Uri.parse("content://${ctx.packageName}.art/$name")
    } catch (e: Exception) {
      Log.w(TAG, "art not cached: ${e.message}")
      return Uri.parse(art)
    }
  }

  /**
   * The cache used to grow for ever: every picture a row had ever shown stayed
   * in cache/homescreen/. After a row is written, anything it does not refer
   * to AND that is more than a day old is deleted (the day is slack for a
   * launcher still drawing the row it was given a moment ago). Never throws.
   */
  private fun sweepArt(ctx: Context, used: Set<String>) {
    try {
      val files = artDir(ctx).listFiles() ?: return
      val cutoff = System.currentTimeMillis() - DAY_MS
      var gone = 0
      for (f in files) {
        try {
          if (!f.isFile || used.contains(f.name) || f.lastModified() > cutoff) continue
          if (f.delete()) gone++
        } catch (_: Exception) {}
      }
      if (gone > 0) Log.i(TAG, "art cache: $gone old pictures removed, ${used.size} in the row")
    } catch (e: Exception) {
      Log.w(TAG, "art cache not swept: ${e.message}")
    }
  }

  /** Our one preview channel: found, or made (with its logo) the first time. */
  private fun channelId(ctx: Context, name: String): Long {
    val cr = ctx.contentResolver
    cr.query(TvContractCompat.Channels.CONTENT_URI, arrayOf(TvContractCompat.Channels._ID), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val found = c.getLong(0)
        storeLogo(ctx, found)
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
    storeLogo(ctx, id)
    // the first channel of an app is made visible without asking; later ones would prompt
    try { TvContractCompat.requestChannelBrowsable(ctx, id) } catch (_: Exception) {}
    return id
  }

  /** Replaces the programs of Aurora's own row, then tidies the picture cache. */
  fun writeChannel(ctx: Context, name: String, items: List<Map<String, Any?>>, base: String?, session: String?): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return 0
    synchronized(lock) {
      val cr = ctx.contentResolver
      val id = channelId(ctx, name)
      // Pictures first, and only then the swap: fetching them takes seconds,
      // and the row used to sit empty on the launcher for all of that time.
      val used = HashSet<String>()
      val arts = items.map { m -> str(m, "art")?.let { artUri(ctx, it, base, session, used) } }
      cr.delete(TvContractCompat.buildPreviewProgramsUriForChannel(id), null, null)
      var n = 0
      for ((i, m) in items.withIndex()) {
        val link = str(m, "link") ?: continue
        val b = PreviewProgram.Builder()
        b.setChannelId(id)
        b.setType(if (str(m, "kind") == "show") TvContractCompat.PreviewPrograms.TYPE_TV_SERIES else TvContractCompat.PreviewPrograms.TYPE_MOVIE)
        b.setTitle(str(m, "title") ?: "Aurora")
        str(m, "description")?.let { b.setDescription(it) }
        arts[i]?.let {
          b.setPosterArtUri(it)
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
        b.setWeight(items.size - i)
        b.setIntentUri(Uri.parse(link))
        b.setInternalProviderId(str(m, "id") ?: link)
        if (cr.insert(TvContractCompat.PreviewPrograms.CONTENT_URI, b.build().toContentValues()) != null) n++
      }
      sweepArt(ctx, used)
      return n
    }
  }

  /** A profile leaves this TV: its rows go, and so does what the job knew. */
  fun clear(ctx: Context): Boolean {
    cancel(ctx)
    synchronized(lock) {
      return try {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        val cr = ctx.contentResolver
        cr.delete(TvContractCompat.WatchNextPrograms.CONTENT_URI, null, null)
        cr.delete(TvContractCompat.PreviewPrograms.CONTENT_URI, null, null)
        true
      } catch (e: Exception) {
        false
      }
    }
  }

  // ------------------------------------------------------- the background job

  /** Who the job asks as. Called by the app whenever any of the four changes. */
  fun configure(ctx: Context, base: String?, session: String?, profileId: String?, profileToken: String?) {
    val e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    fun put(k: String, v: String?) {
      if (v.isNullOrEmpty()) e.remove(k) else e.putString(k, v)
    }
    put(KEY_BASE, base?.trimEnd('/'))
    put(KEY_SESSION, session)
    put(KEY_PROFILE, profileId)
    put(KEY_TOKEN, profileToken)
    e.apply()
    if (base.isNullOrEmpty() || profileId.isNullOrEmpty()) cancel(ctx) else schedule(ctx)
  }

  /**
   * Every three hours, with a network. A job that is already waiting is left
   * alone — scheduling it again would restart its clock, and an app opened
   * every evening would then never let it run on the days it is not.
   * Persisted across a reboot when the manifest holds RECEIVE_BOOT_COMPLETED;
   * if that is ever taken out, the job is simply scheduled again the next time
   * the app runs.
   */
  fun schedule(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      val js = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
      if (js.getPendingJob(JOB_ID) != null) return
      val b = JobInfo.Builder(JOB_ID, ComponentName(ctx, HomeScreenJob::class.java))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPeriodic(PERIOD_MS)
      val info = try {
        b.setPersisted(true).build()
      } catch (_: Exception) {
        b.setPersisted(false).build()
      }
      val ok = js.schedule(info) == JobScheduler.RESULT_SUCCESS
      Log.i(TAG, "background refresh " + (if (ok) "scheduled" else "refused") + ", persisted=" + info.isPersisted)
    } catch (e: Exception) {
      Log.w(TAG, "background refresh not scheduled: ${e.message}")
    }
  }

  fun cancel(ctx: Context) {
    try {
      (ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler)?.cancel(JOB_ID)
    } catch (_: Exception) {}
  }

  private fun open(url: String, session: String?, token: String?): HttpURLConnection {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 6000
    conn.readTimeout = 15000
    // exactly what api.ts request() sends
    if (!token.isNullOrEmpty()) conn.setRequestProperty("X-Profile-Token", token)
    if (!session.isNullOrEmpty()) conn.setRequestProperty("X-Session", session)
    return conn
  }

  /**
   * What the job does: ask the server for this profile's home, turn it into
   * the two lists, and write them. Returns one line saying what happened
   * (logged by the job; also what `refreshNow` hands back to JS).
   *
   * It never writes on doubt. /api/home answers 200 with the GENERIC rows
   * when the profile's unlock token has died (they live in server memory),
   * and writing those would wipe Continue watching off the launcher — so the
   * profile's own gated route is asked first, and anything but 200 leaves the
   * rows exactly as they are until the app is next opened.
   */
  fun refresh(ctx: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "skipped: needs Android 8"
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val base = prefs.getString(KEY_BASE, null)
    val profile = prefs.getString(KEY_PROFILE, null)
    if (base.isNullOrEmpty() || profile.isNullOrEmpty()) return "skipped: no profile on this TV"
    val session = prefs.getString(KEY_SESSION, null)
    val token = prefs.getString(KEY_TOKEN, null)
    val pid = Uri.encode(profile)

    val gate = open("$base/api/profiles/$pid/state", session, token)
    val status = try { gate.responseCode } finally { gate.disconnect() }
    if (status != 200) return "skipped: the profile answered $status"

    val conn = open("$base/api/home?slim=1&profile=$pid", session, token)
    val body = try {
      if (conn.responseCode != 200) return "skipped: home answered ${conn.responseCode}"
      conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    } finally {
      conn.disconnect()
    }
    val rows = JSONObject(body).optJSONArray("rows") ?: return "skipped: no rows in the answer"
    val (next, row) = entriesFromHome(rows, base)

    // the profile may have left the TV while the server was answering
    if (prefs.getString(KEY_PROFILE, null) != profile) return "skipped: the profile changed"
    val n1 = writeWatchNext(ctx, next)
    val n2 = if (row.isNotEmpty()) writeChannel(ctx, CHANNEL_NAME, row, base, session) else 0
    return "continue watching $n1 of ${next.size}, row $n2 of ${row.size}"
  }

  // ---- /api/home → entries. A port of homeScreen.ts syncHomeScreen(); keep the two in step. ----

  // Only what opening the title needs (homeScreen.ts KEEP — same names, same order).
  private val KEEP = arrayOf(
    "id", "type", "title", "year", "cover", "poster", "backdrop", "imdbId", "inLibrary", "source",
    "showId", "showTitle", "season", "episode", "progress", "videoUrl", "transcodeBase", "infoHash", "transcodeV", "quality",
  )
  private val PLAIN_EPISODE = Regex("^Episode \\d+$")

  // A field as JS `||` would see it: null, missing and "" are all "nothing".
  private fun text(o: JSONObject, k: String): String? {
    if (o.isNull(k)) return null
    val s = o.opt(k)?.toString() ?: return null
    return if (s.isEmpty()) null else s
  }
  private fun firstText(o: JSONObject, vararg keys: String): String? {
    for (k in keys) text(o, k)?.let { return it }
    return null
  }
  private fun progressOf(o: JSONObject, k: String): Double {
    val v = o.optJSONObject("progress")?.optDouble(k, 0.0) ?: 0.0
    return if (v.isNaN()) 0.0 else v
  }
  private fun intOrNull(o: JSONObject, k: String): Int? = if (o.isNull(k)) null else o.optInt(k)

  // `aurora://open?a=play|detail&d=<encodeURIComponent(JSON of the kept fields)>`.
  // Uri.encode leaves exactly the characters encodeURIComponent leaves, and
  // writes a space as %20 (URLEncoder's "+" would not survive decodeURIComponent).
  private fun linkFor(action: String, item: JSONObject): String {
    val slim = JSONObject()
    for (k in KEEP) if (!item.isNull(k)) slim.put(k, item.get(k))
    return "aurora://open?a=$action&d=" + Uri.encode(slim.toString())
  }

  private fun isEpisode(o: JSONObject) = text(o, "showId") != null && text(o, "type") != "show"

  private fun assetUrl(base: String, path: String?): String? {
    if (path.isNullOrEmpty()) return null
    if (path.startsWith("http://") || path.startsWith("https://")) return path
    return base + path
  }

  // A resume entry's picture: the frame you stopped on when the server can cut
  // it (a library file with a position), else wide art, the cover, or the
  // show's cover.
  private fun resumeArt(o: JSONObject): String? {
    val id = text(o, "id")
    val position = progressOf(o, "position")
    if (id != null && !id.startsWith("torrent|") && position > 20) {
      return "/img/frame/${Uri.encode(id)}?t=${Math.floor(position).toLong()}"
    }
    return firstText(o, "backdrop", "cover", "poster") ?: text(o, "showId")?.let { "/img/$it" }
  }

  private fun itemsOf(row: JSONObject?, max: Int): List<JSONObject> {
    val arr: JSONArray = row?.optJSONArray("items") ?: return emptyList()
    val out = ArrayList<JSONObject>()
    for (i in 0 until arr.length()) {
      if (out.size >= max) break
      arr.optJSONObject(i)?.let { out.add(it) }
    }
    return out
  }

  /** (Watch Next entries, the row's entries) for a /api/home `rows` array. */
  fun entriesFromHome(rows: JSONArray, base: String): Pair<List<Map<String, Any?>>, List<Map<String, Any?>>> {
    var contRow: JSONObject? = null
    var recById: JSONObject? = null
    var recByTitle: JSONObject? = null
    val recTitle = Regex("recommend|for you", RegexOption.IGNORE_CASE)
    for (i in 0 until rows.length()) {
      val r = rows.optJSONObject(i) ?: continue
      val id = text(r, "id")
      if (id == "continue" && contRow == null) contRow = r
      if (id == "recommended" && recById == null) recById = r
      if (recByTitle == null && recTitle.containsMatchIn(text(r, "title") ?: "")) recByTitle = r
    }
    val cont = itemsOf(contRow, MAX_NEXT)

    val next = ArrayList<Map<String, Any?>>()
    val row = ArrayList<Map<String, Any?>>()
    for (o in cont) {
      val id = text(o, "id") ?: continue
      val ep = isEpisode(o)
      val title = text(o, "title") ?: ""
      val named = ep && !PLAIN_EPISODE.matches(title)
      val position = progressOf(o, "position")
      val duration = progressOf(o, "duration")
      val link = linkFor("play", o)
      next.add(
        mapOf<String, Any?>(
          "id" to id,
          "title" to (if (ep) text(o, "showTitle") ?: title else title),
          "episodeTitle" to (if (named) title else null),
          "season" to (if (ep) intOrNull(o, "season") else null),
          "episode" to (if (ep) intOrNull(o, "episode") else null),
          "art" to assetUrl(base, firstText(o, "backdrop", "cover", "poster")),
          "position" to position,
          "duration" to duration,
          "link" to link,
        )
      )
      // Aurora's own row leads with what the viewer is part-way through
      // (the Google TV home keeps its own Continue watching for partner apps).
      row.add(
        mapOf<String, Any?>(
          "id" to "resume-$id",
          "kind" to (if (ep || text(o, "type") == "show") "show" else "movie"),
          "title" to (if (ep) "${text(o, "showTitle") ?: title} · S${intOrNull(o, "season") ?: ""} E${intOrNull(o, "episode") ?: ""}" else title),
          "description" to (if (named) title else "Continue watching"),
          "art" to assetUrl(base, resumeArt(o)),
          "shape" to "wide",
          "position" to position,
          "duration" to duration,
          "link" to link,
        )
      )
    }
    for (o in itemsOf(recById ?: recByTitle, MAX_CHANNEL)) {
      val id = firstText(o, "imdbId", "id") ?: continue
      row.add(
        mapOf<String, Any?>(
          "id" to id,
          "kind" to (if (text(o, "type") == "show") "show" else "movie"),
          "title" to (text(o, "title") ?: ""),
          "description" to text(o, "synopsis"),
          "art" to assetUrl(base, firstText(o, "backdrop", "cover", "poster")),
          "shape" to (if (text(o, "backdrop") != null) "wide" else "poster"),
          "position" to 0.0,
          "duration" to 0.0,
          "link" to linkFor("detail", o),
        )
      )
    }
    return Pair(next, row)
  }
}
