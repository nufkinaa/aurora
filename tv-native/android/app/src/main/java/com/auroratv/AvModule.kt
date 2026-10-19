package com.auroratv

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecList
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Display
import android.view.WindowManager
import androidx.media3.common.AudioAttributes
import androidx.media3.common.Format
import androidx.media3.exoplayer.audio.AudioCapabilities
import com.auroratv.av.AvVocab
import com.auroratv.av.ModePick
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

/**
 * PICTURE AND SOUND ("AuroraAv", TV round 2026-10-19; tv-native/src/av.ts).
 *
 *  - getCapabilities(): what this box can play, for the server's play decision
 *    (src/media/playpath.js): its HARDWARE video decoders with their profiles,
 *    largest size and frame rate (MediaCodecList — software decoders are left
 *    out: a TV's cores do not keep up with them); the Dolby Vision profiles it
 *    decodes; what the screen shows as HDR (Display.HdrCapabilities); the audio
 *    it decodes (every decoder, software ones included — sound is cheap); the
 *    bitstreams the TV / soundbar takes as they are — asked of media3's own
 *    AudioCapabilities, so the answer IS the one ExoPlayer acts on when it
 *    decides to pass a track through; and the screen's modes.
 *  - matchFrameRate(fps, waitMs, settleMs): the screen to the mode that shows
 *    the film without judder (ModePick.kt), by the activity window's
 *    preferredDisplayModeId. WHY THAT AND NOT Surface.setFrameRate: on Android
 *    11+ ExoPlayer already calls Surface.setFrameRate(fps, FIXED_SOURCE,
 *    CHANGE_FRAME_RATE_ONLY_IF_SEAMLESS) on its own surface — and on an HDMI
 *    TV a refresh change is never seamless, so that alone never switches
 *    anything. CHANGE_FRAME_RATE_ALWAYS (Android 12+) would, but only through
 *    ExoPlayer's private surface and only when the system's "match content
 *    frame rate" setting allows it, and it switches whenever the player
 *    pleases — mid-start, after the picture is up. The window's preferred mode
 *    is asked for BEFORE the film is handed to the player; the promise
 *    resolves once the display says it changed (DisplayListener) plus
 *    `settleMs`, or after `waitMs` whatever happened: the blackout (1–3 s on
 *    most TVs) falls on the loading screen, never over the picture or the
 *    first words. One switch per film; none at all when the screen already
 *    shows the rate (30 on 60 Hz) or has no mode that fits.
 *  - restoreFrameRate(delayMs): no preferred mode again (the system's own),
 *    after `delayMs` — cancelled by a match asked meanwhile, so the next
 *    episode at the same rate does not blink twice.
 *  - setPassthrough(on): "Surround sound: Stereo only" — react-native-video's
 *    audio sink (patches/react-native-video+6.19.2.patch) reads this when it
 *    is built and, when off, gets the plain-stereo capabilities instead of
 *    the TV's.
 */
class AvModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraAv"

  private val main = Handler(Looper.getMainLooper())
  private val restore = Runnable { setPreferredMode(0) }

  // ------------------------------------------------------------ capabilities
  @ReactMethod
  fun getCapabilities(promise: Promise) {
    Thread({
      try {
        promise.resolve(readCaps())
      } catch (t: Throwable) {
        promise.reject("caps", t.message ?: t.toString(), t)
      }
    }, "aurora-av-caps").start()
  }

  private class VideoAcc {
    val profiles = sortedSetOf<String>()
    var maxW = 0
    var maxH = 0
    var maxFps = 0.0
    var maxLevel = 0
  }

  private fun readCaps(): WritableMap {
    val out = Arguments.createMap()
    out.putString("model", Build.MODEL ?: "")
    out.putInt("sdk", Build.VERSION.SDK_INT)

    val video = linkedMapOf<String, VideoAcc>()
    val dv = sortedSetOf<Int>()
    val audioDecode = sortedSetOf("pcm") // ExoPlayer plays raw PCM itself
    for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
      if (info.isEncoder) continue
      val name = info.name ?: ""
      if (name.lowercase().endsWith(".secure")) continue // for protected content only
      val hw = if (Build.VERSION.SDK_INT >= 29) info.isHardwareAccelerated else !AvVocab.softwareName(name)
      for (type in info.supportedTypes) {
        val mime = type.lowercase()
        AvVocab.AUDIO_MIME[mime]?.let { audioDecode.add(it) }
        if (!hw) continue
        val caps = try { info.getCapabilitiesForType(type) } catch (_: Throwable) { null } ?: continue
        if (mime == "video/dolby-vision") {
          for (pl in caps.profileLevels) AvVocab.dvProfile(pl.profile).takeIf { it >= 0 }?.let { dv.add(it) }
          continue
        }
        val codec = AvVocab.VIDEO_MIME[mime] ?: continue
        val acc = video.getOrPut(codec) { VideoAcc() }
        for (pl in caps.profileLevels) {
          AvVocab.profileName(codec, pl.profile)?.let { acc.profiles.add(it) }
          if (codec == "h264") acc.maxLevel = maxOf(acc.maxLevel, AvVocab.avcLevel(pl.level))
        }
        val vc = caps.videoCapabilities ?: continue
        acc.maxW = maxOf(acc.maxW, vc.supportedWidths.upper)
        acc.maxH = maxOf(acc.maxH, vc.supportedHeights.upper)
        try {
          if (vc.isSizeSupported(1920, 1080)) acc.maxFps = maxOf(acc.maxFps, vc.getSupportedFrameRatesFor(1920, 1080).upper)
        } catch (_: Throwable) {}
      }
    }
    val v = Arguments.createMap()
    for ((codec, acc) in video) {
      val m = Arguments.createMap()
      m.putArray("profiles", Arguments.fromList(acc.profiles.toList()))
      if (acc.maxW > 0) m.putInt("maxW", acc.maxW)
      if (acc.maxH > 0) m.putInt("maxH", acc.maxH)
      if (acc.maxFps > 0) m.putDouble("maxFps", minOf(acc.maxFps, 240.0))
      if (acc.maxLevel > 0) m.putInt("maxLevel", acc.maxLevel)
      v.putMap(codec, m)
    }
    out.putMap("video", v)
    out.putArray("dv", Arguments.fromList(dv.toList()))
    out.putArray("audioDecode", Arguments.fromList(audioDecode.toList()))

    // passthrough: ExoPlayer's own answer (DefaultAudioSink asks exactly this)
    val pass = mutableListOf<String>()
    var maxCh = 2
    try {
      val ac = AudioCapabilities.getCapabilities(ctx, AudioAttributes.DEFAULT, null)
      maxCh = ac.maxChannelCount
      for ((key, mc) in AvVocab.PASSTHROUGH) {
        val f = Format.Builder().setSampleMimeType(mc.first).setChannelCount(mc.second).setSampleRate(48000).build()
        if (ac.isPassthroughPlaybackSupported(f, AudioAttributes.DEFAULT)) pass.add(key)
      }
    } catch (_: Throwable) {}
    out.putArray("passthrough", Arguments.fromList(pass))
    out.putInt("maxChannels", maxCh)

    // the screen: what it shows as HDR, and its modes
    val display = displayOf()
    if (display != null) {
      val hdr = sortedSetOf<String>()
      try {
        @Suppress("DEPRECATION")
        display.hdrCapabilities?.supportedHdrTypes?.forEach { t -> AvVocab.hdrName(t)?.let { hdr.add(it) } }
      } catch (_: Throwable) {}
      if (Build.VERSION.SDK_INT >= 34) {
        try { display.mode.supportedHdrTypes.forEach { t -> AvVocab.hdrName(t)?.let { hdr.add(it) } } } catch (_: Throwable) {}
      }
      out.putArray("hdr", Arguments.fromList(hdr.toList()))
      val d = Arguments.createMap()
      val cur = display.mode
      d.putInt("w", cur.physicalWidth)
      d.putInt("h", cur.physicalHeight)
      d.putDouble("hz", Math.round(cur.refreshRate * 1000.0) / 1000.0)
      val modes = Arguments.createArray()
      for (m in display.supportedModes) {
        val row = Arguments.createArray()
        row.pushInt(m.physicalWidth)
        row.pushInt(m.physicalHeight)
        row.pushDouble(Math.round(m.refreshRate * 1000.0) / 1000.0)
        modes.pushArray(row)
      }
      d.putArray("modes", modes)
      out.putMap("display", d)
    }
    return out
  }

  @Suppress("DEPRECATION")
  private fun displayOf(): Display? {
    val act = ctx.currentActivity
    if (act != null) {
      if (Build.VERSION.SDK_INT >= 30) act.display?.let { return it }
      return act.windowManager.defaultDisplay
    }
    return (ctx.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(Display.DEFAULT_DISPLAY)
  }

  // ------------------------------------------------------------ the screen
  private fun setPreferredMode(id: Int) {
    val act = ctx.currentActivity ?: return
    try {
      val lp: WindowManager.LayoutParams = act.window.attributes
      if (lp.preferredDisplayModeId == id) return
      lp.preferredDisplayModeId = id
      act.window.attributes = lp
    } catch (_: Throwable) {}
  }

  private fun result(switched: Boolean, reason: String? = null): WritableMap =
    Arguments.createMap().apply {
      putBoolean("switched", switched)
      if (reason != null) putString("reason", reason)
    }

  @ReactMethod
  fun matchFrameRate(fps: Double, waitMs: Int, settleMs: Int, promise: Promise) {
    main.post {
      main.removeCallbacks(restore) // a next episode: no blink back and forth
      val act = ctx.currentActivity
      val display = displayOf()
      if (act == null || display == null) return@post promise.resolve(result(false, "no screen"))
      val cur = display.mode
      val now = ModePick.Mode(cur.modeId, cur.physicalWidth, cur.physicalHeight, cur.refreshRate)
      val modes = display.supportedModes.map { ModePick.Mode(it.modeId, it.physicalWidth, it.physicalHeight, it.refreshRate) }
      val pick = ModePick.choose(now, modes, fps.toFloat())
      if (pick == null) {
        val why = if (ModePick.fit(cur.refreshRate, fps.toFloat()) >= 0) "the screen already shows ${cur.refreshRate} Hz" else "no mode for $fps fps"
        return@post promise.resolve(result(false, why))
      }
      val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
      val t0 = SystemClock.uptimeMillis()
      var done = false
      lateinit var listener: DisplayManager.DisplayListener
      val finish = { timedOut: Boolean ->
        if (!done) {
          done = true
          try { dm.unregisterDisplayListener(listener) } catch (_: Throwable) {}
          val switchMs = SystemClock.uptimeMillis() - t0
          main.postDelayed({
            promise.resolve(result(true).apply {
              putDouble("fromHz", Math.round(cur.refreshRate * 1000.0) / 1000.0)
              putDouble("toHz", Math.round(pick.hz * 1000.0) / 1000.0)
              putDouble("ms", switchMs.toDouble())
              putBoolean("timedOut", timedOut)
            })
          }, if (timedOut) 0L else settleMs.toLong())
        }
      }
      listener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
          if (displayId == display.displayId && display.mode.modeId == pick.id) finish(false)
        }
      }
      dm.registerDisplayListener(listener, main)
      setPreferredMode(pick.id)
      main.postDelayed({ finish(true) }, waitMs.toLong().coerceIn(500L, 15000L))
    }
  }

  @ReactMethod
  fun restoreFrameRate(delayMs: Int) {
    main.post {
      main.removeCallbacks(restore)
      main.postDelayed(restore, delayMs.toLong().coerceIn(0L, 10000L))
    }
  }

  // ------------------------------------------------------------ the sound
  @ReactMethod
  fun setPassthrough(on: Boolean) {
    System.setProperty(PASSTHROUGH_PROP, if (on) "1" else "0")
  }

  companion object {
    /** Read by react-native-video's audio sink (the patch): "0" = plain stereo PCM only. */
    const val PASSTHROUGH_PROP = "aurora.audio.passthrough"
  }
}
