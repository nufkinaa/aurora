package com.auroratv.audio

import android.media.audiofx.DynamicsProcessing
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.util.Util
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioSink
import com.brentvatne.exoplayer.RNVExoplayerPlugin
import com.brentvatne.react.ReactNativeVideoManager

/**
 * NIGHT MODE and DIALOGUE BOOST on the TV: Android's DynamicsProcessing effect (Android 9+)
 * on the player's own audio session. react-native-video hands every ExoPlayer it makes to
 * its plugins (RNVExoplayerPlugin.onInstanceCreated) — no patch of the library: this object
 * is one, registered once at start-up (MainApplication.onCreate → install()).
 *
 *  - The effect is created the first time a switch is on for a player, and then stays: off
 *    is its neutral values (AudioFxCurve), and every change is a 200 ms glide in ten steps.
 *  - The stages: pre-EQ (four bands: the dialogue boost), one full-band compressor (night
 *    mode), the limiter, and per-channel input gain (the centre, when the PCM is
 *    multichannel). Post-EQ is not used.
 *  - PASSTHROUGH: when ExoPlayer opens its AudioTrack for a bitstream (AC-3 / E-AC-3 / DTS
 *    sent as it is to the TV or a receiver) or in offload, no app effect applies — the
 *    AudioTrackConfig says so (onAudioTrackInitialized). The status then reads
 *    passthrough = true and the JS greys the switches out with the reason. Nothing is
 *    applied, nothing is pretended.
 *  - Android 8 and older have no DynamicsProcessing: supported = false, greyed with the
 *    reason. A box whose firmware lacks the effect (it throws on create) likewise.
 *
 * Threading: ExoPlayer's callbacks and the plugin's arrive on the main thread; the module's
 * calls are posted to it. Everything here runs on the main looper.
 */
object AudioFx : RNVExoplayerPlugin {
  private const val TAG = "AuroraAudioFx"
  private val main = Handler(Looper.getMainLooper())
  private var installed = false

  private var night = false
  private var dialogue = false
  /** Called with the status whenever it changes (AudioFxModule turns it into an event). */
  var onStatus: ((Status) -> Unit)? = null

  data class Status(
      val supported: Boolean,
      val sdk: Int,
      val passthrough: Boolean,
      val offload: Boolean,
      val channels: Int,
      val active: Boolean,
      val error: String?,
      val night: Boolean,
      val dialogue: Boolean,
  )

  private class Slot(val player: ExoPlayer) {
    var session = 0
    var dp: DynamicsProcessing? = null
    var now: FxValues = AudioFxCurve.NEUTRAL
    var channels = 2
    var processable = true
    var offload = false
    var error: String? = null
    var ramp: Runnable? = null
    var listener: AnalyticsListener? = null
  }
  private val slots = LinkedHashMap<String, Slot>()

  fun install() {
    if (installed) return
    installed = true
    try {
      ReactNativeVideoManager.getInstance().registerPlugin(this)
    } catch (t: Throwable) {
      Log.w(TAG, "could not register with react-native-video", t)
    }
  }

  val supported: Boolean
    get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P

  fun status(): Status {
    val s = slots.values.lastOrNull()
    return Status(
        supported = supported && (s?.error == null),
        sdk = Build.VERSION.SDK_INT,
        passthrough = s != null && !s.processable && !s.offload,
        offload = s?.offload == true,
        channels = s?.channels ?: 0,
        active = s?.dp != null,
        error = s?.error,
        night = night,
        dialogue = dialogue,
    )
  }

  private fun publish() {
    try {
      onStatus?.invoke(status())
    } catch (_: Throwable) {}
  }

  /** The person's switches (JS → AudioFxModule). */
  fun setWanted(n: Boolean, d: Boolean) {
    main.post {
      night = n
      dialogue = d
      for (s in slots.values) apply(s)
      publish()
    }
  }

  // ---- react-native-video's plugin calls ----
  override fun onInstanceCreated(id: String, player: ExoPlayer) {
    main.post {
      val slot = Slot(player)
      slot.session = try { player.audioSessionId } catch (_: Throwable) { 0 }
      val l =
          object : AnalyticsListener {
            override fun onAudioSessionIdChanged(eventTime: AnalyticsListener.EventTime, audioSessionId: Int) {
              if (audioSessionId == slot.session) return
              release(slot)
              slot.session = audioSessionId
              apply(slot)
              publish()
            }

            override fun onAudioTrackInitialized(eventTime: AnalyticsListener.EventTime, audioTrackConfig: AudioSink.AudioTrackConfig) {
              val pcm = Util.isEncodingLinearPcm(audioTrackConfig.encoding)
              slot.offload = audioTrackConfig.offload
              slot.processable = AudioFxCurve.processable(pcm, audioTrackConfig.offload)
              slot.channels = Integer.bitCount(audioTrackConfig.channelConfig).coerceAtLeast(1)
              apply(slot)
              publish()
            }
          }
      slot.listener = l
      try {
        player.addAnalyticsListener(l)
      } catch (_: Throwable) {}
      slots[id] = slot
      apply(slot)
      publish()
    }
  }

  override fun onInstanceRemoved(id: String, player: ExoPlayer) {
    main.post {
      val slot = slots.remove(id) ?: return@post
      slot.listener?.let {
        try {
          player.removeAnalyticsListener(it)
        } catch (_: Throwable) {}
      }
      release(slot)
      publish()
    }
  }

  // ---- the effect ----
  private fun apply(slot: Slot) {
    if (!supported) return
    val want = AudioFxCurve.targets(night, dialogue)
    // passthrough / offload: the app's effects do not reach that sound — leave it be
    if (!slot.processable) {
      glide(slot, AudioFxCurve.NEUTRAL)
      return
    }
    if (slot.dp == null) {
      if (want == AudioFxCurve.NEUTRAL) return // never asked for: the untouched path
      if (!create(slot)) return
    }
    glide(slot, want)
  }

  private fun create(slot: Slot): Boolean {
    if (slot.session == 0) return false
    return try {
      val cfg =
          DynamicsProcessing.Config.Builder(
                  DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                  slot.channels.coerceAtLeast(2),
                  true, AudioFxCurve.EQ_CUTOFFS.size, // pre-EQ: the dialogue boost
                  true, 1, // one full-band compressor: night mode
                  false, 0, // no post-EQ
                  true, // the limiter
              )
              .setPreferredFrameDuration(10f)
              .build()
      val dp = DynamicsProcessing(0, slot.session, cfg)
      slot.dp = dp
      slot.now = AudioFxCurve.NEUTRAL
      write(slot, AudioFxCurve.NEUTRAL)
      dp.enabled = true
      slot.error = null
      true
    } catch (t: Throwable) {
      Log.w(TAG, "DynamicsProcessing on session ${slot.session} failed", t)
      slot.error = t.javaClass.simpleName
      slot.dp = null
      false
    }
  }

  private fun glide(slot: Slot, to: FxValues) {
    val dp = slot.dp ?: return
    slot.ramp?.let { main.removeCallbacks(it) }
    if (slot.now == to) return
    val steps = AudioFxCurve.ramp(slot.now, to)
    var i = 0
    val stepMs = AudioFxCurve.RAMP_MS / AudioFxCurve.RAMP_STEPS
    val r =
        object : Runnable {
          override fun run() {
            if (slot.dp !== dp) return
            write(slot, steps[i])
            slot.now = steps[i]
            i++
            if (i < steps.size) main.postDelayed(this, stepMs) else slot.ramp = null
          }
        }
    slot.ramp = r
    main.post(r)
  }

  private fun write(slot: Slot, v: FxValues) {
    val dp = slot.dp ?: return
    try {
      val gains = floatArrayOf(v.eqLow, 0f, v.eqVoice, 0f)
      for (b in AudioFxCurve.EQ_CUTOFFS.indices) {
        dp.setPreEqBandAllChannelsTo(b, DynamicsProcessing.EqBand(true, AudioFxCurve.EQ_CUTOFFS[b], gains[b]))
      }
      dp.setMbcBandAllChannelsTo(
          0,
          DynamicsProcessing.MbcBand(
              true, 20000f, AudioFxCurve.NIGHT_ATTACK_MS, AudioFxCurve.NIGHT_RELEASE_MS,
              v.mbcRatio, v.mbcThreshold, v.mbcKnee,
              -90f, 1f, // no noise gate, no expander
              0f, v.mbcPostGain,
          ),
      )
      dp.setLimiterAllChannelsTo(
          DynamicsProcessing.Limiter(
              true, true, 0, AudioFxCurve.LIM_ATTACK_MS, AudioFxCurve.LIM_RELEASE_MS,
              v.limRatio, v.limThreshold, 0f,
          ),
      )
      // the centre of multichannel PCM (FL FR FC …): the dialogue's own channel
      val n = try { dp.channelCount } catch (_: Throwable) { 2 }
      for (ch in 0 until n) dp.setInputGainbyChannel(ch, if (ch == 2 && n > 2) v.centreGain else 0f)
    } catch (t: Throwable) {
      Log.w(TAG, "DynamicsProcessing write failed", t)
    }
  }

  private fun release(slot: Slot) {
    slot.ramp?.let { main.removeCallbacks(it) }
    slot.ramp = null
    try {
      slot.dp?.release()
    } catch (_: Throwable) {}
    slot.dp = null
    slot.now = AudioFxCurve.NEUTRAL
  }
}
