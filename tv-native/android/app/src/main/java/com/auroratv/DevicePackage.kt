package com.auroratv

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** AuroraDevice (DeviceModule.kt): what the box is and how it is coping; AuroraArt (ArtPrefetchModule.kt);
 *  AuroraVoice (VoiceModule.kt): voice search with the remote's microphone. */
class DevicePackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(DeviceModule(ctx), ArtPrefetchModule(ctx), VoiceModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
