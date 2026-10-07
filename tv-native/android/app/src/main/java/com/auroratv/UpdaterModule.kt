package com.auroratv

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
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
    // The per-app "install unknown apps" screen first; TV builds that lack it
    // get the nearest screen that exists (security, then this app's details,
    // then Settings itself) rather than a silent failure.
    val candidates = ArrayList<Intent>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      candidates.add(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")))
      candidates.add(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES))
    }
    candidates.add(Intent(Settings.ACTION_SECURITY_SETTINGS))
    candidates.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
    candidates.add(Intent(Settings.ACTION_SETTINGS))
    var lastError: Exception? = null
    for (intent in candidates) {
      try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(ctx.packageManager) == null) continue
        ctx.startActivity(intent)
        promise.resolve(true)
        return
      } catch (e: Exception) {
        lastError = e
      }
    }
    promise.reject("settings", lastError?.message ?: "no settings screen for app installs on this TV")
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

  /**
   * The quiet update: install the downloaded APK through a PackageInstaller
   * session that asks Android NOT to show its confirmation. Android 12+ grants
   * that to an app updating ITSELF when it holds
   * UPDATE_PACKAGES_WITHOUT_USER_ACTION (and may already install apps — the
   * same one-time permission the ordinary update needs). On success the
   * system replaces this process; the next launch is the new version.
   *
   * This is an ADDITION: `install` above — the ordinary prompt — is untouched
   * and remains the path whenever this one is unsupported, refused or fails
   * (UpdateResultReceiver records that). Resolves "unsupported" below
   * Android 12, "committed" once the session is handed to the system.
   */
  @ReactMethod
  fun installQuietly(path: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      promise.resolve("unsupported")
      return
    }
    try {
      val file = File(path)
      if (!file.exists()) throw Exception("the update file is missing")
      if (!ctx.packageManager.canRequestPackageInstalls()) throw Exception("not allowed to install apps yet")
      val installer = ctx.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      params.setAppPackageName(ctx.packageName)
      params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      val sessionId = installer.createSession(params)
      val session = installer.openSession(sessionId)
      try {
        session.openWrite("aurora-tv.apk", 0, file.length()).use { out ->
          file.inputStream().use { input -> input.copyTo(out) }
          session.fsync(out)
        }
        val intent = Intent(ctx, UpdateResultReceiver::class.java)
        val pending = PendingIntent.getBroadcast(
          ctx,
          sessionId,
          intent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        session.commit(pending.intentSender)
      } finally {
        session.close()
      }
      promise.resolve("committed")
    } catch (e: Exception) {
      // written down like a refusal, so the app stops holding the prompt back
      try {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putInt(KEY_STATUS, PackageInstaller.STATUS_FAILURE)
          .putLong(KEY_AT, System.currentTimeMillis())
          .apply()
      } catch (_: Exception) {}
      promise.reject("quiet", e.message ?: "the quiet update could not start")
    }
  }

  /**
   * "Restart now" (2026-10-08): the viewer asked for the update while Aurora
   * is on screen, so the app should come back by itself once the system has
   * replaced it. Written down here; RelaunchReceiver reads it when Android
   * announces the new package, and opens Aurora again if it is recent.
   */
  @ReactMethod
  fun armRelaunch(promise: Promise) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putLong(KEY_RELAUNCH, System.currentTimeMillis())
        .commit()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * Android only lets an app open itself from the background when it may
   * "display over other apps" (measured on the Mi TV, Android 14: without it
   * the relaunch is refused as a background activity start). Says whether
   * Aurora has that, and opens the screen where it is granted.
   */
  @ReactMethod
  fun canRelaunch(promise: Promise) {
    promise.resolve(try { Settings.canDrawOverlays(ctx) } catch (e: Exception) { false })
  }

  @ReactMethod
  fun openRelaunchSettings(promise: Promise) {
    val candidates = listOf(
      Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")),
      Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION),
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
    )
    for (i in candidates) {
      try {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
        promise.resolve(true)
        return
      } catch (_: Exception) {}
    }
    promise.resolve(false)
  }

  /** Can this TV update quietly at all, and how did the last attempt end? */
  @ReactMethod
  fun quietStatus(promise: Promise) {
    val map = Arguments.createMap()
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    map.putBoolean("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
    map.putInt("status", prefs.getInt(KEY_STATUS, -999))
    map.putDouble("at", prefs.getLong(KEY_AT, 0L).toDouble())
    promise.resolve(map)
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

  companion object {
    const val PREFS = "aurora_update"
    const val KEY_RELAUNCH = "relaunchAt"
    const val KEY_STATUS = "quietStatus"
    const val KEY_AT = "quietAt"
  }
}
