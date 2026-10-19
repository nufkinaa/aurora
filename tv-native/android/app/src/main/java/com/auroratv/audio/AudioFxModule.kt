package com.auroratv.audio

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager

/**
 * AuroraAudioFx — night mode and dialogue boost (AudioFx.kt does the work; src/audioFx.ts
 * is the JS side).
 *   set(night, dialogue)   the person's two switches, for every player now and later
 *   status() -> {supported, sdk, passthrough, offload, channels, active, error, night, dialogue}
 *   event "AuroraAudioFx"  the same status, whenever it changes (a bitstream track opened,
 *                          the effect attached, a player released)
 */
class AudioFxModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AuroraAudioFx"

  init {
    AudioFx.onStatus = { s ->
      try {
        if (ctx.hasActiveReactInstance()) {
          ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("AuroraAudioFx", map(s))
        }
      } catch (_: Throwable) {}
    }
  }

  private fun map(s: AudioFx.Status): WritableMap =
      Arguments.createMap().apply {
        putBoolean("supported", s.supported)
        putInt("sdk", s.sdk)
        putBoolean("passthrough", s.passthrough)
        putBoolean("offload", s.offload)
        putInt("channels", s.channels)
        putBoolean("active", s.active)
        if (s.error != null) putString("error", s.error) else putNull("error")
        putBoolean("night", s.night)
        putBoolean("dialogue", s.dialogue)
      }

  @ReactMethod
  fun set(night: Boolean, dialogue: Boolean) = AudioFx.setWanted(night, dialogue)

  @ReactMethod
  fun status(promise: Promise) {
    try {
      promise.resolve(map(AudioFx.status()))
    } catch (t: Throwable) {
      promise.reject("E_AUDIOFX", t)
    }
  }

  // NativeEventEmitter's bookkeeping (nothing to do: the events are always sent)
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}
}

class AudioFxPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AudioFxModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
