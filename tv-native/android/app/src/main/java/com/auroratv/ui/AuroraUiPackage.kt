package com.auroratv.ui

import com.auroratv.ui.qa.AuroraQaModule
import com.auroratv.ui.view.AuroraCardManager
import com.auroratv.ui.view.AuroraFocusableManager
import com.auroratv.ui.view.AuroraRowManager
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * The native rendering layer (docs/native-rewrite): the Fabric components and the two
 * small modules beside them — AuroraImpl (which implementation each component uses this
 * launch) and AuroraQA (the harness's flags). Registered in MainApplication.kt.
 */
class AuroraUiPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(AuroraImplModule(ctx), AuroraQaModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(AuroraFocusableManager(), AuroraCardManager(), AuroraRowManager())
}
