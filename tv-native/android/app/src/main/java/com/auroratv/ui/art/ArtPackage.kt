package com.auroratv.ui.art

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.uimanager.ViewManager

/**
 * LAB — AuroraArt: hands the art-format switches (ArtFormat.kt) to JS as constants, so
 * src/artFormat.ts has them synchronously at startup. Registered in MainApplication.kt.
 */
class ArtModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  init {
    ArtFormat.load(ctx)
  }

  override fun getName() = "AuroraArt"

  override fun getConstants(): Map<String, Any> = mapOf("webp" to ArtFormat.webp, "probe" to ArtFormat.probe, "server" to ArtFormat.server)
}

class ArtPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(ArtModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
