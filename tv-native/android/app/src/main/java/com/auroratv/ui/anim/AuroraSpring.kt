package com.auroratv.ui.anim

/**
 * `Animated.spring` with the native driver = `com.facebook.react.animated.SpringAnimation`
 * (react-android 0.86.0-2, ported from the prebuilt AAR's bytecode), with the JS-side
 * parameter conversion of `SpringConfig.js` in the companion.
 *
 * Per frame (`runAnimationStep`):
 *   frameTimeMillis = frameTimeNanos / 1_000_000            (long division)
 *   first frame: position = node value, startValue = position, lastTime = now, t = 0
 *   advance(dt = (frameTimeMillis - lastTime) / 1000)       (dt capped at MAX_DELTA_TIME_SEC)
 *   node value = position; finished = isAtRest
 *
 * `advance` is the closed-form damped oscillator from the START of this driver with
 * v0 = -initialVelocity, evaluated at the accumulated time. Rest = |v| <= restSpeed AND
 * |to - x| <= restDisplacement; AT REST THE VALUE IS SNAPPED TO `to` (SpringAnimation.kt's
 * `advance`: `if (isAtRest || (overshootClampingEnabled && isOvershooting))` → position =
 * endValue). The first port left it un-snapped, so a lit element rested at a scale up to
 * 0.001 × (s − 1) short and its pixels differed from the JS run by a level here and there,
 * differently on every run (2026-10-10).
 *
 * Retargeting: when JS starts a new `Animated.spring` on a value that is still moving,
 * `AnimatedValue.animate` stops the native driver (the node keeps its last value) and the
 * new driver starts from that value with `initialVelocity` = the previous JS animation's
 * `_lastVelocity`, which a native-driven animation never updates — so it is 0. That is
 * what `restart(from)` below reproduces: position carried over, velocity reset.
 * (01 §6.2 describes the JS driver's velocity carry-over; the shipped native path has
 * none, and the port follows the shipped path.) Pure JVM.
 */
class AuroraSpring(
  private val stiffness: Double,
  private val damping: Double,
  private val mass: Double,
  val toValue: Double,
  initialVelocity: Double = 0.0,
  private val restSpeedThreshold: Double = 0.001,
  private val restDisplacementThreshold: Double = 0.001,
  private val overshootClamping: Boolean = false,
) {
  private val initialVelocity = initialVelocity
  private var position = 0.0
  private var velocity = initialVelocity
  private var startValue = 0.0
  private var endValue = toValue
  private var lastTime = 0L
  private var springStarted = false
  private var timeAccumulator = 0.0
  var finished = false
    private set

  val currentPosition get() = position
  val currentVelocity get() = velocity

  /** One frame. `current` is the animated node's value; returns its new value. */
  fun step(frameTimeNanos: Long, current: Double): Double {
    val frameTimeMillis = frameTimeNanos / 1_000_000
    if (!springStarted) {
      position = current
      startValue = position
      lastTime = frameTimeMillis
      timeAccumulator = 0.0
      springStarted = true
    }
    advance((frameTimeMillis - lastTime) / 1000.0)
    lastTime = frameTimeMillis
    if (isAtRest()) finished = true
    return position
  }

  private fun isAtRest(): Boolean =
    Math.abs(velocity) <= restSpeedThreshold &&
      (Math.abs(endValue - position) <= restDisplacementThreshold || stiffness == 0.0)

  private fun isOvershooting(): Boolean =
    stiffness > 0 &&
      ((startValue < endValue && position > endValue) || (startValue > endValue && position < endValue))

  private fun advance(realDeltaTime: Double) {
    if (isAtRest()) return
    var deltaTime = realDeltaTime
    if (realDeltaTime > MAX_DELTA_TIME_SEC) deltaTime = MAX_DELTA_TIME_SEC
    timeAccumulator += deltaTime

    val c = damping
    val m = mass
    val k = stiffness
    val v0 = -initialVelocity

    val zeta = c / (2 * Math.sqrt(k * m))
    val omega0 = Math.sqrt(k / m)
    val omega1 = omega0 * Math.sqrt(1.0 - zeta * zeta)
    val x0 = endValue - startValue

    val velocityOut: Double
    val positionOut: Double
    val t = timeAccumulator
    if (zeta < 1) {
      val envelope = Math.exp(-zeta * omega0 * t)
      positionOut =
        endValue -
          envelope *
            ((v0 + zeta * omega0 * x0) / omega1 * Math.sin(omega1 * t) + x0 * Math.cos(omega1 * t))
      velocityOut =
        zeta * omega0 * envelope *
          (Math.sin(omega1 * t) * (v0 + zeta * omega0 * x0) / omega1 + x0 * Math.cos(omega1 * t)) -
          envelope * (Math.cos(omega1 * t) * (v0 + zeta * omega0 * x0) - omega1 * x0 * Math.sin(omega1 * t))
    } else {
      val envelope = Math.exp(-omega0 * t)
      positionOut = endValue - envelope * (x0 + (v0 + omega0 * x0) * t)
      velocityOut = envelope * (v0 * (t * omega0 - 1) + t * x0 * (omega0 * omega0))
    }
    position = positionOut
    velocity = velocityOut

    // RN (SpringAnimation.kt, advance): "make sure that if the spring was considered within a
    // resting threshold that it's now snapped to its end value" — at rest OR clamped overshoot.
    if (isAtRest() || (overshootClamping && isOvershooting())) {
      if (stiffness > 0) {
        startValue = endValue
        position = endValue
      } else {
        endValue = position
        startValue = endValue
      }
      velocity = 0.0
    }
  }

  companion object {
    const val MAX_DELTA_TIME_SEC = 0.064

    // SpringConfig.js
    fun stiffnessFromOrigamiValue(oValue: Double) = (oValue - 30) * 3.62 + 194
    fun dampingFromOrigamiValue(oValue: Double) = (oValue - 8) * 3 + 25

    /** `{tension, friction}` → `{stiffness, damping}` (mass 1). */
    fun fromOrigamiTensionAndFriction(tension: Double, friction: Double): Pair<Double, Double> =
      stiffnessFromOrigamiValue(tension) to dampingFromOrigamiValue(friction)

    /** `{bounciness, speed}` → `{stiffness, damping}` (mass 1). */
    fun fromBouncinessAndSpeed(bounciness: Double, speed: Double): Pair<Double, Double> {
      fun normalize(value: Double, startValue: Double, endValue: Double) = (value - startValue) / (endValue - startValue)
      fun projectNormal(n: Double, start: Double, end: Double) = start + n * (end - start)
      fun linearInterpolation(t: Double, start: Double, end: Double) = t * end + (1 - t) * start
      fun quadraticOutInterpolation(t: Double, start: Double, end: Double) = linearInterpolation(2 * t - t * t, start, end)
      fun b3Friction1(x: Double) = 0.0007 * Math.pow(x, 3.0) - 0.031 * Math.pow(x, 2.0) + 0.64 * x + 1.28
      fun b3Friction2(x: Double) = 0.000044 * Math.pow(x, 3.0) - 0.006 * Math.pow(x, 2.0) + 0.36 * x + 2
      fun b3Friction3(x: Double) = 0.00000045 * Math.pow(x, 3.0) - 0.000332 * Math.pow(x, 2.0) + 0.1078 * x + 5.84
      fun b3Nobounce(tension: Double) =
        if (tension <= 18) b3Friction1(tension) else if (tension > 18 && tension <= 44) b3Friction2(tension) else b3Friction3(tension)

      var b = normalize(bounciness / 1.7, 0.0, 20.0)
      b = projectNormal(b, 0.0, 0.8)
      val s = normalize(speed / 1.7, 0.0, 20.0)
      val bouncyTension = projectNormal(s, 0.5, 200.0)
      val bouncyFriction = quadraticOutInterpolation(b, b3Nobounce(bouncyTension), 0.01)
      return stiffnessFromOrigamiValue(bouncyTension) to dampingFromOrigamiValue(bouncyFriction)
    }
  }
}
