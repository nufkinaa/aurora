package com.auroratv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Opens Aurora again after it updated itself, when the viewer chose
 * "Restart now" (UpdaterModule.armRelaunch) in the last three minutes.
 * An update that installed while the app was in the background, or one the
 * viewer did not ask to restart for, leaves the TV on whatever it is showing.
 */
class RelaunchReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    try {
      val prefs = context.getSharedPreferences(UpdaterModule.PREFS, Context.MODE_PRIVATE)
      val at = prefs.getLong(UpdaterModule.KEY_RELAUNCH, 0L)
      prefs.edit().remove(UpdaterModule.KEY_RELAUNCH).apply()
      if (at <= 0L || System.currentTimeMillis() - at > 3 * 60 * 1000L) return
      val launch = Intent(context, MainActivity::class.java)
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      context.startActivity(launch)
    } catch (_: Exception) {}
  }
}
