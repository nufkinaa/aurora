package com.auroratv.ui.view

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * The ViewManager of "AuroraGlassEdge" (src/specs/AuroraGlassEdgeNativeComponent.ts): the
 * edge of a glass pane as one view. No children, no events - five picture names.
 */
@ReactModule(name = AuroraGlassEdgeManager.NAME)
class AuroraGlassEdgeManager : SimpleViewManager<AuroraGlassEdgeView>() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): AuroraGlassEdgeView = AuroraGlassEdgeView(context)

  @ReactProp(name = "cornerTop")
  fun setCornerTop(view: AuroraGlassEdgeView, v: String?) { view.cornerTop = v ?: "" }

  @ReactProp(name = "cornerFoot")
  fun setCornerFoot(view: AuroraGlassEdgeView, v: String?) { view.cornerFoot = v ?: "" }

  @ReactProp(name = "runTop")
  fun setRunTop(view: AuroraGlassEdgeView, v: String?) { view.runTop = v ?: "" }

  @ReactProp(name = "runFoot")
  fun setRunFoot(view: AuroraGlassEdgeView, v: String?) { view.runFoot = v ?: "" }

  @ReactProp(name = "runSide")
  fun setRunSide(view: AuroraGlassEdgeView, v: String?) { view.runSide = v ?: "" }

  override fun onAfterUpdateTransaction(view: AuroraGlassEdgeView) {
    super.onAfterUpdateTransaction(view)
    view.invalidate()
  }

  companion object {
    const val NAME = "AuroraGlassEdge"
  }
}
