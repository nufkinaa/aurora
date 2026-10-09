package com.auroratv.ui.view

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * The ViewManager of "AuroraCard" (src/specs/AuroraCardNativeComponent.ts). A leaf view, so
 * `SimpleViewManager` + BaseViewManager's setters (style, opacity, nativeID — which is what
 * `layout <nativeId>` reads) — the card props are plain @ReactProp setters like P1's
 * Focusable; the codegen spec still generates the Fabric ComponentDescriptor and the static
 * view config. The focus treatment is not here: the JS wrapper puts this view INSIDE the
 * one `Focusable` component the JS card uses (see AuroraCardView's header).
 */
@ReactModule(name = AuroraCardManager.NAME)
class AuroraCardManager : SimpleViewManager<AuroraCardView>() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): AuroraCardView = AuroraCardView(context)

  // ---- props -------------------------------------------------------------------------

  @ReactProp(name = "uri")
  fun setUri(view: AuroraCardView, v: String?) { view.uri = v ?: "" }

  @ReactProp(name = "headersJson")
  fun setHeadersJson(view: AuroraCardView, v: String?) { view.headersJson = v ?: "" }

  @ReactProp(name = "sized")
  fun setSized(view: AuroraCardView, v: Boolean) { view.sized = v }

  @ReactProp(name = "retryUri")
  fun setRetryUri(view: AuroraCardView, v: String?) { view.retryUri = v ?: "" }

  @ReactProp(name = "backupUri")
  fun setBackupUri(view: AuroraCardView, v: String?) { view.backupUri = v ?: "" }

  @ReactProp(name = "backupHeadersJson")
  fun setBackupHeadersJson(view: AuroraCardView, v: String?) { view.backupHeadersJson = v ?: "" }

  @ReactProp(name = "blurUri")
  fun setBlurUri(view: AuroraCardView, v: String?) { view.blurUri = v ?: "" }

  @ReactProp(name = "shade")
  fun setShade(view: AuroraCardView, v: String?) { view.shade = v ?: "none" }

  @ReactProp(name = "brighten")
  fun setBrighten(view: AuroraCardView, v: Boolean) { view.brighten = v }

  @ReactProp(name = "tile")
  fun setTile(view: AuroraCardView, v: Boolean) { view.tile = v }

  override fun onAfterUpdateTransaction(view: AuroraCardView) {
    super.onAfterUpdateTransaction(view)
    view.applyProps()
  }

  // ---- events / commands ---------------------------------------------------------------

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    val m: MutableMap<String, Any> = super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: HashMap()
    m[CardImageEvent.LOADED] = mapOf("registrationName" to "onImageLoaded")
    m[CardImageEvent.FAILED] = mapOf("registrationName" to "onImageFailed")
    m[CardImageEvent.RETRY] = mapOf("registrationName" to "onImageRetry")
    return m
  }

  override fun receiveCommand(view: AuroraCardView, commandId: String, args: ReadableArray?) {
    when (commandId) {
      "unpark" -> view.unpark()
      else -> super.receiveCommand(view, commandId, args)
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: AuroraCardView): AuroraCardView? {
    view.resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  override fun onDropViewInstance(view: AuroraCardView) {
    view.onDropped()
    super.onDropViewInstance(view)
  }

  companion object {
    const val NAME = "AuroraCard"
  }
}
