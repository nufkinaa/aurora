package com.auroratv.phone

import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Environment
import android.os.StatFs
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * "AuroraOffline" — films and episodes saved ON THE PHONE (src/phone/offline/).
 *
 * The server makes the copy (the website's /api/offline/prepare flow); the bytes then come
 * down in parts through OfflineSaver.kt (save / pauseSave / stopSave / saves): it carries on
 * in the background, waits out a dropped line, waits for Wi-Fi when asked to, PAUSES and
 * carries on from where it was, and shows its progress in the notification shade. (Saves
 * begun by phone builds up to 1.1.2 went through Android's DownloadManager — start / status /
 * cancel are kept for those.) The file lands in this app's own storage (no storage permission;
 * it goes when the app is uninstalled):
 *
 *   <external files>/offline/<name>   (the films, and their subtitles beside them)
 *
 * "External files" is the phone's own storage, or — when the person picks it in Settings
 * (Save to) — the app's folder on the SD card (getExternalFilesDirs: every volume Android
 * gives this app a folder on; still no permission). Copies already saved stay where they
 * are; the choice is for the next save.
 *
 * Phone build only (PhonePackage).
 */
class OfflineModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "AuroraOffline"

  private val io = Executors.newSingleThreadExecutor()
  private fun dm() = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
  /** The volume folder chosen in Settings (one of getExternalFilesDirs), or null: the phone's own. */
  @Volatile private var root: File? = null
  private fun volumes(): List<File> = try { ctx.getExternalFilesDirs(null).filterNotNull() } catch (_: Throwable) { emptyList() }
  private fun base(): File {
    val r = root
    if (r != null && r.exists() && Environment.getExternalStorageState(r) == Environment.MEDIA_MOUNTED) return r
    return ctx.getExternalFilesDir(null) ?: ctx.filesDir
  }
  private fun dir(): File = File(base(), "offline").apply { mkdirs() }
  /** Every folder a copy may be in: each volume's offline folder (and the internal fallback). */
  private fun allDirs(): List<File> = (volumes() + ctx.filesDir).map { File(it, "offline") }
  private fun safeName(n: String) = n.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)

  /** Start a save. Resolves the DownloadManager id and the file it will write. */
  @ReactMethod
  fun start(url: String, headers: ReadableMap?, name: String, title: String, description: String, wifiOnly: Boolean, promise: Promise) {
    try {
      val file = File(dir(), safeName(name))
      if (file.exists()) file.delete()
      val req = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .setDescription(description)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        .setDestinationUri(Uri.fromFile(file))
        .setAllowedOverMetered(!wifiOnly)
        .setAllowedOverRoaming(!wifiOnly)
      val it = headers?.keySetIterator()
      while (it != null && it.hasNextKey()) {
        val k = it.nextKey()
        headers.getString(k)?.let { v -> req.addRequestHeader(k, v) }
      }
      val id = dm().enqueue(req)
      val out = Arguments.createMap()
      out.putDouble("id", id.toDouble())
      out.putString("file", file.absolutePath)
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("start", t.message, t)
    }
  }

  // ---- saves in parts (OfflineSaver.kt): pause, carry on, a dropped line waited out ----

  /**
   * Save (or carry on saving) the copy at `url` as `name` — the part already here is kept and
   * the rest asked for. Resolves {key, file}. `key` names the save in the calls below.
   */
  @ReactMethod
  fun save(key: String, url: String, headers: ReadableMap?, name: String, title: String, wifiOnly: Boolean, promise: Promise) {
    try {
      val hs = HashMap<String, String>()
      val it = headers?.keySetIterator()
      while (it != null && it.hasNextKey()) {
        val k = it.nextKey()
        headers.getString(k)?.let { v -> hs[k] = v }
      }
      // a save that has its part on a volume already carries on there (a card chosen later is for the next one)
      val safe = safeName(name)
      val there = allDirs().map { File(it, safe) }.firstOrNull { File(it.parentFile, it.name + ".part").exists() }
      val file = there ?: File(dir(), safe)
      val j = OfflineSaver.start(ctx, key, url, hs, file, title, wifiOnly)
      val out = Arguments.createMap()
      out.putString("key", j.key)
      out.putString("file", j.file.absolutePath)
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("save", t.message, t)
    }
  }

  /** The person's Pause: what is saved stays on the phone; it carries on only when asked (save again). */
  @ReactMethod
  fun pauseSave(key: String, promise: Promise) {
    promise.resolve(OfflineSaver.pause(key))
  }

  /** Cancel a save: it stops and its unfinished part is thrown away. */
  @ReactMethod
  fun stopSave(key: String, promise: Promise) {
    promise.resolve(OfflineSaver.stop(key))
  }

  /**
   * Where each save stands: {key, state (queued|running|retrying|wifi|paused|done|failed|gone),
   * bytes, total, speed (bytes a second), pausedBy (you|offline), error}. "gone": this run does
   * not know it (the app was closed) — `part` then says how much of it is on the phone.
   */
  @ReactMethod
  fun saves(keys: ReadableArray, files: ReadableArray, promise: Promise) {
    try {
      val out = Arguments.createArray()
      for (i in 0 until keys.size()) {
        val key = keys.getString(i) ?: continue
        val m = Arguments.createMap()
        m.putString("key", key)
        val j = OfflineSaver.status(key)
        if (j == null) {
          m.putString("state", "gone")
          val f = if (i < files.size()) files.getString(i) else null
          if (!f.isNullOrEmpty()) {
            val file = File(f)
            m.putDouble("part", OfflineSaver.partSize(file).toDouble())
            m.putBoolean("whole", file.exists() && file.length() > 0 && OfflineSaver.partSize(file) == 0L)
          }
        } else {
          m.putString("state", j.state)
          m.putDouble("bytes", j.bytes.toDouble())
          m.putDouble("total", j.total.toDouble())
          m.putDouble("speed", j.speed)
          j.pausedBy?.let { m.putString("pausedBy", it) }
          j.error?.let { m.putString("error", it) }
        }
        out.pushMap(m)
      }
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("saves", t.message, t)
    }
  }

  /** Where each save stands: status (pending/running/paused/done/failed/gone), bytes, total, reason. */
  @ReactMethod
  fun status(ids: ReadableArray, promise: Promise) {
    try {
      val list = LongArray(ids.size()) { ids.getDouble(it).toLong() }
      val out = Arguments.createArray()
      if (list.isEmpty()) {
        promise.resolve(out)
        return
      }
      val seen = HashSet<Long>()
      dm().query(DownloadManager.Query().setFilterById(*list)).use { c ->
        while (c.moveToNext()) {
          val id = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID))
          seen.add(id)
          val st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
          val m = Arguments.createMap()
          m.putDouble("id", id.toDouble())
          m.putString(
            "status",
            when (st) {
              DownloadManager.STATUS_PENDING -> "pending"
              DownloadManager.STATUS_RUNNING -> "running"
              DownloadManager.STATUS_PAUSED -> "paused"
              DownloadManager.STATUS_SUCCESSFUL -> "done"
              else -> "failed"
            },
          )
          m.putDouble("bytes", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble())
          m.putDouble("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble())
          m.putInt("reason", c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
          out.pushMap(m)
        }
      }
      for (id in list) if (!seen.contains(id)) {
        val m = Arguments.createMap()
        m.putDouble("id", id.toDouble())
        m.putString("status", "gone")
        out.pushMap(m)
      }
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("status", t.message, t)
    }
  }

  /** Stop a save (and throw away what it had). */
  @ReactMethod
  fun cancel(id: Double, promise: Promise) {
    try {
      promise.resolve(dm().remove(id.toLong()))
    } catch (t: Throwable) {
      promise.resolve(0)
    }
  }

  /** A small file next to the film (a subtitle track), fetched now. Resolves its path, or null. */
  @ReactMethod
  fun fetchSmall(url: String, headers: ReadableMap?, name: String, promise: Promise) {
    val hs = HashMap<String, String>()
    val it = headers?.keySetIterator()
    while (it != null && it.hasNextKey()) {
      val k = it.nextKey()
      headers.getString(k)?.let { v -> hs[k] = v }
    }
    io.execute {
      try {
        val con = URL(url).openConnection() as HttpURLConnection
        con.connectTimeout = 15000
        con.readTimeout = 30000
        for ((k, v) in hs) con.setRequestProperty(k, v)
        if (con.responseCode !in 200..299) {
          promise.resolve(null)
          return@execute
        }
        val file = File(dir(), safeName(name))
        con.inputStream.use { input -> FileOutputStream(file).use { input.copyTo(it) } }
        promise.resolve(file.absolutePath)
      } catch (t: Throwable) {
        promise.resolve(null)
      }
    }
  }

  @ReactMethod
  fun remove(path: String, promise: Promise) {
    try {
      val f = File(path)
      // only ever inside an offline folder (the phone's or the SD card's)
      val inside = allDirs().any { d -> f.canonicalPath.startsWith(d.canonicalPath + File.separator) }
      if (inside) File(f.parentFile, f.name + ".part").let { if (it.exists()) it.delete() }
      promise.resolve(inside && (f.delete() || !f.exists()))
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun exists(path: String, promise: Promise) {
    promise.resolve(try { File(path).let { it.exists() && it.length() > 0 } } catch (_: Throwable) { false })
  }

  /** Free space where the films go, and what the saved films take. */
  @ReactMethod
  fun space(promise: Promise) {
    try {
      val d = dir()
      val st = StatFs(d.absolutePath)
      val used = d.listFiles()?.sumOf { it.length() } ?: 0L
      val out = Arguments.createMap()
      out.putDouble("free", st.availableBytes.toDouble())
      out.putDouble("used", used.toDouble())
      out.putBoolean("external", Environment.isExternalStorageEmulated())
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("space", t.message, t)
    }
  }

  /**
   * Where copies can go: each volume this app has a folder on — the phone's own first, then an
   * SD card — with its free and total space, whether it can be taken out, whether it is there.
   */
  @ReactMethod
  fun volumes(promise: Promise) {
    try {
      val out = Arguments.createArray()
      volumes().forEachIndexed { i, f ->
        val m = Arguments.createMap()
        val mounted = try { Environment.getExternalStorageState(f) == Environment.MEDIA_MOUNTED } catch (_: Throwable) { false }
        m.putString("path", f.absolutePath)
        m.putBoolean("primary", i == 0)
        m.putBoolean("removable", try { Environment.isExternalStorageRemovable(f) } catch (_: Throwable) { i > 0 })
        m.putBoolean("mounted", mounted)
        try {
          val st = StatFs(f.absolutePath)
          m.putDouble("free", st.availableBytes.toDouble())
          m.putDouble("total", st.totalBytes.toDouble())
        } catch (_: Throwable) {
          m.putDouble("free", 0.0)
          m.putDouble("total", 0.0)
        }
        out.pushMap(m)
      }
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("volumes", t.message, t)
    }
  }

  /** Save the next copies to this volume folder (one volumes() named), or null for the phone's own. */
  @ReactMethod
  fun setVolume(path: String?, promise: Promise) {
    val pick = if (path.isNullOrEmpty()) null else volumes().firstOrNull { it.absolutePath == path }
    root = pick
    promise.resolve(pick?.absolutePath)
  }

  /** "wifi" | "cellular" | "other" | "none". */
  @ReactMethod
  fun network(promise: Promise) {
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.getNetworkCapabilities(cm.activeNetwork)
      promise.resolve(
        when {
          caps == null -> "none"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wifi"
          caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
          else -> "other"
        },
      )
    } catch (_: Throwable) {
      promise.resolve("other")
    }
  }
}
