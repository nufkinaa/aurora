package com.auroratv.ui.anim

/**
 * `value.interpolate({inputRange, outputRange, extrapolate: 'clamp'})` on a native-driven
 * value = `com.facebook.react.animated.InterpolationAnimatedNode` (react-android 0.86.0-2):
 *
 *   findRangeIndex: the first `index` in 1 until size-1 with inputRange[index] >= value, minus 1
 *   interpolate:    value clamped into [inputMin, inputMax];
 *                   outputMin == outputMax → outputMin;
 *                   inputMin == inputMax  → value <= inputMin ? outputMin : outputMax;
 *                   else outputMin + (outputMax - outputMin) * (value - inputMin) / (inputMax - inputMin)
 *
 * Only the `clamp` extrapolation is ported: every range the native components evaluate
 * either clamps (Home's art fade) or is driven by a value that never leaves its range
 * (0..1 timings), where `extend` and `clamp` agree. Pure JVM.
 */
object Interpolation {
  fun clamp(value: Double, input: DoubleArray, output: DoubleArray): Double {
    var index = 1
    while (index < input.size - 1) {
      if (input[index] >= value) break
      index++
    }
    val i = index - 1
    return segment(value, input[i], input[i + 1], output[i], output[i + 1])
  }

  fun segment(value: Double, inputMin: Double, inputMax: Double, outputMin: Double, outputMax: Double): Double {
    var result = value
    if (result < inputMin) result = inputMin
    if (result > inputMax) result = inputMax
    if (outputMin == outputMax) return outputMin
    if (inputMin == inputMax) return if (value <= inputMin) outputMin else outputMax
    return outputMin + (outputMax - outputMin) * (result - inputMin) / (inputMax - inputMin)
  }

  /**
   * The 8-bit alpha a view's `alpha` leaves on a paint that drew at 255: HWUI multiplies it
   * in per drawing op for a view without overlapping rendering — which every ReactViewGroup
   * and ReactImageView is — and truncates (`(uint8_t) paint.getAlpha() * alpha`,
   * RenderNodeDrawable's AlphaFilterCanvas). [base] is the paint's alpha before this view's.
   */
  fun alpha8(alpha: Double, base: Int = 255): Int {
    val a = (base * alpha.toFloat()).toInt()
    return if (a < 0) 0 else if (a > 255) 255 else a
  }
}
