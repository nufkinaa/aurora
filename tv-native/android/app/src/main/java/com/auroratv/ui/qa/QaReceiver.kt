package com.auroratv.ui.qa

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import com.auroratv.BuildConfig
import com.auroratv.DeviceModule
import com.auroratv.ui.AuroraExp
import com.auroratv.ui.AuroraImpl
import com.facebook.react.R
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.security.MessageDigest

/**
 * `com.auroratv.QA` — the harness's door (tools/tv-pixel-diff/PROTOCOL.md, the contract;
 * 02-verification.md §2, the intent). Manifest-registered and exported, so an explicit
 * `am broadcast -n <pkg>/com.auroratv.ui.qa.QaReceiver` reaches it whether or not the
 * process is running, and guarded twice: it acts only when adb is enabled on the box AND
 * the intent's `token` is sha256(hex(sha256(signing cert))) — a wrong token is silence.
 *
 * Every accepted command answers with ONE logcat line, tag AuroraQA:
 *   [qa] <cmd> ok rid=<rid> <detail>   |   [qa] <cmd> err rid=<rid> <reason>
 */
class QaReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val app = context.applicationContext
    if (!adbEnabled(app)) return
    val token = intent.getStringExtra("token") ?: return
    if (!tokenMatches(app, token)) return

    val cmd = intent.getStringExtra("cmd")?.trim() ?: ""
    val arg = intent.getStringExtra("arg")?.trim() ?: ""
    val rid = intent.getStringExtra("rid")?.trim()?.takeIf { it.isNotEmpty() }
    AuroraQa.ensureLoaded(app)

    try {
      when (cmd) {
        "impl" -> cmdImpl(app, arg, rid)
        "exp" -> cmdExp(app, arg, rid)
        "freeze" -> cmdFreeze(app, arg, rid)
        "trace" -> cmdFlag(app, "trace", arg, rid)
        "focuslog" -> cmdFlag(app, "focuslog", arg, rid)
        "framestats" -> cmdFrameStats(rid)
        "layout" -> cmdLayout(app, arg, rid)
        "nav" -> cmdNav(app, arg, rid)
        "ping" -> ok("ping", rid, "v=${BuildConfig.VERSION_CODE} impl=${AuroraImpl.letters(AuroraImpl.read(app))} exp=${AuroraExp.tag(AuroraExp.read(app))}")
        else -> err(cmd.ifEmpty { "?" }, rid, "unknown")
      }
    } catch (t: Throwable) {
      err(cmd, rid, "exception ${t.javaClass.simpleName}: ${t.message}")
    }
  }

  // ---- commands --------------------------------------------------------------

  private fun cmdImpl(app: Context, arg: String, rid: String?) {
    val m = AuroraImpl.write(app, arg)
    if (m == null) err("impl", rid, "bad arg '$arg' (keys ${AuroraImpl.KEYS.joinToString("|")}|all = js|native)")
    else ok("impl", rid, AuroraImpl.format(m))
  }

  /** LAB: `exp "cull=1,flat=0"` / `exp none` — the rendering experiments (AuroraExp.kt); next launch. */
  private fun cmdExp(app: Context, arg: String, rid: String?) {
    val set = AuroraExp.write(app, arg)
    if (set == null) err("exp", rid, "bad arg '$arg' (none | key=0|1,… ; keys ${AuroraExp.KEYS.joinToString("|")})")
    else ok("exp", rid, AuroraExp.tag(set))
  }

  private fun cmdFreeze(app: Context, arg: String, rid: String?) {
    val parts = arg.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    val on = when (parts.firstOrNull()) {
      "on" -> true
      "off" -> false
      else -> {
        err("freeze", rid, "arg must be on|off|on,trailer|on,mid")
        return
      }
    }
    val extras = parts.drop(1)
    if (extras.any { it != "trailer" && it != "mid" }) {
      err("freeze", rid, "unsupported")
      return
    }
    AuroraQa.frozen = on
    AuroraQa.trailer = on && extras.contains("trailer")
    AuroraQa.mid = on && extras.contains("mid")
    AuroraQa.save(app)
    emit(app, "AuroraQa", Arguments.createMap().apply {
      putBoolean("frozen", AuroraQa.frozen)
      putBoolean("trailer", AuroraQa.trailer)
      putBoolean("mid", AuroraQa.mid)
    })
    ok("freeze", rid, "frozen=${b(AuroraQa.frozen)} trailer=${b(AuroraQa.trailer)} mid=${b(AuroraQa.mid)}")
  }

  private fun cmdFlag(app: Context, which: String, arg: String, rid: String?) {
    val on = when (arg) {
      "on" -> true
      "off" -> false
      else -> {
        err(which, rid, "arg must be on|off")
        return
      }
    }
    if (which == "trace") AuroraQa.trace = on else AuroraQa.focuslog = on
    AuroraQa.save(app)
    emit(app, "AuroraQaTrace", Arguments.createMap().apply {
      putBoolean("trace", AuroraQa.trace)
      putBoolean("focuslog", AuroraQa.focuslog)
    })
    ok(which, rid, "$which=${b(on)}")
  }

  private fun cmdFrameStats(rid: String?) {
    val snap = DeviceModule.qaSnapshot()
    if (snap == null) {
      err("framestats", rid, "no monitor")
      return
    }
    Log.i(TAG, "[frames] ${snap.first}")
    ok("framestats", rid, "frames=${snap.second}")
  }

  private fun cmdLayout(app: Context, arg: String, rid: String?) {
    if (arg.isEmpty()) {
      err("layout", rid, "arg must be a nativeId")
      return
    }
    val activity = currentActivity(app)
    val root = activity?.window?.decorView
    val v = if (root != null) findByNativeId(root, arg) else null
    if (v == null) {
      err("layout", rid, "notfound")
      return
    }
    val loc = IntArray(2)
    v.getLocationOnScreen(loc)
    ok("layout", rid, "x=${loc[0]} y=${loc[1]} w=${v.width} h=${v.height}")
  }

  private fun cmdNav(app: Context, arg: String, rid: String?) {
    if (arg.isEmpty()) {
      err("nav", rid, "arg must be a route")
      return
    }
    val ctx = reactContext(app)
    if (ctx == null) {
      err("nav", rid, "noreact")
      return
    }
    val key = rid ?: "nav-${System.nanoTime()}"
    val pending = goAsync()
    synchronized(navPending) { navPending[key] = NavPending(pending, rid) }
    main.postDelayed({
      val p = synchronized(navPending) { navPending.remove(key) } ?: return@postDelayed
      err("nav", p.rid, "timeout")
      p.result.finish()
    }, NAV_TIMEOUT_MS)
    emit(app, "qaNav", Arguments.createMap().apply {
      putString("target", arg)
      putString("rid", key)
    })
  }

  // ---- guards ----------------------------------------------------------------

  private fun adbEnabled(app: Context): Boolean =
    try {
      Settings.Global.getInt(app.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1
    } catch (_: Throwable) {
      false
    }

  private fun tokenMatches(app: Context, token: String): Boolean {
    val t = token.trim().lowercase()
    if (t.isEmpty()) return false
    if (BuildConfig.QA_TOKEN.isNotEmpty() && t == BuildConfig.QA_TOKEN.lowercase()) return true
    val expected = expectedToken(app) ?: return false
    return t == expected
  }

  // ---- helpers ---------------------------------------------------------------

  private fun reactContext(app: Context): ReactContext? =
    try {
      (app as? ReactApplication)?.reactHost?.currentReactContext
    } catch (_: Throwable) {
      null
    }

  private fun currentActivity(app: Context): Activity? = reactContext(app)?.currentActivity

  private fun emit(app: Context, name: String, body: Any) {
    try {
      reactContext(app)?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)?.emit(name, body)
    } catch (_: Throwable) {}
  }

  private fun findByNativeId(root: View, id: String): View? {
    if (root.getTag(R.id.view_tag_native_id) == id) return root
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        val hit = findByNativeId(root.getChildAt(i), id)
        if (hit != null) return hit
      }
    }
    return null
  }

  private class NavPending(val result: PendingResult, val rid: String?)

  companion object {
    const val ACTION = "com.auroratv.QA"
    const val TAG = "AuroraQA"
    private const val NAV_TIMEOUT_MS = 10_000L
    private val main = Handler(Looper.getMainLooper())
    private val navPending = HashMap<String, NavPending>()
    @Volatile private var cachedToken: String? = null

    fun ok(cmd: String, rid: String?, detail: String) = Log.i(TAG, line(cmd, "ok", rid, detail))
    fun err(cmd: String, rid: String?, detail: String) = Log.i(TAG, line(cmd, "err", rid, detail))
    private fun line(cmd: String, status: String, rid: String?, detail: String) =
      "[qa] $cmd $status" + (if (rid != null) " rid=$rid" else "") + (if (detail.isNotEmpty()) " $detail" else "")
    private fun b(v: Boolean) = if (v) "1" else "0"

    /** navigation.tsx reports the dispatched route (via AuroraQaModule.navDone). */
    fun navDone(rid: String, route: String) {
      val p = synchronized(navPending) { navPending.remove(rid) } ?: return
      if (route.startsWith("err ")) err("nav", p.rid, route.substring(4)) else ok("nav", p.rid, "route=$route")
      try {
        p.result.finish()
      } catch (_: Throwable) {}
    }

    /** sha256(hex(sha256(cert DER))) of the app's own signing certificate, lower-case hex. */
    fun expectedToken(app: Context): String? {
      cachedToken?.let { return it }
      return try {
        val pm = app.packageManager
        val cert: ByteArray = if (Build.VERSION.SDK_INT >= 28) {
          val info = pm.getPackageInfo(app.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
          val si = info.signingInfo ?: return null
          val sigs = if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
          sigs.firstOrNull()?.toByteArray() ?: return null
        } else {
          @Suppress("DEPRECATION")
          val info = pm.getPackageInfo(app.packageName, PackageManager.GET_SIGNATURES)
          @Suppress("DEPRECATION")
          info.signatures?.firstOrNull()?.toByteArray() ?: return null
        }
        val fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(cert))
        val token = hex(MessageDigest.getInstance("SHA-256").digest(fingerprint.toByteArray(Charsets.US_ASCII)))
        cachedToken = token
        token
      } catch (_: Throwable) {
        null
      }
    }

    private fun hex(bytes: ByteArray): String {
      val sb = StringBuilder(bytes.size * 2)
      for (b in bytes) sb.append(String.format("%02x", b.toInt() and 0xff))
      return sb.toString()
    }
  }
}
