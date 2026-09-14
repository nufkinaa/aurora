package com.auroratv

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * In-app update: fetch the new APK from the Aurora server into this app's own
 * cache, then hand it to Android's package installer. The TV keeps the app
 * without a computer or a sideloading tool in the loop.
 *
 * `download` streams to cache/updates/aurora-tv.apk and emits `AuroraUpdaterProgress`
 * ({received, total}) as it goes; `install` opens the system installer on it
 * (same signing key, so it installs over the running build); `canInstall` /
 * `openInstallSettings` handle the one-time "allow this app to install apps"
 * permission Android asks for.
 */
class UpdaterModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraUpdater"

  private val busy = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)

  private fun target(): File {
    val dir = File(ctx.cacheDir, "updates")
    if (!dir.exists()) dir.mkdirs()
    return File(dir, "aurora-tv.apk")
  }

  private fun emit(received: Long, total: Long) {
    val map = Arguments.createMap()
    map.putDouble("received", received.toDouble())
    map.putDouble("total", total.toDouble())
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AuroraUpdaterProgress", map)
  }

  @ReactMethod
  fun download(url: String, session: String?, promise: Promise) {
    if (!busy.compareAndSet(false, true)) {
      promise.reject("busy", "a download is already running")
      return
    }
    cancelled.set(false)
    Thread {
      val file = target()
      var conn: HttpURLConnection? = null
      try {
        if (file.exists()) file.delete()
        conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.instanceFollowRedirects = true
        if (!session.isNullOrEmpty()) conn.setRequestProperty("X-Session", session)
        conn.connect()
        if (conn.responseCode !in 200..299) throw Exception("server answered ${conn.responseCode}")
        val total = conn.contentLengthLong
        var received = 0L
        var lastEmit = 0L
        conn.inputStream.use { input ->
          FileOutputStream(file).use { out ->
            val buf = ByteArray(256 * 1024)
            while (true) {
              if (cancelled.get()) throw Exception("cancelled")
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              received += n
              val now = System.currentTimeMillis()
              if (now - lastEmit > 150) {
                lastEmit = now
                emit(received, total)
              }
            }
          }
        }
        if (total > 0 && received != total) throw Exception("download ended early ($received of $total bytes)")
        if (received < 1024 * 1024) throw Exception("that file is too small to be the app")
        emit(received, total)
        promise.resolve(file.absolutePath)
      } catch (e: Exception) {
        try { file.delete() } catch (_: Exception) {}
        promise.reject("download", e.message ?: "download failed")
      } finally {
        try { conn?.disconnect() } catch (_: Exception) {}
        busy.set(false)
      }
    }.start()
  }

  @ReactMethod
  fun cancel() {
    cancelled.set(true)
  }

  @ReactMethod
  fun canInstall(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      promise.resolve(ctx.packageManager.canRequestPackageInstalls())
    } else {
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun openInstallSettings(promise: Promise) {
    try {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("settings", e.message ?: "could not open settings")
    }
  }

  @ReactMethod
  fun install(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) throw Exception("the update file is missing")
      val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW)
      intent.setDataAndType(uri, "application/vnd.android.package-archive")
      // CLEAR_TASK: the installer leaves its task behind after a successful
      // install (the viewer presses OPEN, the task with its "App installed"
      // screen stays). Measured on the Streamer: the NEXT update's intent
      // landed in that stale task and only re-showed the old success screen —
      // nothing was installed. Clearing the task gives every install a fresh
      // installer.
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
      intent.putExtra(Intent.EXTRA_RETURN_RESULT, false)
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("install", e.message ?: "could not start the installer")
    }
  }

  @ReactMethod
  fun versionName(promise: Promise) {
    try {
      val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      promise.resolve(info.versionName ?: "")
    } catch (e: Exception) {
      promise.resolve("")
    }
  }

  // Required by NativeEventEmitter for legacy modules.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
