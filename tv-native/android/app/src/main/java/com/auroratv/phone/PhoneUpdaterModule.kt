package com.auroratv.phone

import android.app.Activity
import android.app.DownloadManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * "AuroraPhoneUpdater" — the phone app's own update, built for a phone that is used like a phone
 * (src/phone/update/store.ts has the steps, update/rules.ts the decisions). Aurora is on no app
 * store, so this is the only way a phone gets a new version: it has to work every time.
 *
 * Why not the TV's UpdaterModule (which stays exactly as it is, for the TVs):
 *  - THE DOWNLOAD is Android's DownloadManager, not a thread in this app: a phone is put in a
 *    pocket mid-download, and Android freezes an app in the background within seconds. The
 *    system's downloader carries on with the app away or closed, picks up after a dropped line,
 *    and shows its progress in the notification shade. Its id is written down, so a return to
 *    the app (or a new run of it) finds the same download again (`current`).
 *  - THE CHECK before installing (`verify`): the file's size and SHA-256 against what the server
 *    announced, and the APK itself read by Android — this app's package, a HIGHER versionCode
 *    than the one running, signed with the SAME certificate. A damaged, partial, older or
 *    foreign file never reaches the installer (which would only say "App not installed").
 *  - THE INSTALL is a PackageInstaller session whose answer comes back to PhoneActivity:
 *    Android's "Do you want to update this app?" is opened from it, and Cancel there is HEARD
 *    (STATUS_FAILURE_ABORTED → the sheet says the update was not installed and offers it
 *    again). When the update goes through, Android ends this process; the success answer then
 *    opens PhoneActivity again — the app comes back as the new version by itself.
 *    If the session cannot be made, the TV's way (the installer opened on the file) is used.
 *
 * Phone build only (PhonePackage).
 */
class PhoneUpdaterModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "AuroraPhoneUpdater"

  init {
    current = WeakReference(this)
  }

  private val io = Executors.newSingleThreadExecutor()
  private fun dm() = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
  private fun prefs() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun dir(): File = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "updates").apply { mkdirs() }
  private fun safe(v: String) = v.replace(Regex("[^A-Za-z0-9._-]"), "_").take(40)

  private fun installed(): PackageInfo? = try {
    if (Build.VERSION.SDK_INT >= 33) ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.PackageInfoFlags.of(signingFlag().toLong()))
    else @Suppress("DEPRECATION") ctx.packageManager.getPackageInfo(ctx.packageName, signingFlag())
  } catch (_: Throwable) { null }

  @Suppress("DEPRECATION")
  private fun signingFlag() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  private fun codeOf(p: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()

  /** SHA-256 of each signing certificate, as hex — what "the same key" means. */
  @Suppress("DEPRECATION")
  private fun certsOf(p: PackageInfo?): Set<String> {
    if (p == null) return emptySet()
    val sigs = if (Build.VERSION.SDK_INT >= 28) {
      val si = p.signingInfo ?: return emptySet()
      if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
    } else p.signatures
    return (sigs ?: emptyArray()).map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
  }

  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

  override fun getConstants(): MutableMap<String, Any> {
    val p = installed()
    return hashMapOf(
      "versionName" to (p?.versionName ?: ""),
      "versionCode" to (p?.let { codeOf(it).toDouble() } ?: 0.0),
      "sdk" to Build.VERSION.SDK_INT,
    )
  }

  /** Free space where the update lands (the download, and the install's own copy). */
  @ReactMethod
  fun space(promise: Promise) {
    try {
      promise.resolve(StatFs(dir().absolutePath).availableBytes.toDouble())
    } catch (t: Throwable) {
      promise.resolve(-1.0)
    }
  }

  /** May Aurora install apps yet (Android's per-app "Install unknown apps")? */
  @ReactMethod
  fun canInstall(promise: Promise) {
    promise.resolve(if (Build.VERSION.SDK_INT >= 26) ctx.packageManager.canRequestPackageInstalls() else true)
  }

  /** That switch, for Aurora alone; back in the app, the update goes on (store.ts). */
  @ReactMethod
  fun openInstallSettings(promise: Promise) {
    val tries = ArrayList<Intent>()
    if (Build.VERSION.SDK_INT >= 26) {
      tries.add(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")))
      tries.add(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES))
    }
    tries.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
    for (i in tries) {
      try {
        if (i.resolveActivity(ctx.packageManager) == null) continue
        val act = ctx.currentActivity
        if (act != null) act.startActivity(i) else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        promise.resolve(true)
        return
      } catch (_: Throwable) {}
    }
    promise.resolve(false)
  }

  /**
   * Start fetching `version` from `url` (headers: the session). Anything an earlier attempt left
   * is removed first — one update file at a time. Resolves {id, file}.
   */
  @ReactMethod
  fun start(url: String, headers: ReadableMap?, version: String, title: String, promise: Promise) {
    try {
      val old = prefs().getLong(KEY_ID, -1L)
      if (old >= 0) try { dm().remove(old) } catch (_: Throwable) {}
      dir().listFiles()?.forEach { try { it.delete() } catch (_: Throwable) {} }
      val file = File(dir(), "aurora-phone-${safe(version)}.apk")
      val req = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .setDescription(version)
        .setMimeType("application/vnd.android.package-archive")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        .setDestinationUri(Uri.fromFile(file))
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(true)
      val it = headers?.keySetIterator()
      while (it != null && it.hasNextKey()) {
        val k = it.nextKey()
        headers.getString(k)?.let { v -> req.addRequestHeader(k, v) }
      }
      val id = dm().enqueue(req)
      prefs().edit().putLong(KEY_ID, id).putString(KEY_VERSION, version).putString(KEY_FILE, file.absolutePath).apply()
      val out = Arguments.createMap()
      out.putDouble("id", id.toDouble())
      out.putString("file", file.absolutePath)
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("start", t.message ?: "the download could not start", t)
    }
  }

  /** The download this app started last, if any: {id, version, file} — or null. */
  @ReactMethod
  fun current(promise: Promise) {
    val p = prefs()
    val id = p.getLong(KEY_ID, -1L)
    if (id < 0) return promise.resolve(null)
    val out = Arguments.createMap()
    out.putDouble("id", id.toDouble())
    out.putString("version", p.getString(KEY_VERSION, "") ?: "")
    out.putString("file", p.getString(KEY_FILE, "") ?: "")
    promise.resolve(out)
  }

  /** Where it stands: {status: pending|running|paused|done|failed|gone, bytes, total, reason}. */
  @ReactMethod
  fun status(id: Double, promise: Promise) {
    try {
      val out = Arguments.createMap()
      out.putString("status", "gone")
      dm().query(DownloadManager.Query().setFilterById(id.toLong())).use { c ->
        if (c.moveToFirst()) {
          val st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
          out.putString(
            "status",
            when (st) {
              DownloadManager.STATUS_PENDING -> "pending"
              DownloadManager.STATUS_RUNNING -> "running"
              DownloadManager.STATUS_PAUSED -> "paused"
              DownloadManager.STATUS_SUCCESSFUL -> "done"
              else -> "failed"
            },
          )
          out.putDouble("bytes", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble())
          out.putDouble("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble())
          out.putInt("reason", c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
        }
      }
      promise.resolve(out)
    } catch (t: Throwable) {
      promise.reject("status", t.message, t)
    }
  }

  /** Stop it, and throw away what came down. */
  @ReactMethod
  fun cancel(promise: Promise) {
    forget()
    promise.resolve(true)
  }

  private fun forget() {
    val id = prefs().getLong(KEY_ID, -1L)
    if (id >= 0) try { dm().remove(id) } catch (_: Throwable) {}
    prefs().edit().remove(KEY_ID).remove(KEY_VERSION).remove(KEY_FILE).apply()
    dir().listFiles()?.forEach { try { it.delete() } catch (_: Throwable) {} }
  }

  /** The update is in (or no longer wanted): its file goes, and so does the note of it. */
  @ReactMethod
  fun cleanup(promise: Promise) {
    forget()
    promise.resolve(true)
  }

  /**
   * Is this file the update it claims to be? Resolves {ok, reason?, sha256, size, versionName,
   * versionCode}. `reason` (when not ok): size | sha256 | unreadable | package | older | signer |
   * missing. `sha256` / `size` may be empty / 0: not announced, not checked.
   */
  @ReactMethod
  fun verify(path: String, sha256: String?, size: Double, promise: Promise) {
    io.execute {
      val out = Arguments.createMap()
      fun fail(reason: String) {
        out.putBoolean("ok", false)
        out.putString("reason", reason)
        promise.resolve(out)
      }
      try {
        val f = File(path)
        if (!f.exists() || f.length() == 0L) return@execute fail("missing")
        out.putDouble("size", f.length().toDouble())
        if (size > 0 && f.length() != size.toLong()) return@execute fail("size")
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
          val buf = ByteArray(256 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
          }
        }
        val got = hex(md.digest())
        out.putString("sha256", got)
        if (!sha256.isNullOrEmpty() && !sha256.equals(got, ignoreCase = true)) return@execute fail("sha256")
        val pm = ctx.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(signingFlag().toLong()))
          else @Suppress("DEPRECATION") pm.getPackageArchiveInfo(path, signingFlag())
        if (info == null) return@execute fail("unreadable")
        // (an archive's signatures are only read with its path filled in)
        info.applicationInfo?.let { it.sourceDir = path; it.publicSourceDir = path }
        out.putString("versionName", info.versionName ?: "")
        out.putDouble("versionCode", codeOf(info).toDouble())
        if (info.packageName != ctx.packageName) return@execute fail("package")
        val mine = installed()
        if (mine != null && codeOf(info) <= codeOf(mine)) return@execute fail("older")
        val want = certsOf(mine)
        val have = certsOf(info)
        if (want.isNotEmpty() && (have.isEmpty() || want.intersect(have).isEmpty())) return@execute fail("signer")
        out.putBoolean("ok", true)
        promise.resolve(out)
      } catch (t: Throwable) {
        fail("unreadable")
      }
    }
  }

  /**
   * Hand the checked file to Android. Resolves "session" (Android's question is coming up; its
   * answer arrives as an `AuroraPhoneUpdate` event) or "viewer" (the fallback: the installer
   * opened on the file, as the TV does).
   */
  @ReactMethod
  fun install(path: String, promise: Promise) {
    val file = File(path)
    if (!file.exists()) return promise.reject("install", "the update file is missing")
    try {
      val installer = ctx.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      params.setAppPackageName(ctx.packageName)
      params.setSize(file.length())
      val sessionId = installer.createSession(params)
      val session = installer.openSession(sessionId)
      try {
        session.openWrite("aurora-phone.apk", 0, file.length()).use { out ->
          file.inputStream().use { it.copyTo(out, 256 * 1024) }
          session.fsync(out)
        }
        // The answer goes to the phone's activity (PhoneActivity → onStatusIntent): it is where
        // Android's question is opened from, and — after a successful update, in the new
        // version's process — what brings the app back on screen.
        val answer = Intent(ACTION_STATUS).setClassName(ctx, "com.auroratv.PhoneActivity")
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pending = PendingIntent.getActivity(ctx, sessionId, answer, flags)
        prefs().edit().putLong(KEY_INSTALL_AT, System.currentTimeMillis()).apply()
        session.commit(pending.intentSender)
      } finally {
        session.close()
      }
      promise.resolve("session")
    } catch (t: Throwable) {
      // the TV's way, which has always worked: the installer opened on the file
      try {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        val i = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
          .putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
        ctx.startActivity(i)
        promise.resolve("viewer")
      } catch (e: Throwable) {
        promise.reject("install", e.message ?: "could not start the installer", e)
      }
    }
  }

  private fun emit(status: String, message: String?) {
    try {
      val m = Arguments.createMap()
      m.putString("status", status)
      if (message != null) m.putString("message", message)
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("AuroraPhoneUpdate", m)
    } catch (_: Throwable) {}
  }

  // Required by NativeEventEmitter for legacy modules.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    const val ACTION_STATUS = "com.aurora.phone.UPDATE_STATUS"
    const val PREFS = "aurora_phone_update"
    const val KEY_ID = "downloadId"
    const val KEY_VERSION = "version"
    const val KEY_FILE = "file"
    const val KEY_INSTALL_AT = "installAt"
    private var current: WeakReference<PhoneUpdaterModule>? = null

    /**
     * PhoneActivity hands over every intent it gets: true when it was the installer's answer.
     *  - PENDING_USER_ACTION: Android's own "Do you want to update this app?" — opened now;
     *  - SUCCESS: (heard in the NEW version's process) nothing to do — the app is on screen;
     *  - anything else: the sheet is told (`AuroraPhoneUpdate` {status, message}): "aborted"
     *    is the person's Cancel, the rest a failure with Android's own words.
     */
    @JvmStatic
    fun onStatusIntent(activity: Activity, intent: Intent?): Boolean {
      if (intent == null || intent.action != ACTION_STATUS) return false
      val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
      val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
      when (status) {
        PackageInstaller.STATUS_PENDING_USER_ACTION -> {
          @Suppress("DEPRECATION")
          val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_INTENT)
          if (confirm != null) {
            try {
              activity.startActivity(confirm)
              current?.get()?.emit("confirm", null)
            } catch (t: Throwable) {
              current?.get()?.emit("failed", t.message ?: "Android's installer did not open")
            }
          } else current?.get()?.emit("failed", "Android's installer did not open")
        }
        PackageInstaller.STATUS_SUCCESS -> current?.get()?.emit("installed", null)
        PackageInstaller.STATUS_FAILURE_ABORTED -> current?.get()?.emit("aborted", msg)
        PackageInstaller.STATUS_FAILURE_STORAGE -> current?.get()?.emit("storage", msg)
        else -> current?.get()?.emit("failed", msg ?: "Android did not install it (status $status)")
      }
      // (not the screen's own intent: Linking's initial link stays whatever opened the app)
      return true
    }
  }
}
