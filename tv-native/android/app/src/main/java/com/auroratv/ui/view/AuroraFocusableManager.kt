package com.auroratv.ui.view

import android.view.View
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * The ViewManager of "AuroraFocusable". It extends ReactViewManager (itself a
 * ViewGroupManager<ReactViewGroup>) rather than a bare ViewGroupManager + the codegen'd
 * delegate, so that every base View prop the JS wrapper's `style` carries — backgroundColor,
 * borderRadius/Width/Color, overflow, opacity, hitSlop, nextFocus*, hasTVPreferredFocus,
 * accessibility* — keeps RN's own setters and drawables (identical pixels to the JS
 * Focusable's Pressable, which is an RCTView). The codegen spec still generates the Fabric
 * ComponentDescriptor and the static view config; its Java delegate is simply not used.
 *
 * The React children's indices are kept separate from the decoration views the
 * AuroraFocusableView owns (highlight before them, the rings after), so Fabric's
 * insert/remove-at-index mount items never see the decorations.
 */
@ReactModule(name = AuroraFocusableManager.NAME)
class AuroraFocusableManager : ReactViewManager() {

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = AuroraFocusableView(context)

  // ---- props -------------------------------------------------------------------------

  @ReactProp(name = "ringKind")
  fun setRingKind(view: ReactViewGroup, v: String?) { f(view).ringKind = v ?: "white" }

  @ReactProp(name = "ringWidth", defaultDouble = 3.0)
  fun setRingWidth(view: ReactViewGroup, v: Double) { f(view).ringWidth = v }

  @ReactProp(name = "ringColor", customType = "Color")
  fun setRingColor(view: ReactViewGroup, v: Int?) { f(view).ringColor = v }

  @ReactProp(name = "ringRadius", defaultDouble = 12.0)
  fun setRingRadius(view: ReactViewGroup, v: Double) { f(view).ringRadius = v }

  @ReactProp(name = "shadowOffsetX", defaultDouble = 0.0)
  fun setShadowOffsetX(view: ReactViewGroup, v: Double) { f(view).shadowOffsetX = v }

  @ReactProp(name = "shadowOffsetY", defaultDouble = 10.0)
  fun setShadowOffsetY(view: ReactViewGroup, v: Double) { f(view).shadowOffsetY = v }

  @ReactProp(name = "shadowBlur", defaultDouble = 24.0)
  fun setShadowBlur(view: ReactViewGroup, v: Double) { f(view).shadowBlur = v }

  @ReactProp(name = "shadowSpread", defaultDouble = 0.0)
  fun setShadowSpread(view: ReactViewGroup, v: Double) { f(view).shadowSpread = v }

  @ReactProp(name = "shadowColor", customType = "Color")
  fun setShadowColor(view: ReactViewGroup, v: Int?) { f(view).shadowColor = v }

  @ReactProp(name = "light")
  fun setLight(view: ReactViewGroup, v: Boolean) { f(view).light = v }

  @ReactProp(name = "lightRingColor", customType = "Color")
  fun setLightRingColor(view: ReactViewGroup, v: Int?) { f(view).lightRingColor = v }

  @ReactProp(name = "lightGapColor", customType = "Color")
  fun setLightGapColor(view: ReactViewGroup, v: Int?) { f(view).lightGapColor = v }

  @ReactProp(name = "highlightColor", customType = "Color")
  fun setHighlightColor(view: ReactViewGroup, v: Int?) { f(view).highlightColor = v }

  @ReactProp(name = "scaleTo", defaultDouble = 1.055)
  fun setScaleTo(view: ReactViewGroup, v: Double) { f(view).scaleTo = v }

  @ReactProp(name = "noScale")
  fun setNoScale(view: ReactViewGroup, v: Boolean) { f(view).noScale = v }

  @ReactProp(name = "lift", defaultDouble = 0.0)
  fun setLift(view: ReactViewGroup, v: Double) { f(view).lift = v }

  @ReactProp(name = "edgeLeft")
  fun setEdgeLeft(view: ReactViewGroup, v: Boolean) { f(view).edgeLeft = v }

  @ReactProp(name = "edgeRight")
  fun setEdgeRight(view: ReactViewGroup, v: Boolean) { f(view).edgeRight = v }

  @ReactProp(name = "holdLeft")
  fun setHoldLeft(view: ReactViewGroup, v: Boolean) { f(view).holdLeft = v }

  @ReactProp(name = "focusDisabled")
  fun setFocusDisabled(view: ReactViewGroup, v: Boolean) { f(view).focusDisabled = v }

  @ReactProp(name = "hasPress", defaultBoolean = true)
  fun setHasPress(view: ReactViewGroup, v: Boolean) { f(view).hasPress = v }

  @ReactProp(name = "hasLongPress")
  fun setHasLongPress(view: ReactViewGroup, v: Boolean) { f(view).hasLongPress = v }

  @ReactProp(name = "preferredFocus")
  fun setPreferredFocus(view: ReactViewGroup, v: Boolean) { f(view).setPreferredFocus(v) }

  /**
   * LAB experiment `shadowcache` (ShadowLayer.kt): the element's own `boxShadow` style is not
   * handed to RN's background drawable but kept for a layered shadow host. Off: RN's setter.
   */
  override fun setBoxShadow(view: ReactViewGroup, shadows: ReadableArray?) {
    if (AuroraFocusableView.SHADOW_CACHE) f(view).ownShadows = shadows else super.setBoxShadow(view, shadows)
  }

  /** The stock prop, should anything pass it: same disarmed path. */
  override fun setTVPreferredFocus(view: ReactViewGroup, hasTVPreferredFocus: Boolean) {
    f(view).setPreferredFocus(hasTVPreferredFocus)
  }

  override fun onAfterUpdateTransaction(view: ReactViewGroup) {
    super.onAfterUpdateTransaction(view)
    f(view).applyProps()
  }

  // ---- events / commands ---------------------------------------------------------------

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    val m: MutableMap<String, Any> = super.getExportedCustomDirectEventTypeConstants()?.toMutableMap() ?: HashMap()
    m[FocusChangeEvent.NAME] = mapOf("registrationName" to "onFocusChange")
    m[PressEvent.NAME] = mapOf("registrationName" to "onPress")
    m[PressEvent.LONG_NAME] = mapOf("registrationName" to "onLongPress")
    return m
  }

  override fun receiveCommand(view: ReactViewGroup, commandId: String, args: ReadableArray?) {
    when (commandId) {
      "clearRing" -> f(view).clearRingFromJS()
      else -> super.receiveCommand(view, commandId, args) // requestTVFocus, setPressed, …
    }
  }

  // ---- React children vs decorations ---------------------------------------------------

  override fun addView(parent: ReactViewGroup, child: View, index: Int) {
    val p = f(parent)
    p.addView(child, index + p.rnOffset())
    p.rnChildCount++
  }

  override fun getChildCount(parent: ReactViewGroup): Int = f(parent).rnChildCount

  override fun getChildAt(parent: ReactViewGroup, index: Int): View? {
    val p = f(parent)
    return p.getChildAt(index + p.rnOffset())
  }

  override fun removeViewAt(parent: ReactViewGroup, index: Int) {
    val p = f(parent)
    p.removeViewAt(index + p.rnOffset())
    p.rnChildCount--
  }

  override fun removeAllViews(parent: ReactViewGroup) {
    f(parent).removeRnChildren()
  }

  // ---- lifecycle -----------------------------------------------------------------------

  override fun prepareToRecycleView(reactContext: ThemedReactContext, view: ReactViewGroup): ReactViewGroup? {
    f(view).resetForRecycle()
    return super.prepareToRecycleView(reactContext, view)
  }

  override fun onDropViewInstance(view: ReactViewGroup) {
    f(view).onDropped()
    super.onDropViewInstance(view)
  }

  private fun f(v: ReactViewGroup) = v as AuroraFocusableView

  companion object {
    const val NAME = "AuroraFocusable"
  }
}
