package com.auroratv.audio

/**
 * NIGHT MODE and DIALOGUE BOOST — the numbers, and nothing else (pure, JVM-tested in
 * AudioFxCurveTest). The website's public/js/audiofx.js uses the same ones:
 *
 *   Night mode      one full-band compressor: threshold -34 dB, 3:1, knee 10 dB,
 *                   attack 5 ms, release 250 ms, +6 dB after it (the site's compressor
 *                   stage gives the same +6 dB in all)
 *   Dialogue boost  pre-EQ: under 200 Hz -4 dB, 1-4 kHz +6 dB (the site: a lowshelf at
 *                   200 Hz and a wide peak at 2.5 kHz); a centre channel, when the
 *                   sound is multichannel PCM, +3 dB
 *   either on       a limiter at -1 dBFS, 20:1, 1 ms / 100 ms
 *
 * Off is each stage at its neutral values (ratio 1, 0 dB): the effect stays on the session
 * and every switch is a short glide between two sets of values, never a re-build — that is
 * what keeps a toggle free of clicks.
 */
data class FxValues(
    val mbcThreshold: Float,
    val mbcRatio: Float,
    val mbcKnee: Float,
    val mbcPostGain: Float,
    val eqLow: Float,
    val eqVoice: Float,
    val centreGain: Float,
    val limThreshold: Float,
    val limRatio: Float,
) {
  fun lerp(to: FxValues, f: Float): FxValues {
    val t = f.coerceIn(0f, 1f)
    fun m(a: Float, b: Float) = a + (b - a) * t
    return FxValues(
        m(mbcThreshold, to.mbcThreshold),
        m(mbcRatio, to.mbcRatio),
        m(mbcKnee, to.mbcKnee),
        m(mbcPostGain, to.mbcPostGain),
        m(eqLow, to.eqLow),
        m(eqVoice, to.eqVoice),
        m(centreGain, to.centreGain),
        m(limThreshold, to.limThreshold),
        m(limRatio, to.limRatio),
    )
  }
}

object AudioFxCurve {
  // night
  const val NIGHT_THRESHOLD = -34f
  const val NIGHT_RATIO = 3f
  const val NIGHT_KNEE = 10f
  const val NIGHT_ATTACK_MS = 5f
  const val NIGHT_RELEASE_MS = 250f
  const val NIGHT_MAKEUP = 6f
  // dialogue
  const val LOW_CUT_HZ = 200f
  const val LOW_DB = -4f
  const val VOICE_FROM_HZ = 1000f
  const val VOICE_TO_HZ = 4000f
  const val VOICE_DB = 6f
  const val CENTRE_DB = 3f
  // limiter
  const val LIM_THRESHOLD = -1f
  const val LIM_RATIO = 20f
  const val LIM_ATTACK_MS = 1f
  const val LIM_RELEASE_MS = 100f
  // the pre-EQ's bands, by their upper edges: [..200] [200..1k] [1k..4k] [4k..20k]
  val EQ_CUTOFFS = floatArrayOf(LOW_CUT_HZ, VOICE_FROM_HZ, VOICE_TO_HZ, 20000f)
  /** A switch glides over this long, in this many steps. */
  const val RAMP_MS = 200L
  const val RAMP_STEPS = 10

  val NEUTRAL = FxValues(0f, 1f, 0f, 0f, 0f, 0f, 0f, 0f, 1f)

  fun targets(night: Boolean, dialogue: Boolean): FxValues {
    val any = night || dialogue
    return FxValues(
        mbcThreshold = if (night) NIGHT_THRESHOLD else 0f,
        mbcRatio = if (night) NIGHT_RATIO else 1f,
        mbcKnee = if (night) NIGHT_KNEE else 0f,
        mbcPostGain = if (night) NIGHT_MAKEUP else 0f,
        eqLow = if (dialogue) LOW_DB else 0f,
        eqVoice = if (dialogue) VOICE_DB else 0f,
        centreGain = if (dialogue) CENTRE_DB else 0f,
        limThreshold = if (any) LIM_THRESHOLD else 0f,
        limRatio = if (any) LIM_RATIO else 1f,
    )
  }

  /** The values at each step of a glide from `from` to `to` (the last one is `to`). */
  fun ramp(from: FxValues, to: FxValues, steps: Int = RAMP_STEPS): List<FxValues> =
      (1..steps).map { from.lerp(to, it.toFloat() / steps) }

  /** The static curve of the night stage, in dB (the knee quadratic, then 1/ratio), plus
   *  its make-up: what a steady level comes out at. For the tests and the report. */
  fun nightOut(inDb: Float, v: FxValues): Float {
    val thr = v.mbcThreshold
    val knee = v.mbcKnee
    val r = v.mbcRatio
    val y =
        when {
          inDb <= thr -> inDb
          knee > 0f && inDb < thr + knee -> inDb + (1f / r - 1f) * (inDb - thr) * (inDb - thr) / (2f * knee)
          else -> {
            val kneeEnd = thr + knee
            val atEnd = if (knee > 0f) kneeEnd + (1f / r - 1f) * knee / 2f else thr
            atEnd + (inDb - kneeEnd) / r
          }
        }
    return y + v.mbcPostGain
  }

  /** PCM the app decodes itself can be processed; anything else is passed through as a
   *  bitstream (AC-3, E-AC-3, DTS to the receiver) or played by the system's offload path,
   *  where no effect of the app's applies. */
  fun processable(isLinearPcm: Boolean, offload: Boolean): Boolean = isLinearPcm && !offload
}
