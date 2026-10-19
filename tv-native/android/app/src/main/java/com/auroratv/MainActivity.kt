package com.auroratv

import android.app.SearchManager
import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.SoundEffectConstants
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import com.auroratv.ui.AuroraRender
import com.auroratv.ui.input.KeyRepeatGate
import com.auroratv.ui.qa.AuroraQa
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "AuroraTV"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Start with a CLEAN slate, never Android's saved instance state.
   *
   * When this activity is recreated — a display-size or font-scale change in TV
   * settings, the system reclaiming the process and the launcher bringing it
   * back — Android restores the saved FragmentManager state before React Native
   * has re-registered anything. react-native-screens' ScreenStackFragment is
   * then instantiated by the framework with no React context behind it and
   * throws, which crashes the app on launch, repeatedly, with no way back in:
   *
   *   Unable to instantiate fragment com.swmansion.rnscreens.ScreenStackFragment:
   *   calling Fragment constructor caused an exception
   *
   * Reproduced here by changing the display density while the app was installed.
   * Passing null discards that state; RN rebuilds the whole tree from JS anyway,
   * so there was nothing in it worth restoring. This is the fix react-native-
   * screens documents for exactly this crash.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    searchToLink(intent)
    super.onCreate(null)
    gate = makeGate()
  }

  /**
   * The TV's own search sent a search to Aurora (ACTION_SEARCH, res/xml/searchable.xml): it
   * reaches JS as a link, `aurora://search?q=<words>` (voiceKey.ts opens Search on them).
   */
  override fun onNewIntent(intent: Intent) {
    searchToLink(intent)
    super.onNewIntent(intent)
  }

  private fun searchToLink(i: Intent?) {
    if (i == null || i.action != Intent.ACTION_SEARCH) return
    val q = i.getStringExtra(SearchManager.QUERY)?.trim().orEmpty()
    i.action = Intent.ACTION_VIEW
    i.data = Uri.parse("aurora://search?q=" + Uri.encode(q.take(80)))
  }

  /**
   * One press, one move (elia, 2026-10-08: a touchpad remote "sometimes
   * registers two clicks instead of one when going up and down").
   *
   * A swipe on a touchpad remote, and a bouncy key on a cheap one, deliver
   * the same D-pad key TWICE within a few dozen milliseconds as two separate
   * presses (repeatCount 0 each). The framework's focus engine moves on every
   * key-down, so one swipe stepped two rows. Nobody presses the same key
   * twice in 110 ms on purpose, so a second press of the same D-pad key
   * inside that window is dropped, along with its key-up. A HELD key is
   * different: the system repeats it with repeatCount > 0, and that is
   * hold-to-scroll — passed through untouched.
   */
  private var lastDpadCode = 0
  private var lastDpadAt = 0L
  private var swallowingUp = false

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val code = event.keyCode
    // The remote's search / voice key, while the app wants it (VoiceModule.captureKeys): voice
    // search, in the app, instead of the system's. The press and its release are both ours.
    if ((code == KeyEvent.KEYCODE_SEARCH || code == KeyEvent.KEYCODE_VOICE_ASSIST) && VoiceModule.wantsKeys()) {
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) VoiceModule.onVoiceKey(code)
      return true
    }
    // `keyrate`: a held key's hardware repeats are the gate's, not the focus engine's (below)
    val g = gate
    if (g != null && isDpad(code) && !(event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && isDoublePress(event))) {
      if (gateKey(g, event)) return true
    }
    // QA trace (tools/tv-bench/tv-pixel-diff/PROTOCOL.md §4): every key the activity receives, on
    // the key's own uptime clock, so the harness can align [anim] steps on it. A QA build only
    // (AuroraQa.trace is never set otherwise).
    if (AuroraQa.trace && event.action == KeyEvent.ACTION_DOWN) {
      Log.d(AuroraQa.TAG_ANIM, "[key] ${event.eventTime} ${KeyEvent.keyCodeToString(code)}")
    }
    // the release, for the held-key bench (docs/qa/native-deep/DEVICE-PLAN.md §keyrate: a focus
    // gain later than this line is a move the viewer did not make — "overshoot")
    if (AuroraQa.trace && event.action == KeyEvent.ACTION_UP && isDpad(code)) {
      Log.d(AuroraQa.TAG_ANIM, "[keyup] ${event.eventTime} ${KeyEvent.keyCodeToString(code)} repeats=${event.repeatCount}")
    }
    val dpad = code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN ||
      code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
    if (dpad) {
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
        val now = event.eventTime
        if (code == lastDpadCode && now - lastDpadAt < DOUBLE_PRESS_MS) {
          swallowingUp = true
          return true
        }
        lastDpadCode = code
        lastDpadAt = now
        swallowingUp = false
      } else if (event.action == KeyEvent.ACTION_UP && swallowingUp && code == lastDpadCode) {
        swallowingUp = false
        return true
      }
    }
    return super.dispatchKeyEvent(event)
  }

  private fun isDpad(code: Int) = code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN ||
    code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT

  /** The press the double-press filter above is about to drop: the gate must not see it as a new hold. */
  private fun isDoublePress(event: KeyEvent) =
    event.keyCode == lastDpadCode && event.eventTime - lastDpadAt < DOUBLE_PRESS_MS

  // =====================================================================================
  // render switch `keyrate` (ui/input/KeyRepeatGate.kt has the rule and the why;
  // docs/qa/native-deep/DEVICE-PLAN.md the device checks). Off: none of this runs.
  // =====================================================================================

  /** Made in onCreate (the switches are read once per process, AuroraRender.kt). */
  private var gate: KeyRepeatGate? = null
  /** The last hardware repeat of the held key: the template of the moves the gate makes. */
  private var heldRepeat: KeyEvent? = null
  private var gateFramePosted = false
  private val focusRect = Rect()
  private val gateFrame = Choreographer.FrameCallback { frameTimeNanos -> onGateFrame(frameTimeNanos) }

  private fun makeGate(): KeyRepeatGate? {
    AuroraRender.ensureLoaded(applicationContext)
    if (!AuroraRender.on("keyrate")) return null
    val ms = try { AuroraRender.keyRateMs(applicationContext) } catch (_: Throwable) { null }
    return if (ms != null) KeyRepeatGate(intervalMs = ms) else KeyRepeatGate()
  }

  /** True when the event was consumed by the gate. */
  private fun gateKey(g: KeyRepeatGate, event: KeyEvent): Boolean {
    val down = event.action == KeyEvent.ACTION_DOWN
    if (!down && event.action != KeyEvent.ACTION_UP) return false
    val held = g.heldCode
    val verdict = g.onKey(event.keyCode, down, event.repeatCount, event.eventTime)
    if (verdict == KeyRepeatGate.Verdict.CONSUME) {
      heldRepeat = event
      if (!gateFramePosted) {
        gateFramePosted = true
        Choreographer.getInstance().postFrameCallback(gateFrame)
      }
      return true
    }
    if (!down && held != 0 && event.keyCode == held) {
      // the hold is over: one line for the bench (moves made vs the hardware's repeats)
      if (g.hardwareRepeats > 0) {
        Log.i("AuroraRender", "[keyrate] ${KeyEvent.keyCodeToString(held)} moves=${g.moves} repeats=${g.hardwareRepeats} interval=${g.intervalMs}")
      }
      heldRepeat = null
    }
    return false
  }

  private fun onGateFrame(frameTimeNanos: Long) {
    gateFramePosted = false
    val g = gate ?: return
    if (!g.wantsFrames) return
    val template = heldRepeat
    if (template != null && g.onFrame(frameTimeNanos / 1_000_000L, SystemClock.uptimeMillis())) {
      val ev = KeyEvent.changeTimeRepeat(template, SystemClock.uptimeMillis(), g.syntheticRepeatCount())
      moveLikeTheSystem(ev)
    }
    if (g.wantsFrames) {
      gateFramePosted = true
      Choreographer.getInstance().postFrameCallback(gateFrame)
    }
  }

  /**
   * What ViewRootImpl does with a key-down nobody consumed (ViewPostImeInputStage.processKeyEvent
   * → performFocusNavigation): the view tree (and React Native's root view, which tells JS)
   * sees the event first; if nothing handled it, focus moves to the view FocusFinder picks in
   * that direction, with the same rect hand-over and the same key sound. The gate's moves go
   * through here instead of the input pipeline, which an app cannot inject into.
   */
  private fun moveLikeTheSystem(ev: KeyEvent) {
    if (AuroraQa.trace) Log.d(AuroraQa.TAG_ANIM, "[key] ${ev.eventTime} ${KeyEvent.keyCodeToString(ev.keyCode)}")
    if (super.dispatchKeyEvent(ev)) return
    focusLikeTheSystem(ev.keyCode)
  }

  /**
   * The focus half of [moveLikeTheSystem] (ViewRootImpl's performFocusNavigation for a key-down
   * nobody consumed): the gate's moves and the phone remote's presses ([injectRemoteKey]) both
   * end here. [phone-remote]: extracted from moveLikeTheSystem, unchanged.
   */
  private fun focusLikeTheSystem(keyCode: Int) {
    val direction = when (keyCode) {
      KeyEvent.KEYCODE_DPAD_LEFT -> View.FOCUS_LEFT
      KeyEvent.KEYCODE_DPAD_RIGHT -> View.FOCUS_RIGHT
      KeyEvent.KEYCODE_DPAD_UP -> View.FOCUS_UP
      KeyEvent.KEYCODE_DPAD_DOWN -> View.FOCUS_DOWN
      else -> return
    }
    val root = window?.decorView as? ViewGroup ?: return
    val focused = root.findFocus()
    if (focused == null) {
      root.restoreDefaultFocus()
      return
    }
    try {
      val next = focused.focusSearch(direction)
      if (next != null && next !== focused) {
        focused.getFocusedRect(focusRect)
        root.offsetDescendantRectToMyCoords(focused, focusRect)
        root.offsetRectIntoDescendantCoords(next, focusRect)
        if (next.requestFocus(direction, focusRect)) {
          @Suppress("DEPRECATION")
          root.playSoundEffect(SoundEffectConstants.getContantForFocusDirection(direction))
          return
        }
      }
      root.dispatchUnhandledMove(focused, direction)
    } catch (t: IllegalArgumentException) {
      // a view left the tree between the search and the hand-over (ViewRootImpl would throw too)
      Log.w("AuroraRender", "[keyrate] move dropped: ${t.message}")
    }
  }

  /** The system's "search requested" (a search key that reached the activity another way). */
  override fun onSearchRequested(): Boolean {
    if (VoiceModule.onVoiceKey(KeyEvent.KEYCODE_SEARCH)) return true
    return super.onSearchRequested()
  }

  // =====================================================================================
  // [phone-remote] the phone as a remote (RemoteModule.kt "AuroraRemote" → pressKey)
  // =====================================================================================

  /**
   * One press of a remote key from the phone, as a REAL key: a key-down and its key-up with the
   * same uptime, through this activity's own [dispatchKeyEvent] — the double-press filter, the
   * `keyrate` gate, and React Native's key events to JS (ReactRootView → the TV event handlers)
   * see it exactly as a press of the remote in the hand. What ViewRootImpl does after the view
   * tree for a hardware key-down nobody consumed — move focus in that direction, with the sound
   * — is done here too ([focusLikeTheSystem]), because an injected event never reaches the input
   * pipeline. So focus.ts (pressMovedFocus: the focus move and the key-up of ONE press) reads a
   * phone press the way it reads a real one.
   *
   * OK is DPAD_CENTER (the focused view clicks on its key-up, as for the remote). BACK goes the
   * same way: Activity.onKeyDown starts tracking it, onKeyUp → onBackPressed → React Native's
   * BackHandler; if that path did not take it, the back dispatcher is asked directly.
   *
   * Main thread only. Returns false for a key it does not know, or while another window has
   * the keys.
   */
  fun injectRemoteKey(code: Int): Boolean {
    val source = when (code) {
      KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
      KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER -> InputDevice.SOURCE_DPAD
      KeyEvent.KEYCODE_BACK -> InputDevice.SOURCE_KEYBOARD
      else -> return false
    }
    // A system window has the keys (a permission dialog, the installer): a real press would go
    // to it, not to this activity — so this one goes nowhere, and the phone is told it failed.
    if (!hasWindowFocus()) return false
    keepAwakeWhileSteered()
    val now = SystemClock.uptimeMillis()
    val down = KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, source)
    val consumed = dispatchKeyEvent(down)
    if (!consumed && isDpad(code)) focusLikeTheSystem(code)
    val up = KeyEvent.changeAction(down, KeyEvent.ACTION_UP)
    val upConsumed = dispatchKeyEvent(up)
    if (code == KeyEvent.KEYCODE_BACK && !upConsumed) onBackPressedDispatcher.onBackPressed()
    return true
  }

  /**
   * Presses from the phone are not the system's user activity (only the input pipeline's are),
   * so the TV's screensaver would start while someone browses from the sofa with the phone.
   * The window stays on for a while after each press instead; the flag goes when they stop.
   */
  private val awakeRelease = Runnable { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
  private fun keepAwakeWhileSteered() {
    val w = window ?: return
    w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    val decor = w.decorView
    decor.removeCallbacks(awakeRelease)
    decor.postDelayed(awakeRelease, REMOTE_AWAKE_MS)
  }
  // =====================================================================================
  // [/phone-remote]
  // =====================================================================================

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // a dialog / another window took the keys: its key-up will never reach us
    if (!hasFocus) {
      gate?.reset()
      heldRepeat = null
    }
  }

  override fun onPause() {
    super.onPause()
    gate?.reset()
    heldRepeat = null
  }

  companion object {
    const val DOUBLE_PRESS_MS = 110L
    /** [phone-remote] how long the screen is kept on after the phone's last press. */
    const val REMOTE_AWAKE_MS = 5 * 60 * 1000L
  }
}
