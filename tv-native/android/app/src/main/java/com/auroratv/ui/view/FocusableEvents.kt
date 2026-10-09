package com.auroratv.ui.view

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/** `onFocusChange {focused, edgeLeft, edgeRight}` — feeds focus.ts's facts (01 §5.2). */
class FocusChangeEvent(
  surfaceId: Int,
  viewTag: Int,
  private val focused: Boolean,
  private val edgeLeft: Boolean,
  private val edgeRight: Boolean,
) : Event<FocusChangeEvent>(surfaceId, viewTag) {
  override fun getEventName() = NAME
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putBoolean("focused", focused)
      putBoolean("edgeLeft", edgeLeft)
      putBoolean("edgeRight", edgeRight)
    }

  companion object {
    const val NAME = "topFocusChange"
  }
}

/** `onPress` (OK released without a long press) / `onLongPress` (OK held 500 ms). */
class PressEvent(surfaceId: Int, viewTag: Int, private val long: Boolean) : Event<PressEvent>(surfaceId, viewTag) {
  override fun getEventName() = if (long) LONG_NAME else NAME
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap()

  companion object {
    const val NAME = "topPress"
    const val LONG_NAME = "topLongPress"
  }
}
