package com.auroratv.ui.input

/**
 * render switch `keyrate` (AuroraRender.kt; docs/qa/native-deep/DEVICE-PLAN.md §keyrate).
 * The policy only — no Android types, so the JVM tests can feed it synthetic event streams
 * (KeyRepeatGateTest, KeyRepeatSimTest). MainActivity.kt wires it to the real keys and frames.
 *
 * THE PROBLEM. A held D-pad key repeats every ~50 ms (Android's key-repeat delay, after the
 * 400–500 ms repeat timeout), and the focus engine moves on EVERY repeat, whatever the app
 * can draw. On a weak TV a move costs more than 50 ms of UI-thread time (a shelf mounts a
 * card, Home re-aims its spring, React commits), so repeats queue up in the input channel:
 * several moves land between two frames (the picture jumps two or three cards), and the
 * queue is still being worked off after the key is let go (the shelf runs on past where the
 * viewer stopped). Leanback's grid has the same problem and answers it by remembering up to
 * ten unhandled moves and finishing them AFTER release (BaseGridView
 * setSmoothScrollMaxPendingMoves) — the overshoot this switch exists to remove.
 *
 * THE RULE. While a key is held, the hardware's repeats no longer move focus themselves:
 *  - a PRESS (repeatCount 0) is never touched: it moves at once, as it always did, so a tap
 *    is never lost or delayed;
 *  - a REPEAT (repeatCount > 0) of the held key is consumed and only noted ("still held");
 *  - on each frame (Choreographer), ONE move is made when the key is still held, a hardware
 *    repeat has arrived since the last move (never faster than the remote), the last
 *    hardware repeat is recent (LOST_MS — a stalled input pipe or a lost key-up does not
 *    keep scrolling) and at least [intervalMs] − [slackMs] have passed since the last move;
 *  - the key-up ends it: nothing is pending, so nothing can move after release.
 * So focus moves at most once per frame, at a steady rate that does not depend on how
 * evenly the remote repeats, and a frame that took long simply delays the next move instead
 * of letting a backlog through.
 *
 * THE RATE. [INTERVAL_MS] = 66 with [SLACK_MS] = 6 → one move every 4th refresh at 59.94 Hz
 * (66.7 ms, 15 a second), every 3rd at 50 Hz (60 ms, 16.7 a second); a slower frame rate
 * stretches it to the next frame (2 × 33 ms at 30 fps). The system's own repeat is 20 a
 * second; 15 keeps the shelf's spring within a card or two of focus (rowWindow.ts measured
 * it running 5–7 cards behind at 15–20 presses a second on the Mi TV) while a 24-card shelf
 * still crosses in under two seconds. It is ONE constant; the device pass may tune it
 * (DEVICE-PLAN §keyrate, the QA command `keyrate <ms>`).
 */
class KeyRepeatGate(
  val intervalMs: Long = INTERVAL_MS,
  val slackMs: Long = SLACK_MS,
  val lostMs: Long = LOST_MS,
) {
  enum class Verdict {
    /** Let the event through untouched (Android moves focus for a press as before). */
    PASS,
    /** Swallow it: a hardware repeat of the held key — the gate moves on the frames instead. */
    CONSUME,
  }

  /** The D-pad key being held (0 = none). */
  var heldCode = 0
    private set
  /** Repeats have started for [heldCode]: the gate is driving moves. */
  var repeating = false
    private set
  private var lastMoveAt = 0L
  private var lastRepeatAt = 0L
  private var repeatSince = false
  private var synthCount = 0

  /** Counters for the QA / bench log line at the end of a hold. */
  var hardwareRepeats = 0
    private set
  var moves = 0
    private set

  /** The frame clock should call [onFrame] (a hold is being driven). */
  val wantsFrames: Boolean get() = repeating

  /**
   * One key event of a D-pad direction key, as the activity receives it. `eventTimeMs` is
   * KeyEvent.getEventTime() (uptime ms).
   */
  fun onKey(code: Int, down: Boolean, repeatCount: Int, eventTimeMs: Long): Verdict {
    if (down) {
      if (repeatCount == 0) {
        // A new press (also: a second key pressed while one is held — it takes over).
        heldCode = code
        repeating = false
        repeatSince = false
        lastMoveAt = eventTimeMs
        synthCount = 0
        hardwareRepeats = 0
        moves = 1
        return Verdict.PASS
      }
      if (code != heldCode) return Verdict.PASS // not ours (a press we never saw): leave it alone
      hardwareRepeats++
      lastRepeatAt = eventTimeMs
      repeatSince = true
      repeating = true
      return Verdict.CONSUME
    }
    if (code == heldCode) {
      heldCode = 0
      repeating = false
      repeatSince = false
    }
    return Verdict.PASS
  }

  /**
   * A frame starts (`frameTimeMs` = Choreographer's frame time, `nowMs` = uptime now). True
   * when the caller is to make one move now (a synthesized repeat of the held key).
   */
  fun onFrame(frameTimeMs: Long, nowMs: Long): Boolean {
    if (!repeating) return false
    if (!repeatSince) return false
    if (nowMs - lastRepeatAt > lostMs) return false
    if (frameTimeMs - lastMoveAt < intervalMs - slackMs) return false
    lastMoveAt = frameTimeMs
    repeatSince = false
    synthCount++
    moves++
    return true
  }

  /** The repeatCount the synthesized event carries (1, 2, 3, … per hold). */
  fun syntheticRepeatCount(): Int = synthCount

  /** Forget everything (the window lost focus, the activity paused). */
  fun reset() {
    heldCode = 0
    repeating = false
    repeatSince = false
  }

  companion object {
    const val INTERVAL_MS = 66L
    const val SLACK_MS = 6L
    /** No hardware repeat for this long: the key is probably up (its key-up still in flight). */
    const val LOST_MS = 150L
    /** Accepted range for the QA override (`keyrate <ms>`). */
    const val MIN_INTERVAL_MS = 16L
    const val MAX_INTERVAL_MS = 250L
  }
}
