package com.auroratv

import android.os.Bundle
import android.view.KeyEvent
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
    super.onCreate(null)
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

  companion object {
    const val DOUBLE_PRESS_MS = 110L
  }
}
