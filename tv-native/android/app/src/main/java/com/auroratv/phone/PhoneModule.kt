package com.auroratv.phone

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.pm.ActivityInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * "AuroraPhone" — what the phone app asks of its window and the device (src/phone/native.ts).
 * Registered only in the phone build (MainApplication: BuildConfig.PHONE); the TV never sees it.
 *
 *  - picture-in-picture: setPip(on, w, h) while a film plays (auto-enter on Android 12+,
 *    onUserLeaveHint before that), enterPip() on demand, `AuroraPip` {inPip} events;
 *  - the player's window: keepAwake, immersive (status + navigation bars hidden, a swipe from
 *    the edge shows them for a moment), brightness (this window only; -1 = the system's),
 *    orientation (auto / landscape / portrait);
 *  - the music stream's volume (the player's right-side swipe), and a haptic tick.
 */
class PhoneModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "AuroraPhone"

  init {
    current = WeakReference(this)
  }

  private val main = Handler(Looper.getMainLooper())

  private fun onUi(block: (Activity) -> Unit) {
    val act = ctx.currentActivity ?: activity?.get() ?: return
    main.post {
      try {
        block(act)
      } catch (_: Throwable) {}
    }
  }

  private fun audio() = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun getConstants(): MutableMap<String, Any> = hashMapOf(
      "sdk" to Build.VERSION.SDK_INT,
      "pipSupported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          ctx.packageManager.hasSystemFeature("android.software.picture_in_picture")),
  )

  // ---------------- picture-in-picture ----------------

  @ReactMethod
  fun setPip(on: Boolean, width: Double, height: Double) {
    pipWanted = on
    pipAspect = aspect(width, height)
    onUi { applyPipParams(it) }
  }

  @ReactMethod
  fun enterPip(promise: Promise) {
    val act = ctx.currentActivity ?: activity?.get()
    if (act == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }
    main.post {
      try {
        promise.resolve(act.enterPictureInPictureMode(params()))
      } catch (t: Throwable) {
        promise.resolve(false)
      }
    }
  }

  @ReactMethod
  fun isInPip(promise: Promise) {
    val act = ctx.currentActivity ?: activity?.get()
    promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && act?.isInPictureInPictureMode == true)
  }

  // ---------------- the player's window ----------------

  @ReactMethod
  fun setKeepAwake(on: Boolean) = onUi {
    if (on) it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else it.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  @ReactMethod
  fun setImmersive(on: Boolean) = onUi {
    val c = WindowCompat.getInsetsController(it.window, it.window.decorView)
    if (on) {
      c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      c.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      c.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  /** 0..1 for this window, or a negative number for "whatever the system says". */
  @ReactMethod
  fun setBrightness(value: Double) = onUi {
    val lp = it.window.attributes
    lp.screenBrightness = if (value < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        else value.toFloat().coerceIn(0.01f, 1f)
    it.window.attributes = lp
  }

  /** This window's brightness, or the system's (0..1) when the window has not set one. */
  @ReactMethod
  fun getBrightness(promise: Promise) {
    val act = ctx.currentActivity
    val own = act?.window?.attributes?.screenBrightness ?: -1f
    if (own >= 0) {
      promise.resolve(own.toDouble())
      return
    }
    val sys = try {
      android.provider.Settings.System.getInt(ctx.contentResolver, android.provider.Settings.System.SCREEN_BRIGHTNESS)
    } catch (_: Throwable) {
      128
    }
    promise.resolve((sys / 255.0).coerceIn(0.0, 1.0))
  }

  /** "auto" (follow the phone, the person's rotation lock honoured), "landscape", "portrait". */
  @ReactMethod
  fun setOrientation(mode: String) = onUi {
    it.requestedOrientation = when (mode) {
      "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      else -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    }
  }

  @ReactMethod
  fun getVolume(promise: Promise) {
    val a = audio()
    val max = a.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    promise.resolve(a.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max)
  }

  /** 0..1 of the music stream; no system slider is shown (the player draws its own). */
  @ReactMethod
  fun setVolume(value: Double) {
    val a = audio()
    val max = a.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    val v = Math.round(value.coerceIn(0.0, 1.0) * max).toInt()
    try {
      a.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0)
    } catch (_: Throwable) {}
  }

  @ReactMethod
  fun haptic(kind: String) = onUi {
    val c = when (kind) {
      "long" -> HapticFeedbackConstants.LONG_PRESS
      "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      else -> if (Build.VERSION.SDK_INT >= 27) HapticFeedbackConstants.KEYBOARD_TAP else HapticFeedbackConstants.VIRTUAL_KEY
    }
    it.window.decorView.performHapticFeedback(c)
  }

  // RN's NativeEventEmitter wants these two on Android
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") name: String) {}
  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  private fun emitPip(inPip: Boolean) {
    try {
      val m = Arguments.createMap()
      m.putBoolean("inPip", inPip)
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("AuroraPip", m)
    } catch (_: Throwable) {}
  }

  companion object {
    private var current: WeakReference<PhoneModule>? = null
    private var activity: WeakReference<Activity>? = null
    @Volatile private var pipWanted = false
    @Volatile private var pipAspect: Rational = Rational(16, 9)

    /** PiP's limits are 1:2.39 .. 2.39:1; anything else is clamped into them. */
    private fun aspect(w: Double, h: Double): Rational {
      if (!(w > 0 && h > 0)) return Rational(16, 9)
      val r = (w / h).coerceIn(1 / 2.39 + 0.001, 2.39 - 0.001)
      return Rational((r * 1000).toInt(), 1000)
    }

    private fun params(): PictureInPictureParams {
      val b = PictureInPictureParams.Builder().setAspectRatio(pipAspect)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        b.setAutoEnterEnabled(pipWanted)
        b.setSeamlessResizeEnabled(true)
      }
      return b.build()
    }

    private fun applyPipParams(act: Activity) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      try {
        act.setPictureInPictureParams(params())
      } catch (_: Throwable) {}
    }

    fun attach(act: Activity) {
      activity = WeakReference(act)
    }

    fun detach(act: Activity) {
      if (activity?.get() === act) activity = null
    }

    /** Android 8–11: no auto-enter, so going Home while a film plays enters PiP here. */
    fun onUserLeaveHint(act: Activity) {
      if (!pipWanted || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
      try {
        act.enterPictureInPictureMode(params())
      } catch (_: Throwable) {}
    }

    fun onPipChanged(inPip: Boolean) {
      current?.get()?.emitPip(inPip)
    }
  }
}
