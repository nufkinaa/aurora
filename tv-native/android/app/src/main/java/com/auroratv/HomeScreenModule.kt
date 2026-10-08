package com.auroratv

import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

/**
 * Aurora on the TV's own home screen (elia, 2026-10-08: "like Disney+ does").
 *
 * Two things the launcher lets any app publish through the TV provider:
 *
 *   Watch Next — the launcher's "Continue watching" row. What the viewer
 *   stopped in the middle of, with its picture and how far in they are.
 *
 *   A preview channel — a row of Aurora's own ("Recommended on Aurora").
 *   The classic Android TV home shows it once enabled; the Google TV home
 *   mostly reserves such rows for partner apps, so it may not appear there.
 *
 * Every entry carries an `aurora://open?...` link that opens the app on that
 * title (the JS side reads it — homeScreen.ts). Both lists are REPLACED on
 * each call: the provider only ever shows this app its own rows, so deleting
 * "everything" deletes ours alone. The JS side only calls when the list has
 * actually changed.
 *
 * This class is only the bridge. The writing itself lives in HomeScreenRows,
 * shared with the background job (HomeScreenJob) that keeps the rows fresh
 * while the app is closed.
 */
class HomeScreenModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraHomeScreen"

  // Copied out of the bridge's array on the calling thread, so the worker
  // thread below never touches a bridge object.
  private fun entries(items: ReadableArray): List<Map<String, Any?>> {
    val out = ArrayList<Map<String, Any?>>()
    for (i in 0 until items.size()) {
      val m = items.getMap(i) ?: continue
      out.add(m.toHashMap())
    }
    return out
  }

  @ReactMethod
  fun setWatchNext(items: ReadableArray, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(0)
      return
    }
    val list = entries(items)
    Thread {
      try {
        promise.resolve(HomeScreenRows.writeWatchNext(ctx.applicationContext, list))
      } catch (e: Exception) {
        promise.reject("homescreen", e.message ?: "could not write the Continue watching row")
      }
    }.start()
  }

  @ReactMethod
  fun setChannel(name: String, items: ReadableArray, base: String?, session: String?, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(0)
      return
    }
    val list = entries(items)
    Thread {
      try {
        promise.resolve(HomeScreenRows.writeChannel(ctx.applicationContext, name, list, base, session))
      } catch (e: Exception) {
        promise.reject("homescreen", e.message ?: "could not write the channel")
      }
    }.start()
  }

  /**
   * Who the background job asks the server as: where the server is, the
   * sign-in session, the profile, and its unlock token when it has one —
   * exactly the headers api.ts sends. Kept in the app's private preferences
   * (HomeScreenRows.PREFS) and wiped by clear(). Also (re)schedules the job.
   */
  @ReactMethod
  fun configure(base: String?, session: String?, profileId: String?, profileToken: String?, promise: Promise) {
    try {
      HomeScreenRows.configure(ctx.applicationContext, base, session, profileId, profileToken)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * Runs the background job's work right now and says what it did — the way
   * to test the native path without waiting three hours for the system.
   */
  @ReactMethod
  fun refreshNow(promise: Promise) {
    Thread {
      try {
        promise.resolve(HomeScreenRows.refresh(ctx.applicationContext))
      } catch (e: Throwable) {
        promise.resolve("failed: ${e.message}")
      }
    }.start()
  }

  /** Signing out, or the viewer switching the feature off: take our rows away. */
  @ReactMethod
  fun clear(promise: Promise) {
    Thread {
      promise.resolve(HomeScreenRows.clear(ctx.applicationContext))
    }.start()
  }
}
