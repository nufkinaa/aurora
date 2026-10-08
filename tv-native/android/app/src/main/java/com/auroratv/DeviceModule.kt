package com.auroratv

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES20
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Window
import androidx.metrics.performance.FrameData
import androidx.metrics.performance.FrameDataApi31
import androidx.metrics.performance.JankStats
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * What this box is, and how it is coping (perfTier.ts reads it).
 *
 *  - constants: isLowRamDevice, totalMem, memoryClass, largeMemoryClass, SDK_INT, model and
 *    manufacturer — all answered by the framework from local state, so they cost nothing at
 *    startup;
 *  - glRenderer(): the GPU's GL_RENDERER string, read once from a throwaway 1x1 pbuffer EGL
 *    context on a background thread and kept in shared preferences against the build
 *    fingerprint (so it is probed once per firmware, not per launch);
 *  - `AuroraTrimMemory` events: the system's onTrimMemory level, so JS can drop what it holds;
 *  - clearMemoryCaches(): Fresco's decoded-bitmap caches (in-use pictures stay; only what no
 *    view is drawing is dropped);
 *  - a frame monitor: androidx JankStats on the activity's window. Every drawn frame's
 *    duration — the whole frame including the GPU on Android 12+ (FrameDataApi31), the UI
 *    thread's part before that — goes into a per-screen histogram, tagged with the screen JS
 *    says is showing. takeFrameStats() hands back p50 / p90 / jank% per screen and starts
 *    over. This replaces timing requestAnimationFrame on the JS thread, which never saw the
 *    binder or GPU stalls that make a TV feel slow;
 *  - dropWindowBackground()/restoreWindowBackground(): the window's own background fill, a
 *    full-screen layer under an app that paints an opaque canvas of its own (Ambient.tsx).
 */
class DeviceModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), ComponentCallbacks2, LifecycleEventListener {

  override fun getName() = "AuroraDevice"

  private val main = Handler(Looper.getMainLooper())

  init {
    ctx.applicationContext.registerComponentCallbacks(this)
    ctx.addLifecycleEventListener(this)
  }

  override fun invalidate() {
    try {
      ctx.applicationContext.unregisterComponentCallbacks(this)
    } catch (_: Throwable) {}
    ctx.removeLifecycleEventListener(this)
    main.post { stopMonitor() }
    super.invalidate()
  }

  override fun getConstants(): Map<String, Any> {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    return mapOf(
        "isLowRamDevice" to am.isLowRamDevice,
        "totalMem" to mi.totalMem.toDouble(),
        "memoryClass" to am.memoryClass,
        "largeMemoryClass" to am.largeMemoryClass,
        "sdkInt" to Build.VERSION.SDK_INT,
        "model" to (Build.MODEL ?: ""),
        "manufacturer" to (Build.MANUFACTURER ?: ""),
    )
  }

  // ---- GPU name -----------------------------------------------------------

  @ReactMethod
  fun glRenderer(promise: Promise) {
    val prefs = ctx.getSharedPreferences("aurora_device", Context.MODE_PRIVATE)
    val key = "gl@" + (Build.FINGERPRINT ?: "")
    prefs.getString(key, null)?.let {
      promise.resolve(it)
      return
    }
    Thread {
          val name = try {
            probeRenderer()
          } catch (_: Throwable) {
            ""
          }
          if (name.isNotEmpty()) prefs.edit().putString(key, name).apply()
          promise.resolve(name)
        }
        .apply { name = "AuroraGlProbe" }
        .start()
  }

  private fun probeRenderer(): String {
    val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    if (display == EGL14.EGL_NO_DISPLAY) return ""
    val version = IntArray(2)
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) return ""
    // (eglTerminate is deliberately NOT called: the display is per process and shared
    // with the app's own renderer, which must not be torn down.)
    val attribs = intArrayOf(
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
        EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_NONE)
    val configs = arrayOfNulls<EGLConfig>(1)
    val n = IntArray(1)
    if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, n, 0) || n[0] < 1) return ""
    val context = EGL14.eglCreateContext(
        display, configs[0], EGL14.EGL_NO_CONTEXT,
        intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
    if (context == EGL14.EGL_NO_CONTEXT) return ""
    val surface = EGL14.eglCreatePbufferSurface(
        display, configs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
    try {
      if (!EGL14.eglMakeCurrent(display, surface, surface, context)) return ""
      return GLES20.glGetString(GLES20.GL_RENDERER) ?: ""
    } finally {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
      EGL14.eglDestroyContext(display, context)
    }
  }

  // ---- memory -------------------------------------------------------------

  @ReactMethod
  fun clearMemoryCaches() {
    try {
      if (Fresco.hasBeenInitialized()) Fresco.getImagePipeline().clearMemoryCaches()
    } catch (_: Throwable) {}
  }

  override fun onTrimMemory(level: Int) {
    if (!ctx.hasActiveReactInstance()) return
    val map = Arguments.createMap()
    map.putInt("level", level)
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("AuroraTrimMemory", map)
    } catch (_: Throwable) {}
  }

  override fun onConfigurationChanged(newConfig: Configuration) {}

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onLowMemory() = onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)

  // ---- the window's background --------------------------------------------

  @ReactMethod
  fun dropWindowBackground() {
    main.post {
      try {
        ctx.currentActivity?.window?.setBackgroundDrawable(null)
      } catch (_: Throwable) {}
    }
  }

  @ReactMethod
  fun restoreWindowBackground() {
    main.post {
      try {
        val activity = ctx.currentActivity ?: return@post
        val a = activity.theme.obtainStyledAttributes(intArrayOf(android.R.attr.windowBackground))
        val d = a.getDrawable(0)
        a.recycle()
        if (d != null) activity.window.setBackgroundDrawable(d)
      } catch (_: Throwable) {}
    }
  }

  // ---- frame monitor (JankStats) ------------------------------------------

  // One histogram per screen: 1 ms buckets up to 250 ms, then one overflow bucket.
  private class Histogram {
    val buckets = IntArray(252)
    var frames = 0
    var janky = 0

    fun add(ms: Double, jank: Boolean) {
      buckets[ms.toInt().coerceIn(0, 251)]++
      frames++
      if (jank) janky++
    }

    fun pct(p: Double): Int {
      if (frames == 0) return 0
      val target = Math.ceil(frames * p).toInt().coerceAtLeast(1)
      var seen = 0
      for (i in buckets.indices) {
        seen += buckets[i]
        if (seen >= target) return i
      }
      return 251
    }
  }

  private var jank: JankStats? = null
  private var window: Window? = null
  @Volatile private var screen = "boot"
  // Written from JankStats' delivery thread, read from the main thread: guarded by itself.
  private val stats = HashMap<String, Histogram>()

  private val listener =
      JankStats.OnFrameListener { fd: FrameData ->
        val nanos = if (fd is FrameDataApi31) fd.frameDurationTotalNanos else fd.frameDurationUiNanos
        synchronized(stats) { stats.getOrPut(screen) { Histogram() }.add(nanos / 1_000_000.0, fd.isJank) }
      }

  private fun stopMonitor() {
    jank?.isTrackingEnabled = false
    jank = null
  }

  private fun ensureMonitor() {
    val w = ctx.currentActivity?.window ?: return
    if (jank != null && window === w) {
      jank?.isTrackingEnabled = true
      return
    }
    stopMonitor()
    try {
      jank = JankStats.createAndTrack(w, listener)
      window = w
    } catch (_: Throwable) {
      jank = null
    }
  }

  /** Start (or resume) counting frames, tagged with `name` from now on. */
  @ReactMethod
  fun setFrameScreen(name: String) {
    main.post {
      screen = name.take(24)
      ensureMonitor()
    }
  }

  /** p50 / p90 (ms) and jank% per screen since the last call; resets the counts. */
  @ReactMethod
  fun takeFrameStats(promise: Promise) {
    main.post {
      val out = Arguments.createMap()
      val snapshot = synchronized(stats) { HashMap(stats).also { stats.clear() } }
      for ((name, h) in snapshot) {
        if (h.frames == 0) continue
        val m = Arguments.createMap()
        m.putInt("frames", h.frames)
        m.putInt("p50", h.pct(0.5))
        m.putInt("p90", h.pct(0.9))
        m.putDouble("jank", Math.round(h.janky * 1000.0 / h.frames) / 10.0)
        out.putMap(name, m)
      }
      promise.resolve(out)
    }
  }

  override fun onHostResume() {
    main.post { if (window != null) ensureMonitor() }
  }

  override fun onHostPause() {
    main.post { jank?.isTrackingEnabled = false }
  }

  override fun onHostDestroy() {
    main.post { stopMonitor() }
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
