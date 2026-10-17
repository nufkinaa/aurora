package com.auroratv.ui.view

import com.auroratv.ui.row.RowMath
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraRow" (src/specs/AuroraRowNativeComponent.ts). ReactViewManager,
 * like AuroraFocusable's: the track keeps every stock View prop and RN's own child
 * handling (the slots are plain React children, added and removed by Fabric as the JS
 * window moves); the codegen spec generates the ComponentDescriptor and the view config.
 */
@ReactModule(name = AuroraRowManager.NAME)
class AuroraRowManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraRowView(context)

  @ReactProp(name = "step", defaultDouble = 0.0)
  fun setStep(view: ReactViewGroup, v: Double) { r(view).step = v }

  @ReactProp(name = "lead", defaultInt = RowMath.LEAD)
  fun setLead(view: ReactViewGroup, v: Int) { r(view).lead = v }

  @ReactProp(name = "contentLeft", defaultDouble = 84.0)
  fun setContentLeft(view: ReactViewGroup, v: Double) { r(view).contentLeft = v }

  @ReactProp(name = "count", defaultInt = 0)
  fun setCount(view: ReactViewGroup, v: Int) { r(view).count = v }

  @ReactProp(name = "initialIndex", defaultInt = 0)
  fun setInitialIndex(view: ReactViewGroup, v: Int) { r(view).initialIndex = v }

  override fun onAfterUpdateTransaction(view: ReactViewGroup) {
    super.onAfterUpdateTransaction(view)
    r(view).applyProps()
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    val m: MutableMap<String, Any> = super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: HashMap()
    m[RowItemFocusEvent.NAME] = mapOf("registrationName" to "onItemFocus")
    return m
  }

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    r(view).resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  override fun onDropViewInstance(view: ReactViewGroup) {
    r(view).onDropped()
    super.onDropViewInstance(view)
  }

  private fun r(v: ReactViewGroup) = v as AuroraRowView

  companion object {
    const val NAME = "AuroraRow"
  }
}
