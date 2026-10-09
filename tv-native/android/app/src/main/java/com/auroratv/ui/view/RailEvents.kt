package com.auroratv.ui.view

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/** `onSlideEnd {open}` — the rail's close slide reached 0 (the callback of NavRail.tsx close()'s timing). */
class RailSlideEndEvent(surfaceId: Int, viewTag: Int, private val open: Boolean) :
  Event<RailSlideEndEvent>(surfaceId, viewTag) {
  override fun getEventName() = NAME
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap().apply { putBoolean("open", open) }

  companion object {
    const val NAME = "topSlideEnd"
  }
}
