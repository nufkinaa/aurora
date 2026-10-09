package com.auroratv.ui.view

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraRailPanel" (src/specs/AuroraRailPanelNativeComponent.ts).
 * ReactViewManager: both parts keep every stock View prop (`pointerEvents`, zIndex, the
 * strip's padding and alignment) and RN's own child handling — the mark, the dots and the
 * focus guide with the items are plain React children.
 */
@ReactModule(name = AuroraRailPanelManager.NAME)
class AuroraRailPanelManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraRailPanelView(context)

  @ReactProp(name = "part")
  fun setPart(view: ReactViewGroup, v: String?) {
    p(view).part = if (v == AuroraRailPanelView.PART_PANEL) AuroraRailPanelView.PART_PANEL else AuroraRailPanelView.PART_STRIP
  }

  @ReactProp(name = "link")
  fun setLink(view: ReactViewGroup, v: String?) { p(view).linkProp = v ?: "" }

  @ReactProp(name = "open", defaultBoolean = false)
  fun setOpen(view: ReactViewGroup, v: Boolean) { p(view).open = v }

  @ReactProp(name = "closing", defaultBoolean = false)
  fun setClosing(view: ReactViewGroup, v: Boolean) { p(view).closing = v }

  @ReactProp(name = "lite", defaultBoolean = false)
  fun setLite(view: ReactViewGroup, v: Boolean) { p(view).lite = v }

  override fun onAfterUpdateTransaction(view: ReactViewGroup) {
    super.onAfterUpdateTransaction(view)
    p(view).applyProps()
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    val m: MutableMap<String, Any> = super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: HashMap()
    m[RailSlideEndEvent.NAME] = mapOf("registrationName" to "onSlideEnd")
    return m
  }

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    p(view).resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  override fun onDropViewInstance(view: ReactViewGroup) {
    p(view).onDropped()
    super.onDropViewInstance(view)
  }

  private fun p(v: ReactViewGroup) = v as AuroraRailPanelView

  companion object {
    const val NAME = "AuroraRailPanel"
  }
}
