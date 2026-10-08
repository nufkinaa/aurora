package com.auroratv

import android.app.job.JobParameters
import android.app.job.JobService
import android.util.Log

/**
 * Keeps Aurora's rows on the TV's home screen fresh while the app is closed.
 *
 * Scheduled by HomeScreenRows.schedule() (every three hours, with a network)
 * once the app has said who it is (HomeScreenModule.configure). It asks the
 * server for the profile's home and rewrites Continue watching and Aurora's
 * row through the very functions the app itself uses — no React, no JS: the
 * system starts the process, this runs, and the process is let go again.
 */
class HomeScreenJob : JobService() {
  override fun onStartJob(params: JobParameters?): Boolean {
    val app = applicationContext
    Thread {
      try {
        Log.i(HomeScreenRows.TAG, "background refresh: " + HomeScreenRows.refresh(app))
      } catch (e: Throwable) {
        // the server asleep, the network not up yet: the next run tries again
        Log.w(HomeScreenRows.TAG, "background refresh failed: ${e.message}")
      }
      try {
        jobFinished(params, false)
      } catch (_: Exception) {}
    }.start()
    return true // still working, on the thread above
  }

  // Told to stop early (the network went away): nothing to undo, and no retry
  // asked for — the next period comes round by itself.
  override fun onStopJob(params: JobParameters?): Boolean = false
}
