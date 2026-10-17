package com.auroratv.ui.anim

/**
 * `Animated.timing` with the native driver = JS `TimingAnimation.__getNativeAnimationConfig`
 * (the curve pre-sampled at 1000/60 ms) + `FrameBasedAnimationDriver.runAnimationStep`
 * (react-android 0.86.0-2, read from the bytecode of the prebuilt AAR):
 *
 *   timeFromStartMillis = (frameTimeNanos - startFrameTimeNanos) / 1_000_000   (long division)
 *   frameIndex          = Math.round(timeFromStartMillis / (1000/60))           (ROUND, not truncation —
 *                                                                               01 §6.1 says truncation; the
 *                                                                               shipped driver rounds)
 *   value               = from + frames[frameIndex] * (to - from)
 *   finished            = frameIndex >= frames.size - 1  → value = to
 *
 * `startFrameTimeNanos` is the first frame after start() (one frame of latency), and
 * `from` is the node's value at that frame — which is how RN retargets a timing that is
 * still running: the previous driver is stopped, the node keeps its last value, and the
 * new driver starts from it. Pure JVM.
 */
class AuroraTiming(private val frames: DoubleArray, val toValue: Double) {
  private var startFrameTimeNanos = -1L
  private var fromValue = 0.0
  var finished = false
    private set

  /** One frame. `current` is the animated node's value; returns its new value. */
  fun step(frameTimeNanos: Long, current: Double): Double {
    if (startFrameTimeNanos < 0) {
      startFrameTimeNanos = frameTimeNanos
      fromValue = current
    }
    val timeFromStartMillis = (frameTimeNanos - startFrameTimeNanos) / 1_000_000
    val frameIndex = Math.round(timeFromStartMillis / FRAME_TIME_MILLIS).toInt()
    if (frameIndex < 0) return current // the driver logs and skips a frame from the past
    if (finished) return current
    return if (frameIndex >= frames.size - 1) {
      finished = true
      toValue
    } else {
      fromValue + frames[frameIndex] * (toValue - fromValue)
    }
  }

  companion object {
    const val FRAME_TIME_MILLIS = 1000.0 / 60.0

    /** `TimingAnimation.__getNativeAnimationConfig().frames` for a duration and easing. */
    fun sample(durationMs: Double, easing: (Double) -> Double): DoubleArray {
      val numFrames = Math.round(durationMs / FRAME_TIME_MILLIS).toInt()
      val out = DoubleArray(numFrames + 1)
      for (frame in 0 until numFrames) out[frame] = easing(frame.toDouble() / numFrames)
      out[numFrames] = easing(1.0)
      return out
    }
  }
}
