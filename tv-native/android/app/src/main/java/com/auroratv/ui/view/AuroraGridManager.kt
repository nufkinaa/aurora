package com.auroratv.ui.view

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraGrid" (src/specs/AuroraGridNativeComponent.ts). ReactViewManager,
 * like AuroraRow's: the grid body keeps every stock View prop and RN's own child handling
 * (the card slots are plain React children); the codegen spec generates the
 * ComponentDescriptor and the view config.
 */
@ReactModule(name = AuroraGridManager.NAME)
class AuroraGridManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraGridView(context)

  @ReactProp(name = "cols", defaultInt = 1)
  fun setCols(view: ReactViewGroup, v: Int) { g(view).cols = v }

  @ReactProp(name = "colPitch", defaultDouble = 0.0)
  fun setColPitch(view: ReactViewGroup, v: Double) { g(view).colPitch = v }

  @ReactProp(name = "rowPitch", defaultDouble = 0.0)
  fun setRowPitch(view: ReactViewGroup, v: Double) { g(view).rowPitch = v }

  @ReactProp(name = "count", defaultInt = 0)
  fun setCount(view: ReactViewGroup, v: Int) { g(view).count = v }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    val m: MutableMap<String, Any> = super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: HashMap()
    m[RowItemFocusEvent.NAME] = mapOf("registrationName" to "onItemFocus")
    return m
  }

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    g(view).resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  private fun g(v: ReactViewGroup) = v as AuroraGridView

  companion object {
    const val NAME = "AuroraGrid"
  }
}
