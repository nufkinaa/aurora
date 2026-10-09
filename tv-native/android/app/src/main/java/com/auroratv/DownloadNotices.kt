package com.auroratv

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

/**
 * "Silo S1 E3 is ready to watch" — a TV notification when one of this
 * profile's downloads lands (elia, 2026-10-09).
 *
 * Two callers, ONE rule (this file), so nothing is announced twice:
 *
 *   the app — its socket hears `download_update` with status "done"
 *             (SessionWiring.tsx → HomeScreenModule.announceDownload);
 *   HomeScreenJob — every few hours while the app is closed, from the
 *             profile's /api/downloads (HomeScreenRows.refresh).
 *
 * A job is announced when it is: done, the profile's own ("mine" — asked for,
 * or fetched by one of its follows / smart downloads, which the server files
 * under the follower), in the library (a play link exists), not yet opened
 * (seenAt), finished after [KEY_SINCE] and within [FRESH_MS], and not in the
 * announced list. [KEY_SINCE] is written the first time this code runs (and
 * again when another profile takes the TV), so everything that finished before
 * the feature existed stays quiet.
 *
 * Kept in its own preferences file, NOT HomeScreenRows.PREFS: that one is
 * wiped when a profile leaves the TV, and losing the announced list there
 * would only make the next sign-in re-seed. Nothing here is secret — job ids,
 * a time, a switch.
 */
object DownloadNotices {
  private const val TAG = "AuroraNotices"
  private const val PREFS = "aurora_notices"
  private const val KEY_ON = "on"
  private const val KEY_SINCE = "since"
  private const val KEY_PROFILE = "profile"
  private const val KEY_IDS = "announced"
  private const val KEY_ASKED = "askedPermission"
  private const val CHANNEL_ID = "downloads"
  private const val MAX_IDS = 120
  private const val FRESH_MS = 3 * 24 * 60 * 60 * 1000L
  // a download that lands in the same minutes as the very first run still counts
  private const val SEED_SLACK_MS = 5 * 60 * 1000L

  private val lock = Any()

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** The Settings switch (storage.ts `downloadNotices`), mirrored for the job. */
  fun setEnabled(ctx: Context, on: Boolean) {
    synchronized(lock) {
      val p = prefs(ctx)
      val e = p.edit().putBoolean(KEY_ON, on)
      // switched back on: what landed while it was off is not announced late
      if (on && (!p.getBoolean(KEY_ON, true) || !p.contains(KEY_SINCE))) {
        e.putLong(KEY_SINCE, System.currentTimeMillis() - SEED_SLACK_MS)
      }
      e.apply()
    }
  }

  fun enabled(ctx: Context) = prefs(ctx).getBoolean(KEY_ON, true)

  /** Writes [KEY_SINCE] once — the line before which nothing is announced. */
  fun seed(ctx: Context) {
    synchronized(lock) {
      val p = prefs(ctx)
      if (!p.contains(KEY_SINCE)) p.edit().putLong(KEY_SINCE, System.currentTimeMillis() - SEED_SLACK_MS).apply()
    }
  }

  /**
   * Called whenever the app says who is on this TV (HomeScreenRows.configure).
   * A different profile than last time starts from now: its older downloads
   * were never "news" on this TV.
   */
  fun profileIs(ctx: Context, profileId: String?) {
    if (profileId.isNullOrEmpty()) return
    synchronized(lock) {
      val p = prefs(ctx)
      val was = p.getString(KEY_PROFILE, null)
      if (was == profileId && p.contains(KEY_SINCE)) return
      val e = p.edit().putString(KEY_PROFILE, profileId)
      if (was != null && was != profileId) {
        e.putLong(KEY_SINCE, System.currentTimeMillis() - SEED_SLACK_MS)
      } else if (!p.contains(KEY_SINCE)) {
        e.putLong(KEY_SINCE, System.currentTimeMillis() - SEED_SLACK_MS)
      }
      e.apply()
    }
  }

  /** May this app post at all? Android 13+ asks the viewer; before that it is on unless switched off in the TV's settings. */
  fun allowed(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return false
    return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
  }

  /** Whether the app should ask for the permission now: Android 13+, not granted, never asked. Marks it asked. */
  fun shouldAsk(ctx: Context, force: Boolean): Boolean {
    if (Build.VERSION.SDK_INT < 33) return false
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return false
    val p = prefs(ctx)
    if (!force && p.getBoolean(KEY_ASKED, false)) return false
    p.edit().putBoolean(KEY_ASKED, true).apply()
    return true
  }

  private fun doneAtMs(job: JSONObject): Long? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
    val s = if (job.isNull("doneAt")) return null else job.optString("doneAt", "")
    if (s.isEmpty()) return null
    return try { java.time.Instant.parse(s).toEpochMilli() } catch (_: Exception) { null }
  }

  private fun announcedIds(ctx: Context): MutableList<String> =
    (prefs(ctx).getString(KEY_IDS, "") ?: "").split('\n').filter { it.isNotEmpty() }.toMutableList()

  /** Every job in a /api/downloads answer that qualifies; returns how many were posted. */
  fun announceAll(ctx: Context, jobs: JSONArray, base: String?, session: String?): Int {
    var n = 0
    for (i in 0 until jobs.length()) {
      val j = jobs.optJSONObject(i) ?: continue
      if (announce(ctx, j, base, session)) n++
    }
    return n
  }

  /**
   * One job — posts its notification if the rule above says so, and records it.
   * Network (the poster) is touched only after the job has qualified; call off
   * the main thread.
   */
  fun announce(ctx: Context, job: JSONObject, base: String?, session: String?): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val id = job.optString("id", "")
    if (id.isEmpty() || job.optString("status") != "done" || !job.optBoolean("mine", false)) return false
    if (!job.isNull("seenAt") && job.optString("seenAt", "").isNotEmpty()) return false
    val entry = HomeScreenRows.landedItem(job) ?: return false
    val done = doneAtMs(job) ?: return false
    synchronized(lock) {
      val p = prefs(ctx)
      if (!p.getBoolean(KEY_ON, true)) return false
      if (!p.contains(KEY_SINCE)) {
        // first sight of the feature: this is the line, and nothing before it counts
        p.edit().putLong(KEY_SINCE, System.currentTimeMillis() - SEED_SLACK_MS).apply()
      }
      val since = p.getLong(KEY_SINCE, Long.MAX_VALUE)
      if (done < since || System.currentTimeMillis() - done > FRESH_MS) return false
      val ids = announcedIds(ctx)
      if (ids.contains(id)) return false
      // recorded BEFORE posting: two callers racing on the same job post it once
      ids.add(id)
      while (ids.size > MAX_IDS) ids.removeAt(0)
      p.edit().putString(KEY_IDS, ids.joinToString("\n")).apply()
    }
    if (!allowed(ctx)) {
      Log.i(TAG, "not posted (notifications not allowed): $id")
      return false
    }
    return try {
      post(ctx, id, job, entry.second, base, session)
      true
    } catch (e: Exception) {
      Log.w(TAG, "not posted: ${e.message}")
      false
    }
  }

  private fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val ch = NotificationChannel(CHANNEL_ID, "New downloads", NotificationManager.IMPORTANCE_HIGH)
    ch.description = "When something you asked for or follow has downloaded and is ready to watch"
    nm.createNotificationChannel(ch)
  }

  private fun post(ctx: Context, id: String, job: JSONObject, link: String, base: String?, session: String?) {
    ensureChannel(ctx)
    val what = HomeScreenRows.landedName(job)
    val epTitle = HomeScreenRows.landedEpisodeTitle(job)
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
      .setPackage(ctx.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pi = PendingIntent.getActivity(
      ctx, id.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val b = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle("$what is ready to watch")
      .setContentText(epTitle ?: "Downloaded to Aurora")
      .setContentIntent(pi)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
    poster(job, base, session)?.let { b.setLargeIcon(it) }
    NotificationManagerCompat.from(ctx).notify("dl-$id", 1, b.build())
    Log.i(TAG, "posted: $what")
  }

  // The poster, small, or nothing — a notification is never held up for long.
  private fun poster(job: JSONObject, base: String?, session: String?): Bitmap? {
    val raw = if (job.isNull("poster")) return null else job.optString("poster", "")
    if (raw.isEmpty()) return null
    val url = when {
      raw.startsWith("http://") || raw.startsWith("https://") -> raw
      !base.isNullOrEmpty() && raw.startsWith("/") -> base + raw
      else -> return null
    }
    return try {
      val conn = URL(url).openConnection() as HttpURLConnection
      conn.connectTimeout = 4000
      conn.readTimeout = 6000
      if (!base.isNullOrEmpty() && url.startsWith(base) && !session.isNullOrEmpty()) conn.setRequestProperty("X-Session", session)
      try {
        if (conn.responseCode !in 200..299) return null
        val bytes = conn.inputStream.use { it.readBytes() }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outHeight / (sample * 2) >= 256) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
      } finally {
        conn.disconnect()
      }
    } catch (_: Exception) {
      null
    }
  }
}
