package com.auroratv.ui.view

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraTextLayer" (src/specs/AuroraTextLayerNativeComponent.ts; render
 * switch `herotext`). ReactViewManager, so every View prop keeps RN's own setter.
 */
@ReactModule(name = AuroraTextLayerManager.NAME)
class AuroraTextLayerManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraTextLayerView(context)

  override fun onAfterUpdateTransaction(view: ReactViewGroup) {
    super.onAfterUpdateTransaction(view) // ends with setLayerType(NONE): take ours back
    (view as? AuroraTextLayerView)?.sync()
  }

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    (view as? AuroraTextLayerView)?.resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  companion object {
    const val NAME = "AuroraTextLayer"
  }
}
