package com.auroratv.ui

import com.auroratv.ui.qa.AuroraQaModule
import com.auroratv.ui.view.AuroraCardManager
import com.auroratv.ui.view.AuroraFocusableManager
import com.auroratv.ui.view.AuroraHeroArtManager
import com.auroratv.ui.view.AuroraRailPanelManager
import com.auroratv.ui.view.AuroraRowManager
import com.auroratv.ui.view.AuroraSlideColumnManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * The native rendering layer (docs/qa/native-lab/, docs/native-rewrite): the Fabric components
 * and the two small modules beside them — AuroraRender (which components and render fixes this
 * launch uses; all off unless switched on) and AuroraQA (the device harness's flags, inert in a
 * normal release). Registered in MainApplication.kt. A component that is switched off is never
 * created: its view manager only answers when JS mounts it.
 */
class AuroraUiPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(AuroraRenderModule(ctx), AuroraQaModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(
      AuroraFocusableManager(),
      AuroraCardManager(),
      AuroraRowManager(),
      AuroraSlideColumnManager(),
      AuroraHeroArtManager(),
      AuroraRailPanelManager(),
    )
}
