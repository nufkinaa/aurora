package com.auroratv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

/**
 * Hears how a quiet update went (UpdaterModule.installQuietly).
 *
 * A successful install replaces this process, so nothing is heard for it. What
 * arrives here is the other two outcomes: Android wants the viewer to confirm
 * after all (STATUS_PENDING_USER_ACTION), or the install failed. Either way
 * the result is written down — the app reads it on its next check and goes
 * back to offering the update with the ordinary prompt — and a session that
 * is waiting for a confirmation nobody is there to give is abandoned, so it
 * never pops a dialog over whatever the TV is showing.
 */
class UpdateResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try {
      val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
      context.getSharedPreferences(UpdaterModule.PREFS, Context.MODE_PRIVATE)
        .edit()
        .putInt(UpdaterModule.KEY_STATUS, status)
        .putLong(UpdaterModule.KEY_AT, System.currentTimeMillis())
        .apply()
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (sessionId >= 0) {
          try {
            context.packageManager.packageInstaller.abandonSession(sessionId)
          } catch (_: Exception) {}
        }
      }
    } catch (_: Exception) {}
  }
}
