package com.auroratv.ui.view

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraSlideColumn" (src/specs/AuroraSlideColumnNativeComponent.ts).
 * ReactViewManager, like AuroraRow's: the column keeps every stock View prop
 * (`pointerEvents="box-none"`, onLayout) and RN's own child handling.
 */
@ReactModule(name = AuroraSlideColumnManager.NAME)
class AuroraSlideColumnManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraSlideColumnView(context)

  @ReactProp(name = "targets")
  fun setTargets(view: ReactViewGroup, v: ReadableArray?) { c(view).setTargets(v) }

  @ReactProp(name = "link")
  fun setLink(view: ReactViewGroup, v: String?) { c(view).setLink(v) }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    val m: MutableMap<String, Any> = super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: HashMap()
    m[ColumnRowFocusEvent.NAME] = mapOf("registrationName" to "onRowFocus")
    return m
  }

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    c(view).resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  override fun onDropViewInstance(view: ReactViewGroup) {
    c(view).onDropped()
    super.onDropViewInstance(view)
  }

  private fun c(v: ReactViewGroup) = v as AuroraSlideColumnView

  companion object {
    const val NAME = "AuroraSlideColumn"
  }
}
