package com.auroratv

import android.app.Application
import android.content.ComponentCallbacks2
import com.auroratv.ui.AuroraUiPackage
import com.auroratv.ui.qa.AuroraQa
import com.facebook.common.logging.FLog
import com.facebook.common.memory.MemoryTrimType
import com.facebook.common.memory.MemoryTrimmable
import com.facebook.common.memory.MemoryTrimmableRegistry
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.listener.RequestListener
import com.facebook.imagepipeline.listener.RequestLoggingListener
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.modules.fresco.FrescoModule
import com.facebook.react.shell.MainPackageConfig
import java.util.concurrent.CopyOnWriteArrayList

class MainApplication : Application(), ReactApplication {

  /**
   * Fresco's memory caches register here (ImagePipelineConfig.setMemoryTrimmableRegistry), so
   * the system's onTrimMemory reaches them. React Native's default config wires them to a
   * no-op registry: the decoded-bitmap cache only ever shrank when the app was destroyed.
   */
  private val trimRegistry =
      object : MemoryTrimmableRegistry {
        val trimmables = CopyOnWriteArrayList<MemoryTrimmable>()

        override fun registerMemoryTrimmable(trimmable: MemoryTrimmable) {
          trimmables.add(trimmable)
        }

        override fun unregisterMemoryTrimmable(trimmable: MemoryTrimmable) {
          trimmables.remove(trimmable)
        }
      }

  /**
   * React Native's own Fresco configuration (FrescoModule.getDefaultConfigBuilder: its OkHttp
   * client, cookie forwarding, downsample mode) with two additions, handed to the main package
   * so FrescoModule initialises Fresco with it — Fresco.initialize is NOT called here. Cache
   * sizes and bitmap config are untouched (no RGB_565, no HARDWARE bitmaps).
   *
   *  - the trim registry above;
   *  - QA only: RequestLoggingListener + verbose FLog, so a QA build can be watched with
   *    `adb logcat -s RequestLoggingListener` (every request's producers, cache hits and
   *    timings). Off in a normal release; on in debug builds or a release built with
   *    `./gradlew assembleRelease -PfrescoLog`.
   */
  private fun frescoConfig(): MainPackageConfig {
    // getDefaultConfigBuilder wants a ReactContext but only reads its application context;
    // there is no React instance yet when the package list is built, so a bare context
    // wrapper stands in (the only concrete one React Native exposes).
    @Suppress("DEPRECATION")
    val builder = FrescoModule.getDefaultConfigBuilder(BridgeReactContext(applicationContext))
    builder.setMemoryTrimmableRegistry(trimRegistry)
    if (BuildConfig.FRESCO_LOGGING) {
      FLog.setMinimumLoggingLevel(FLog.VERBOSE)
      // the defaults' own listeners (React Native's Systrace one) stay; logging joins them
      val listeners = HashSet<RequestListener>(builder.build().requestListeners)
      listeners.add(RequestLoggingListener())
      builder.setRequestListeners(listeners)
    }
    com.auroratv.ui.art.ArtProbe.attach(this, builder) // LAB art-format: decode probe, inert unless its flag is on (ui/art/ArtProbe.kt)
    return MainPackageConfig(builder.build())
  }

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this, frescoConfig()).packages.apply {
          // Aurora's own native modules: the in-app updater (and home-screen rows),
          // what the box is / how it is coping (perfTier.ts), and YouTube trailers
          // resolved on the TV (trailers.ts).
          add(UpdaterPackage())
          add(DevicePackage())
          add(TrailersPackage())
          // The native rendering layer (docs/native-rewrite): Fabric components behind
          // the AuroraImpl switch, plus the QA module (tools/tv-pixel-diff/PROTOCOL.md).
          add(AuroraUiPackage())
          add(com.auroratv.ui.art.ArtPackage()) // LAB art-format: the artWebp switch for JS (ui/art/ArtFormat.kt)
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // QA flags (freeze / trace / focuslog) before any view exists, so the first frame
    // already honours them; inert unless the QA broadcast ever set one.
    AuroraQa.load(this)
    // LAB: the rendering experiments (AuroraExp.kt), read once per process.
    com.auroratv.ui.AuroraExp.ensureLoaded(this)
    loadReactNative(this)
  }

  /**
   * The app left the screen (UI_HIDDEN — the screensaver, Home, another app) or the system is
   * reclaiming memory while it is in the background: Fresco's memory caches are emptied.
   * Pictures a view is still holding are not freed by this (only what no view is drawing),
   * and everything is still on disk. Running low WHILE on screen trims rather than clears.
   */
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    val type =
        when {
          level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> MemoryTrimType.OnAppBackgrounded
          level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ->
              MemoryTrimType.OnSystemMemoryCriticallyLowWhileAppInForeground
          else -> null
        } ?: return
    for (t in trimRegistry.trimmables) {
      try {
        t.trim(type)
      } catch (_: Throwable) {}
    }
    if (type == MemoryTrimType.OnAppBackgrounded) {
      try {
        if (Fresco.hasBeenInitialized()) Fresco.getImagePipeline().clearMemoryCaches()
      } catch (_: Throwable) {}
    }
  }
}
