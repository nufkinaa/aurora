package com.auroratv.phone

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.auroratv.R
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Saving a copy ONTO THE PHONE, in parts that survive anything (offline-phone, 2026-11-11).
 *
 * It replaces Android's DownloadManager for new saves, because a save must PAUSE and carry on
 * from where it was (DownloadManager can only throw a save away): the bytes go into
 * `<name>.part` beside the film; a pause, a dropped line, a server restart or the app being
 * closed leaves that part where it is, and the next start asks the server for the rest
 * (`Range: bytes=<what is here>-` with `If-Range: <the copy's ETag>` — the server's
 * /offline/file/:id keeps one ETag for the life of a copy; an answer of 200 instead of 206
 * means the copy changed, so it starts again from nothing). A finished part becomes the film.
 *
 * One save at a time (the website's rule: the first one is watchable sooner); the rest wait
 * for their turn. A line that drops is tried again by itself ("Waiting for the connection"),
 * for up to 15 minutes without a byte landing — then the save rests as paused and carries on
 * the next time Aurora is open with a connection. Wi-Fi only (Settings) waits for Wi-Fi.
 *
 * While anything saves, a foreground service (OfflineSaveService) keeps the process alive with
 * the app in the background, and shows the progress in the notification shade. Nothing here
 * ever deletes a finished copy: only stop() throws away an UNFINISHED part, when the person
 * cancels.
 *
 * Phone build only (OfflineModule, PhonePackage).
 */
object OfflineSaver {
  private const val TAG = "AuroraSaver"
  const val CHANNEL_ID = "aurora_saves"
  const val NOTE_ID = 7301
  private const val GIVE_UP_MS = 15 * 60 * 1000L
  private const val CHUNK = 256 * 1024

  class Job(
    val key: String,
    @Volatile var url: String,
    @Volatile var headers: Map<String, String>,
    val file: File,
    @Volatile var title: String,
    @Volatile var wifiOnly: Boolean,
    val order: Long,
  ) {
    val part: File get() = File(file.parentFile, file.name + ".part")
    /** queued | running | retrying | wifi | paused | done | failed */
    @Volatile var state: String = "queued"
    /** "you" (the person pressed Pause) | "offline" (no line for long: carries on next time) | null */
    @Volatile var pausedBy: String? = null
    @Volatile var bytes: Long = 0
    @Volatile var total: Long = 0
    @Volatile var error: String? = null
    @Volatile var etag: String? = null
    @Volatile var speed: Double = 0.0
  }

  private val jobs = ConcurrentHashMap<String, Job>()
  private val lock = Object()
  @Volatile private var worker: Thread? = null
  @Volatile private var appCtx: Context? = null
  @Volatile private var netWatch = false
  private var seq = 0L

  /** Start (or carry on) a save. A finished file is left alone and reported done. */
  fun start(ctx: Context, key: String, url: String, headers: Map<String, String>, file: File, title: String, wifiOnly: Boolean): Job {
    appCtx = ctx.applicationContext
    val was = jobs[key]
    val job = if (was != null && was.file.absolutePath == file.absolutePath) {
      was.url = url
      was.headers = headers
      was.title = title
      was.wifiOnly = wifiOnly
      was
    } else {
      Job(key, url, headers, file, title, wifiOnly, ++seq).also { jobs[key] = it }
    }
    if (file.exists() && file.length() > 0 && !job.part.exists()) {
      job.state = "done"
      job.bytes = file.length()
      job.total = file.length()
      return job
    }
    if (job.state != "running") {
      job.state = "queued"
      job.pausedBy = null
      job.error = null
      job.bytes = if (job.part.exists()) job.part.length() else 0
    }
    watchNetwork()
    kick()
    return job
  }

  /** The person's Pause: what is saved stays; nothing carries on until resume (start) is asked. */
  fun pause(key: String): Boolean {
    val j = jobs[key] ?: return false
    if (j.state == "done") return false
    j.pausedBy = "you"
    j.state = "paused"
    synchronized(lock) { lock.notifyAll() }
    return true
  }

  /** Cancel: the save stops and its unfinished part is thrown away (a finished film is never touched here). */
  fun stop(key: String): Boolean {
    val j = jobs.remove(key) ?: return false
    j.pausedBy = "you"
    j.state = "paused"
    synchronized(lock) { lock.notifyAll() }
    // the worker lets go of the part within one chunk; delete it once it has
    Thread {
      for (i in 0 until 40) {
        if (worker == null || current != j) break
        Thread.sleep(50)
      }
      try { j.part.delete() } catch (_: Throwable) {}
    }.start()
    return true
  }

  fun status(key: String): Job? = jobs[key]

  /** What is left over from a save this run does not know (a part on disk): its size. */
  fun partSize(file: File): Long = File(file.parentFile, file.name + ".part").let { if (it.exists()) it.length() else 0L }

  @Volatile private var current: Job? = null
  fun active(): Job? = current
  fun pending(): List<Job> = jobs.values.filter { it.state == "queued" || it.state == "running" || it.state == "retrying" }.sortedBy { it.order }

  private fun kick() {
    synchronized(lock) {
      lock.notifyAll()
      if (worker?.isAlive == true) return
      worker = Thread({ loop() }, "aurora-saver").also { it.isDaemon = true; it.start() }
    }
    OfflineSaveService.ensure(appCtx ?: return)
  }

  private fun network(): String {
    val ctx = appCtx ?: return "other"
    return try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.getNetworkCapabilities(cm.activeNetwork)
      when {
        caps == null -> "none"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        else -> "other"
      }
    } catch (_: Throwable) {
      "other"
    }
  }

  /** The line changed: whatever waits for it is looked at again at once. */
  private fun watchNetwork() {
    if (netWatch) return
    val ctx = appCtx ?: return
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = wake()
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = wake()
      })
      netWatch = true
    } catch (t: Throwable) {
      Log.w(TAG, "no network callback: ${t.message}")
    }
  }

  private fun wake() {
    var any = false
    for (j in jobs.values) if (j.state == "wifi" && (!j.wifiOnly || network() == "wifi")) {
      j.state = "queued"
      any = true
    }
    if (any || jobs.values.any { it.state == "retrying" }) {
      synchronized(lock) { lock.notifyAll() }
      if (any) kick()
    }
  }

  private fun next(): Job? = jobs.values.filter { it.state == "queued" || it.state == "retrying" }.minByOrNull { it.order }

  private fun loop() {
    try {
      while (true) {
        val j = next()
        if (j == null) {
          current = null
          OfflineSaveService.update(appCtx)
          synchronized(lock) {
            if (next() == null) {
              worker = null
              OfflineSaveService.done(appCtx)
              return
            }
          }
          continue
        }
        current = j
        if (j.wifiOnly && network() != "wifi") {
          j.state = "wifi"
          continue
        }
        run(j)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "saver stopped: ${t.message}")
      worker = null
      current = null
      OfflineSaveService.done(appCtx)
    }
  }

  private fun halted(j: Job) = j.state == "paused" || jobs[j.key] !== j

  /** One save, through to done, failed, paused, or "waiting for Wi-Fi". */
  private fun run(j: Job) {
    var lastByteAt = System.currentTimeMillis()
    var backoff = 2000L
    while (!halted(j)) {
      if (j.wifiOnly && network() != "wifi") {
        j.state = "wifi"
        return
      }
      j.state = if (j.state == "retrying") "retrying" else "running"
      OfflineSaveService.update(appCtx)
      try {
        if (fetch(j)) {
          if (halted(j)) return
          if (!j.part.renameTo(j.file)) throw IOException("could not finish the file on this phone")
          j.state = "done"
          j.bytes = j.file.length()
          j.total = j.bytes
          current = null
          OfflineSaveService.update(appCtx)
          return
        }
        if (halted(j)) return
        lastByteAt = System.currentTimeMillis()
        backoff = 2000L
      } catch (e: Refused) {
        j.state = "failed"
        j.error = e.message
        return
      } catch (e: IOException) {
        if (halted(j)) return
        if (j.bytes > 0 && j.state == "running") lastByteAt = System.currentTimeMillis()
        val roomLeft = try { j.file.parentFile?.usableSpace ?: Long.MAX_VALUE } catch (_: Throwable) { Long.MAX_VALUE }
        if (roomLeft < 8L * 1024 * 1024) {
          j.state = "failed"
          j.error = "this phone ran out of room for it — free some space, or pick a smaller size"
          return
        }
        j.state = "retrying"
        j.speed = 0.0
        OfflineSaveService.update(appCtx)
        if (System.currentTimeMillis() - lastByteAt > GIVE_UP_MS) {
          j.state = "paused"
          j.pausedBy = "offline"
          return
        }
        synchronized(lock) { lock.wait(backoff) }
        backoff = (backoff * 2).coerceAtMost(30000L)
      }
    }
  }

  private class Refused(msg: String) : IOException(msg)

  /** Bytes from the server into the part. True when the whole file is here. */
  private fun fetch(j: Job): Boolean {
    val have = if (j.part.exists()) j.part.length() else 0L
    val con = URL(j.url).openConnection() as HttpURLConnection
    con.connectTimeout = 15000
    con.readTimeout = 30000
    con.instanceFollowRedirects = true
    for ((k, v) in j.headers) con.setRequestProperty(k, v)
    if (have > 0) {
      con.setRequestProperty("Range", "bytes=$have-")
      j.etag?.let { con.setRequestProperty("If-Range", it) }
    }
    try {
      val code = con.responseCode
      if (code == 416 && have > 0) {
        // asked past the end: the part is the whole file, or the copy changed — the length says which
        val total = con.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: -1L
        if (total == have) {
          j.total = have
          j.bytes = have
          return true
        }
        j.part.delete()
        j.bytes = 0
        throw IOException("the server's copy changed — starting again")
      }
      if (code == 401 || code == 403) throw Refused("the server said no (it may need you signed in again)")
      if (code == 404) throw Refused("the server's copy is not there any more — Retry makes it again")
      if (code !in 200..299) throw IOException("the server answered $code")
      val partial = code == 206
      con.getHeaderField("ETag")?.let { j.etag = it }
      val len = con.contentLengthLong
      val from = if (partial) have else 0L
      j.total = if (partial) {
        con.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: (if (len > 0) have + len else 0L)
      } else if (len > 0) len else 0L
      j.bytes = from
      FileOutputStream(j.part, partial).use { out ->
        if (!partial) out.channel.truncate(0)
        con.inputStream.use { input ->
          val buf = ByteArray(CHUNK)
          var t0 = System.currentTimeMillis()
          var b0 = j.bytes
          while (true) {
            if (halted(j)) return false
            if (j.wifiOnly && network() != "wifi") {
              j.state = "wifi"
              return false
            }
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            j.bytes += n
            if (j.state == "retrying") j.state = "running"
            val now = System.currentTimeMillis()
            if (now - t0 >= 1000) {
              j.speed = (j.bytes - b0) * 1000.0 / (now - t0)
              t0 = now
              b0 = j.bytes
              OfflineSaveService.update(appCtx)
            }
          }
        }
      }
      if (j.total > 0 && j.bytes < j.total) throw IOException("the line dropped")
      return true
    } finally {
      try { con.disconnect() } catch (_: Throwable) {}
    }
  }
}

/**
 * Keeps a save going with the app in the background, and says how far it is in the
 * notification shade ("Saving to this device · 42%"). Started by OfflineSaver; stops itself
 * when nothing is left to save. A tap opens Aurora at "On this device".
 */
class OfflineSaveService : Service() {
  companion object {
    @Volatile private var running: OfflineSaveService? = null

    fun ensure(ctx: Context) {
      if (running != null) return update(ctx)
      try {
        val i = Intent(ctx, OfflineSaveService::class.java)
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
      } catch (t: Throwable) {
        // (Android refuses a foreground service started from the background: the save runs
        // while the app's process lives, and carries on the next time Aurora is opened)
        Log.w("AuroraSaver", "no foreground service: ${t.message}")
      }
    }

    fun update(ctx: Context?) {
      val s = running ?: return
      try {
        (s.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(OfflineSaver.NOTE_ID, s.note())
      } catch (_: Throwable) {}
    }

    fun done(ctx: Context?) {
      val s = running ?: return
      try {
        if (Build.VERSION.SDK_INT >= 24) s.stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") s.stopForeground(true)
      } catch (_: Throwable) {}
      s.stopSelf()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    channel()
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(OfflineSaver.NOTE_ID, note(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else startForeground(OfflineSaver.NOTE_ID, note())
    } catch (t: Throwable) {
      Log.w("AuroraSaver", "startForeground: ${t.message}")
    }
    if (OfflineSaver.pending().isEmpty() && OfflineSaver.active() == null) done(this)
    return START_NOT_STICKY
  }

  /** Android 15+: a data-sync service has six hours a day. What is left rests, and carries on next time. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    for (j in OfflineSaver.pending()) {
      j.pausedBy = "offline"
      j.state = "paused"
    }
    done(this)
  }

  override fun onDestroy() {
    if (running === this) running = null
    super.onDestroy()
  }

  private fun channel() {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(OfflineSaver.CHANNEL_ID) != null) return
    val ch = NotificationChannel(OfflineSaver.CHANNEL_ID, "Saving to this device", NotificationManager.IMPORTANCE_LOW)
    ch.description = "How far a film or an episode is on its way onto this phone"
    ch.setShowBadge(false)
    nm.createNotificationChannel(ch)
  }

  fun note(): android.app.Notification {
    channel()
    val j = OfflineSaver.active() ?: OfflineSaver.pending().firstOrNull()
    val left = OfflineSaver.pending().size
    val pct = if (j != null && j.total > 0) ((j.bytes * 100) / j.total).toInt() else 0
    val text = when {
      j == null -> "Saving to this device"
      j.state == "retrying" -> "Waiting for the connection · $pct% — it carries on by itself"
      j.total > 0 -> "Saving to this device · $pct%" + (if (left > 1) " · ${left - 1} more waiting" else "")
      else -> "Saving to this device"
    }
    val open = PendingIntent.getActivity(
      this, 7301,
      Intent(Intent.ACTION_VIEW, Uri.parse("aurora-phone://saved")).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, OfflineSaver.CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle(j?.title ?: "Aurora")
      .setContentText(text)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(open)
      .setProgress(100, pct, j == null || j.total <= 0)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .build()
  }
}
