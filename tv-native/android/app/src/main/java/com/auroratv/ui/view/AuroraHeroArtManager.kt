package com.auroratv.ui.view

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraHeroArt" (src/specs/AuroraHeroArtNativeComponent.ts).
 * ReactViewManager: the art keeps every stock View prop (`pointerEvents="none"`) and RN's
 * own child handling — the trailer layer is a plain React child.
 */
@ReactModule(name = AuroraHeroArtManager.NAME)
class AuroraHeroArtManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraHeroArtView(context)

  @ReactProp(name = "link")
  fun setLink(view: ReactViewGroup, v: String?) { a(view).linkProp = v ?: "" }

  @ReactProp(name = "restUri")
  fun setRestUri(view: ReactViewGroup, v: String?) { a(view).restUri = v ?: "" }

  @ReactProp(name = "restHeadersJson")
  fun setRestHeadersJson(view: ReactViewGroup, v: String?) { a(view).restHeadersJson = v ?: "" }

  @ReactProp(name = "restBlur", defaultFloat = 0f)
  fun setRestBlur(view: ReactViewGroup, v: Float) { a(view).restBlur = v }

  @ReactProp(name = "scrolledUri")
  fun setScrolledUri(view: ReactViewGroup, v: String?) { a(view).scrolledUri = v ?: "" }

  @ReactProp(name = "scrolledHeadersJson")
  fun setScrolledHeadersJson(view: ReactViewGroup, v: String?) { a(view).scrolledHeadersJson = v ?: "" }

  @ReactProp(name = "scrolledBlur", defaultFloat = 0f)
  fun setScrolledBlur(view: ReactViewGroup, v: Float) { a(view).scrolledBlur = v }

  @ReactProp(name = "restDim", defaultDouble = 0.45)
  fun setRestDim(view: ReactViewGroup, v: Double) { a(view).restDim = v }

  @ReactProp(name = "scrolledDim", defaultDouble = 0.42)
  fun setScrolledDim(view: ReactViewGroup, v: Double) { a(view).scrolledDim = v }

  @ReactProp(name = "fadeOutAt", defaultDouble = 0.0)
  fun setFadeOutAt(view: ReactViewGroup, v: Double) { a(view).fadeOutAt = v }

  @ReactProp(name = "fadeInAt", defaultDouble = 0.0)
  fun setFadeInAt(view: ReactViewGroup, v: Double) { a(view).fadeInAt = v }

  override fun onAfterUpdateTransaction(view: ReactViewGroup) {
    super.onAfterUpdateTransaction(view)
    a(view).applyProps()
  }

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    a(view).resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  override fun onDropViewInstance(view: ReactViewGroup) {
    a(view).onDropped()
    super.onDropViewInstance(view)
  }

  private fun a(v: ReactViewGroup) = v as AuroraHeroArtView

  companion object {
    const val NAME = "AuroraHeroArt"
  }
}
