package com.auroratv.ui.view

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/** `onRowFocus {index}` — focus landed in shelf `index` of Home's column, or in the hero (-1). */
class ColumnRowFocusEvent(surfaceId: Int, viewTag: Int, private val index: Int) :
  Event<ColumnRowFocusEvent>(surfaceId, viewTag) {
  override fun getEventName() = NAME
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap().apply { putInt("index", index) }

  companion object {
    const val NAME = "topRowFocus"
  }
}
