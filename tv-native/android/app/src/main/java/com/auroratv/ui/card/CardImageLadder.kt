package com.auroratv.ui.card

/**
 * The card picture's failure → retry → backup → tile → slow rounds → park sequence
 * (src/components/Card.tsx:173-245, 10c-spec-card-row.md §1.4), as a pure state machine so
 * the timing table can be unit-tested on the JVM. [AuroraCardView] owns the timers and the
 * Fresco requests; this class only says what to show and when.
 *
 * Per address `uri` (the FIRST address; a new picture gets a fresh ladder):
 *
 *   n = tries + 1 on each failure
 *   n <  tileAt   keep showing what failed, then after (n == 2 ? 0 : 1500) ms switch to
 *                 RETRY (`<uri>?r=1`, n == 1) or BACKUP (`/img/poster/<imdb>`, n == 2 —
 *                 only reachable with a backup, since tileAt is 2 without one)
 *   n >= tileAt   the titled TILE now; round = rounds[uri]++ ; round >= 3 → PARKED
 *                 (nothing more until `unpark`), else after ROUND_MS[round] back to FIRST
 *                 with tries = 0, so the whole chain replays.
 *
 * `tries` is reported to JS on every failure: Card.tsx reports the failure to the server
 * (trackError) only for n == 1, and the wrapper keeps that rule.
 */
class CardImageLadder(val hasBackup: Boolean) {
  enum class Show { FIRST, RETRY, BACKUP, TILE }

  /**
   * One failure's outcome: [now] is what to show immediately, [then] what to switch to after
   * [delayMs] (null = nothing scheduled: parked). [round] is the slow round that was started
   * (-1 when none), [parked] whether the ladder has given up until [unpark].
   */
  class Step(val now: Show, val then: Show?, val delayMs: Long, val tries: Int, val round: Int, val parked: Boolean)

  /** `TILE_AT = backup ? 3 : 2` (Card.tsx:210). */
  val tileAt: Int = if (hasBackup) 3 else 2

  var uri: String = ""
    private set
  var tries: Int = 0
    private set
  var parked: Boolean = false
    private set

  // Card.tsx:189 `rounds` — kept across pictures, keyed by the first address.
  private var roundsUri = ""
  private var roundsN = 0

  /** A new picture (or the first): Card.tsx keys `fail` by the address, so it starts over. */
  fun restart(newUri: String) {
    uri = newUri
    tries = 0
    parked = false
  }

  /** Which address the card shows for the current `tries` (Card.tsx:211-217). */
  fun show(): Show =
    when {
      tries >= tileAt -> Show.TILE
      tries == 2 && hasBackup -> Show.BACKUP
      tries == 1 -> Show.RETRY
      else -> Show.FIRST
    }

  /** The address that is showing failed (Card.tsx:222-245 `onImgError`). */
  fun fail(): Step {
    if (parked) return Step(Show.TILE, null, -1, tries, -1, true)
    val n = tries + 1
    if (n >= tileAt) {
      tries = n
      if (roundsUri != uri) {
        roundsUri = uri
        roundsN = 0
      }
      val round = roundsN++
      if (round >= ROUND_MS.size) {
        parked = true
        return Step(Show.TILE, null, -1, n, round, true)
      }
      // the slow round: back to the first address
      return Step(Show.TILE, Show.FIRST, ROUND_MS[round], n, round, false)
    }
    // (the backup poster is tried at once; the plain retry waits a breath)
    val then = if (n == 2) Show.BACKUP else Show.RETRY
    return Step(show(), then, if (n == 2) 0L else RETRY_MS, n, -1, false)
  }

  /** The scheduled half of a [Step] fired: move to its `then` address. */
  fun apply(step: Step) {
    when (step.then) {
      Show.FIRST -> tries = 0
      Show.RETRY -> tries = 1
      Show.BACKUP -> tries = 2
      Show.TILE -> tries = tileAt
      null -> {}
    }
  }

  /** The realtime socket's `welcome` (Card.tsx:195-202): rounds reset, back to the first address. */
  fun unpark() {
    if (!parked) return
    parked = false
    roundsUri = uri
    roundsN = 0
    tries = 0
  }

  companion object {
    /** Card.tsx:244 — the plain retry waits a breath. */
    const val RETRY_MS = 1500L
    /** Card.tsx:86 `ROUND_MS` — three slow rounds, then the card stops asking. */
    val ROUND_MS = longArrayOf(30_000L, 120_000L, 480_000L)
  }
}
