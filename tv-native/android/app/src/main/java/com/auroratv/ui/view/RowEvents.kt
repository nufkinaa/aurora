package com.auroratv.ui.view

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/** `onItemFocus {index}` — a descendant of the shelf gained focus (AuroraRowView). */
class RowItemFocusEvent(surfaceId: Int, viewTag: Int, private val index: Int) :
  Event<RowItemFocusEvent>(surfaceId, viewTag) {
  override fun getEventName() = NAME
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap().apply { putInt("index", index) }

  companion object {
    const val NAME = "topItemFocus"
  }
}
