package com.auroratv.ui.view

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/**
 * The native card's picture events (01-architecture.md §2.2). `uri` is always the FIRST
 * address (Card.tsx keys everything by `src.uri`); `shown` the address that loaded/failed.
 *
 *   onImageLoaded {uri, shown}                               → Card.tsx:260-264 markDrawn
 *   onImageFailed {uri, shown, error, tries, tile, parked}   → Card.tsx:222-245 (trackError at tries 1)
 *   onImageRetry  {uri, round}                               a slow round went back to the first address
 */
class CardImageEvent(
  surfaceId: Int,
  viewTag: Int,
  private val name: String,
  private val data: WritableMap,
) : Event<CardImageEvent>(surfaceId, viewTag) {
  override fun getEventName() = name
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = data

  companion object {
    const val LOADED = "topImageLoaded"
    const val FAILED = "topImageFailed"
    const val RETRY = "topImageRetry"

    fun loaded(surfaceId: Int, tag: Int, uri: String, shown: String) =
      CardImageEvent(surfaceId, tag, LOADED, Arguments.createMap().apply {
        putString("uri", uri)
        putString("shown", shown)
      })

    fun failed(surfaceId: Int, tag: Int, uri: String, shown: String, error: String, tries: Int, tile: Boolean, parked: Boolean) =
      CardImageEvent(surfaceId, tag, FAILED, Arguments.createMap().apply {
        putString("uri", uri)
        putString("shown", shown)
        putString("error", error)
        putInt("tries", tries)
        putBoolean("tile", tile)
        putBoolean("parked", parked)
      })

    fun retry(surfaceId: Int, tag: Int, uri: String, round: Int) =
      CardImageEvent(surfaceId, tag, RETRY, Arguments.createMap().apply {
        putString("uri", uri)
        putInt("round", round)
      })
  }
}
