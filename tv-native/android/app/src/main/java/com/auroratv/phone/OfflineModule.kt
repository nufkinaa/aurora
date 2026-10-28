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
 * down through Android's own DownloadManager, which is what makes a save behave like a phone
 * download should: it carries on in the background and with the app closed, picks up again
 * after a dropped line, waits for Wi-Fi when asked to, and shows its progress in the
 * notification shade. The file lands in this app's own storage (no storage permission; it
 * goes when the app is uninstalled):
 *
 *   <external files>/offline/<name>   (the films, and their subtitles beside them)
 *
 * Phone build only (PhonePackage).
 */
class OfflineModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "AuroraOffline"

  private val io = Executors.newSingleThreadExecutor()
  private fun dm() = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
  private fun dir(): File = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "offline").apply { mkdirs() }
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
      // only ever inside the offline folder
      promise.resolve(f.canonicalPath.startsWith(dir().canonicalPath) && f.delete())
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
