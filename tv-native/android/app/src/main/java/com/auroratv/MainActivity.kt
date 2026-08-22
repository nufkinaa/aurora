package com.auroratv

import android.os.Bundle
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
}
