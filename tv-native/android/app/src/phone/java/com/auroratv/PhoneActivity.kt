package com.auroratv

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import com.auroratv.phone.PhoneModule
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.views.view.setEdgeToEdgeFeatureFlagOn

/**
 * The phone app's one activity (docs/android-phone/PLAN.md). The TV's MainActivity carries the
 * remote's key gates, the phone-remote key injection and the display-change reload; none of that
 * belongs on a phone, so the phone build declares this one instead (src/phone/AndroidManifest.xml).
 *
 *  - EDGE TO EDGE on every Android version: the app draws under the status and navigation bars
 *    and keeps its content clear of them with the safe-area insets (Android 15+ enforces this
 *    anyway; older phones now look the same).
 *  - PICTURE-IN-PICTURE: while a film plays the player says so (PhoneModule.setPip) and leaving
 *    the app — Home, the gesture, the recents button — shrinks it into a window instead of
 *    stopping it. Android 12+ does it by itself (auto-enter, smooth); older versions from
 *    onUserLeaveHint.
 *  - Predictive back: android:enableOnBackInvokedCallback in the manifest; ReactActivity already
 *    takes Back through the OnBackPressedDispatcher.
 */
class PhoneActivity : ReactActivity() {

  override fun getMainComponentName(): String = "AuroraPhone"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * A clean slate, never Android's saved state — the same react-native-screens crash the TV's
   * MainActivity documents (a recreated activity restoring ScreenStackFragment with no React
   * context behind it).
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    setEdgeToEdgeFeatureFlagOn()
    super.onCreate(null)
    PhoneModule.attach(this)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }

  /** Before Android 12 there is no auto-enter: going Home while a film plays enters it here. */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    PhoneModule.onUserLeaveHint(this)
  }

  override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(inPip, newConfig)
    PhoneModule.onPipChanged(inPip)
  }

  override fun onDestroy() {
    PhoneModule.detach(this)
    super.onDestroy()
  }
}
