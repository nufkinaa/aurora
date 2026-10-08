package com.auroratv

import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Build
import android.os.SystemClock
import android.view.accessibility.AccessibilityManager

/**
 * The accessibility-services answer, cached — react-native-tvos PR #1159, for an app that
 * runs the published react-android AAR.
 *
 * react-native-tvos 0.86.0-2's ReactViewManager.onAfterUpdateTransaction calls
 * manageFocusGuideAccessibilityDelegate() on EVERY view update — every frame of a
 * native-driver animation included — and that function always asks
 * AccessibilityManager.getEnabledAccessibilityServiceList(), a synchronous binder call to
 * system_server on the UI thread. Upstream fixed it in #1159 (merged 2026-10-07); this app
 * links the prebuilt Maven artifact, so patching node_modules' Kotlin source changes nothing in
 * the APK. Instead the build rewrites that one call site (app/build.gradle,
 * A11yQueryRewrite: ReactViewManager only) to call [enabledList] here, which answers the same
 * question without the binder call in the common case:
 *
 *  - no accessibility service running at all (`isEnabled`, local state, no binder call): the
 *    list is empty — exactly what the binder call would have returned — the PR's own shortcut;
 *  - otherwise the last answer, kept until the system says the set of services or the
 *    accessibility state changed (listeners), and at most [MAX_AGE_MS] old as a backstop for
 *    any change no listener reports (API < 33 has no services-changed callback).
 *
 * Every outcome of the caller is the same as before: it only reads which services are on.
 */
object A11yServices {
  private const val MAX_AGE_MS = 5_000L

  private class Entry(val flags: Int, val list: List<AccessibilityServiceInfo>, val at: Long)

  @Volatile private var cached: Entry? = null
  @Volatile private var listening: AccessibilityManager? = null

  private fun listen(am: AccessibilityManager) {
    if (listening === am) return
    synchronized(this) {
      if (listening === am) return
      listening = am
      val drop = { _: Any? -> cached = null }
      am.addAccessibilityStateChangeListener { drop(null) }
      am.addTouchExplorationStateChangeListener { drop(null) }
      if (Build.VERSION.SDK_INT >= 33) {
        am.addAccessibilityServicesStateChangeListener { drop(null) }
      }
    }
  }

  @JvmStatic
  fun enabledList(am: AccessibilityManager, feedbackTypeFlags: Int): List<AccessibilityServiceInfo> {
    // isEnabled is answered from the manager's own state; the list is the binder call.
    if (!am.isEnabled) return emptyList()
    listen(am)
    val now = SystemClock.uptimeMillis()
    val c = cached
    if (c != null && c.flags == feedbackTypeFlags && now - c.at < MAX_AGE_MS) return c.list
    val fresh = am.getEnabledAccessibilityServiceList(feedbackTypeFlags).toList()
    cached = Entry(feedbackTypeFlags, fresh, now)
    return fresh
  }
}
