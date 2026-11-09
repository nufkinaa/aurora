package com.auroratv

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.PowerManager
import android.provider.Settings
import android.view.KeyEvent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import kotlin.math.roundToInt

/**
 * "AuroraRemote": what the phone remote needs from the TV itself (src/remote/native.ts).
 *
 *  - pressKey(name): a real key press (down + up) into MainActivity — up / down / left / right /
 *    ok / back — through the same path as the remote in the hand (MainActivity.injectRemoteKey
 *    has the why);
 *  - the TV's own volume, AudioManager STREAM_MUSIC: getVolume() → {supported, level 0..1,
 *    muted}; setVolume(level), stepVolume(±1), setMuted(on) — each shows the system's volume UI
 *    (FLAG_SHOW_UI), as the volume keys do, and answers with the new volume. `supported` is
 *    false on a box whose volume is fixed (HDMI out, the TV's own remote sets it);
 *  - deviceName(): the name the system gives the TV (Settings → Device name), else the model;
 *  - bringToFront(): Aurora to the front when the TV is showing something else;
 *  - wake(): the screen on — "Play on TV" on a TV showing its screensaver (a dream). A short
 *    wake lock with ACQUIRE_CAUSES_WAKEUP makes the power manager wake the device, and waking
 *    ends a dream; Aurora, which the dream was drawn over, is in front again. Answers whether
 *    Aurora has the window focus within 1.5 s (waited for natively).
 */
class RemoteModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  private val WAKE_WAIT_MS = 1500L

  override fun getName() = "AuroraRemote"

  private val audio: AudioManager?
    get() = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  @ReactMethod
  fun pressKey(name: String, promise: Promise) {
    val code = when (name) {
      "up" -> KeyEvent.KEYCODE_DPAD_UP
      "down" -> KeyEvent.KEYCODE_DPAD_DOWN
      "left" -> KeyEvent.KEYCODE_DPAD_LEFT
      "right" -> KeyEvent.KEYCODE_DPAD_RIGHT
      "ok" -> KeyEvent.KEYCODE_DPAD_CENTER
      "back" -> KeyEvent.KEYCODE_BACK
      else -> {
        promise.resolve(false)
        return
      }
    }
    UiThreadUtil.runOnUiThread {
      val act = ctx.currentActivity as? MainActivity
      val done = try {
        act != null && !act.isFinishing && act.injectRemoteKey(code)
      } catch (_: Throwable) {
        false
      }
      promise.resolve(done)
    }
  }

  private fun volumeMap(): WritableMap {
    val m = Arguments.createMap()
    val am = audio
    if (am == null) {
      m.putBoolean("supported", false)
      m.putDouble("level", 0.0)
      m.putBoolean("muted", false)
      return m
    }
    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
    m.putBoolean("supported", !am.isVolumeFixed)
    m.putDouble("level", cur.toDouble() / max)
    m.putBoolean("muted", am.isStreamMute(AudioManager.STREAM_MUSIC))
    return m
  }

  @ReactMethod
  fun getVolume(promise: Promise) {
    try {
      promise.resolve(volumeMap())
    } catch (t: Throwable) {
      promise.reject("volume", t.message, t)
    }
  }

  @ReactMethod
  fun setVolume(level: Double, promise: Promise) {
    try {
      val am = audio
      if (am != null && !am.isVolumeFixed) {
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val idx = (level.coerceIn(0.0, 1.0) * max).roundToInt()
        am.setStreamVolume(AudioManager.STREAM_MUSIC, idx, AudioManager.FLAG_SHOW_UI)
      }
      promise.resolve(volumeMap())
    } catch (t: Throwable) {
      // (a Do Not Disturb policy can refuse a change: SecurityException)
      promise.reject("volume", t.message, t)
    }
  }

  @ReactMethod
  fun stepVolume(dir: Double, promise: Promise) {
    try {
      val am = audio
      if (am != null && !am.isVolumeFixed) {
        val how = if (dir >= 0) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, how, AudioManager.FLAG_SHOW_UI)
      }
      promise.resolve(volumeMap())
    } catch (t: Throwable) {
      promise.reject("volume", t.message, t)
    }
  }

  @ReactMethod
  fun setMuted(on: Boolean, promise: Promise) {
    try {
      val am = audio
      if (am != null && !am.isVolumeFixed) {
        // ADJUST_MUTE / ADJUST_UNMUTE: API 23+ (this app's floor is 24)
        val how = if (on) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, how, AudioManager.FLAG_SHOW_UI)
      }
      promise.resolve(volumeMap())
    } catch (t: Throwable) {
      promise.reject("volume", t.message, t)
    }
  }

  @ReactMethod
  fun deviceName(promise: Promise) {
    val name = try {
      // Settings.Global.DEVICE_NAME is "device_name" (the constant is API 25; this app runs from 24)
      Settings.Global.getString(ctx.contentResolver, "device_name")
    } catch (_: Throwable) {
      null
    }
    promise.resolve(if (!name.isNullOrBlank()) name.trim() else (Build.MODEL ?: ""))
  }

  /**
   * Aurora to the front (the TV shows another app, or its home screen). Android 10+ refuses an
   * activity start from an app in the background except in narrow cases — the "display over
   * other apps" permission (SYSTEM_ALERT_WINDOW, which the updater asks for) is one, a visible
   * window another — and says nothing when it refuses. So this answers only whether the start
   * was ASKED for; src/remote/open.ts then waits to see whether the app really came forward.
   */
  @Suppress("DEPRECATION")
  @ReactMethod
  fun wake(promise: Promise) {
    try {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (pm == null) {
        promise.resolve(false)
        return
      }
      // (SCREEN_BRIGHT is deprecated for keeping a screen on — FLAG_KEEP_SCREEN_ON is the way
      // for that — but it is still the lock ACQUIRE_CAUSES_WAKEUP works with)
      val lock = pm.newWakeLock(
        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
        "aurora:playontv",
      )
      lock.acquire(3000L)
      // The answer is whether Aurora is in front now — waited for HERE, on the main looper:
      // React Native's JS timers stand still while the app is in the background, so a wait in
      // JS never ends there (Mi TV 2026-11-09: the phone heard "didn't answer" instead of
      // "open it there"). A dream drawn over Aurora ends within a few hundred ms of the wake;
      // another app in front never gives Aurora the focus, and the answer is false.
      val handler = Handler(Looper.getMainLooper())
      val started = SystemClock.uptimeMillis()
      val poll = object : Runnable {
        override fun run() {
          val act = ctx.currentActivity
          val front = act != null && !act.isFinishing && act.hasWindowFocus()
          if (front) {
            promise.resolve(true)
          } else if (SystemClock.uptimeMillis() - started >= WAKE_WAIT_MS) {
            promise.resolve(false)
          } else {
            handler.postDelayed(this, 100L)
          }
        }
      }
      handler.postDelayed(poll, 100L)
    } catch (_: Throwable) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun bringToFront(promise: Promise) {
    // Android 10+ refuses an activity start from an app with no visible window
    // unless it may draw over other apps (SYSTEM_ALERT_WINDOW, which the updater
    // asks for). The start would be dropped without a word (Mi TV, Android 14:
    // "Background activity launch blocked ... BAL_BLOCK"), so say no at once and
    // let the phone tell its user to open Aurora on the TV.
    val act = ctx.currentActivity
    val visible = act != null && act.hasWindowFocus()
    if (!visible && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !Settings.canDrawOverlays(ctx)) {
      promise.resolve(false)
      return
    }
    try {
      val intent = Intent(ctx, MainActivity::class.java)
      intent.action = Intent.ACTION_MAIN
      intent.addCategory(Intent.CATEGORY_LAUNCHER)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (_: Throwable) {
      promise.resolve(false)
    }
  }
}
