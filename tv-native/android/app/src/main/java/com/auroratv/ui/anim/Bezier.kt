package com.auroratv.ui.anim

/**
 * React Native's `Libraries/Animated/bezier.js` (Gaëtan Renaudeau's unit bezier),
 * ported line for line so a pre-sampled timing curve is bit-identical to the one
 * `Animated.timing` hands its native driver (01-architecture.md §6.1).
 *
 * The sample table is a Float32Array in JS, so it is a FloatArray here; every
 * read widens to double before arithmetic, exactly as JS does. Pure JVM: no
 * Android imports (the unit test runs it against fixtures generated from the
 * JS by tools/gen-anim-fixtures.js).
 */
class Bezier(private val mX1: Double, private val mY1: Double, private val mX2: Double, private val mY2: Double) {
  init {
    require(mX1 in 0.0..1.0 && mX2 in 0.0..1.0) { "bezier x values must be in [0, 1] range" }
  }

  private val sampleValues = FloatArray(K_SPLINE_TABLE_SIZE)

  init {
    if (mX1 != mY1 || mX2 != mY2) {
      for (i in 0 until K_SPLINE_TABLE_SIZE) {
        sampleValues[i] = calcBezier(i * K_SAMPLE_STEP_SIZE, mX1, mX2).toFloat()
      }
    }
  }

  private fun getTForX(aX: Double): Double {
    var intervalStart = 0.0
    var currentSample = 1
    val lastSample = K_SPLINE_TABLE_SIZE - 1
    while (currentSample != lastSample && sampleValues[currentSample].toDouble() <= aX) {
      intervalStart += K_SAMPLE_STEP_SIZE
      ++currentSample
    }
    --currentSample

    // Interpolate to provide an initial guess for t
    val dist =
      (aX - sampleValues[currentSample].toDouble()) /
        (sampleValues[currentSample + 1].toDouble() - sampleValues[currentSample].toDouble())
    val guessForT = intervalStart + dist * K_SAMPLE_STEP_SIZE

    val initialSlope = getSlope(guessForT, mX1, mX2)
    return if (initialSlope >= NEWTON_MIN_SLOPE) {
      newtonRaphsonIterate(aX, guessForT, mX1, mX2)
    } else if (initialSlope == 0.0) {
      guessForT
    } else {
      binarySubdivide(aX, intervalStart, intervalStart + K_SAMPLE_STEP_SIZE, mX1, mX2)
    }
  }

  /** The easing: y for x in [0, 1]. */
  fun ease(x: Double): Double {
    if (mX1 == mY1 && mX2 == mY2) return x // linear
    // Because JavaScript number are imprecise, we should guarantee the extremes are right.
    if (x == 0.0) return 0.0
    if (x == 1.0) return 1.0
    return calcBezier(getTForX(x), mY1, mY2)
  }

  companion object {
    private const val NEWTON_ITERATIONS = 4
    private const val NEWTON_MIN_SLOPE = 0.001
    private const val SUBDIVISION_PRECISION = 0.0000001
    private const val SUBDIVISION_MAX_ITERATIONS = 10
    private const val K_SPLINE_TABLE_SIZE = 11
    private const val K_SAMPLE_STEP_SIZE = 1.0 / (K_SPLINE_TABLE_SIZE - 1.0)

    private fun a(aA1: Double, aA2: Double) = 1.0 - 3.0 * aA2 + 3.0 * aA1
    private fun b(aA1: Double, aA2: Double) = 3.0 * aA2 - 6.0 * aA1
    private fun c(aA1: Double) = 3.0 * aA1

    // Returns x(t) given t, x1, and x2, or y(t) given t, y1, and y2.
    private fun calcBezier(aT: Double, aA1: Double, aA2: Double) =
      ((a(aA1, aA2) * aT + b(aA1, aA2)) * aT + c(aA1)) * aT

    // Returns dx/dt given t, x1, and x2, or dy/dt given t, y1, and y2.
    private fun getSlope(aT: Double, aA1: Double, aA2: Double) =
      3.0 * a(aA1, aA2) * aT * aT + 2.0 * b(aA1, aA2) * aT + c(aA1)

    private fun binarySubdivide(aX: Double, aAIn: Double, aBIn: Double, mX1: Double, mX2: Double): Double {
      var currentX: Double
      var currentT: Double
      var i = 0
      var aA = aAIn
      var aB = aBIn
      do {
        currentT = aA + (aB - aA) / 2.0
        currentX = calcBezier(currentT, mX1, mX2) - aX
        if (currentX > 0.0) {
          aB = currentT
        } else {
          aA = currentT
        }
      } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS)
      return currentT
    }

    private fun newtonRaphsonIterate(aX: Double, aGuessTIn: Double, mX1: Double, mX2: Double): Double {
      var aGuessT = aGuessTIn
      for (i in 0 until NEWTON_ITERATIONS) {
        val currentSlope = getSlope(aGuessT, mX1, mX2)
        if (currentSlope == 0.0) return aGuessT
        val currentX = calcBezier(aGuessT, mX1, mX2) - aX
        aGuessT -= currentX / currentSlope
      }
      return aGuessT
    }
  }
}
