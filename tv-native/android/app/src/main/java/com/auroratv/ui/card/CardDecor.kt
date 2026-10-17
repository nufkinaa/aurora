package com.auroratv.ui.card

import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReadableArray
import org.json.JSONArray
import org.json.JSONObject

/**
 * render switch `cardtext` (AuroraRender.kt; docs/qa/native-deep/DEVICE-PLAN.md §cardtext):
 * the styles of what the single-view card draws besides its picture, as src/cardDecor.ts
 * built them from Card.tsx's own StyleSheet — colours already through processColor, shadows
 * through processBoxShadow, the bar's gradient through processBackgroundImage. Nothing here
 * is a style value of its own; it is a parse of that JSON, once per launch (the same string
 * on every card).
 */
class CardDecor private constructor(o: JSONObject) {

  /** A Text's attributes (dp, as TextAttributeProps receives them). */
  class Text(o: JSONObject?) {
    val size: Double = o.d("size") ?: 14.0
    val weight: String? = o?.optString("weight")?.takeIf { o.has("weight") }
    val color: Int? = o.i("color")
    val letterSpacing: Double? = o.d("ls")
    val lineHeight: Double? = o.d("lh")
    val align: String? = o?.optString("align")?.takeIf { o.has("align") }
    val marginTop: Double = o.d("mt") ?: 0.0
    val shadowDx: Double
    val shadowDy: Double
    val shadowRadius: Double
    val shadowColor: Int?

    init {
      val s = o?.optJSONObject("shadow")
      shadowDx = s.d("dx") ?: 0.0
      shadowDy = s.d("dy") ?: 0.0
      shadowRadius = s.d("r") ?: 0.0
      shadowColor = s.i("color")
    }
  }

  /** A View's box (Yoga's numbers in dp) and its background (BackgroundStyleApplicator's inputs). */
  class Box(o: JSONObject?) {
    val left: Double? = o.d("left")
    val right: Double? = o.d("right")
    val top: Double? = o.d("top")
    val bottom: Double? = o.d("bottom")
    val width: Double? = o.d("width")
    val height: Double? = o.d("height")
    val maxWidth: Double? = o.d("maxWidth")
    val pt: Double = o.d("pt") ?: 0.0
    val pr: Double = o.d("pr") ?: 0.0
    val pb: Double = o.d("pb") ?: 0.0
    val pl: Double = o.d("pl") ?: 0.0
    val borderWidth: Double = o.d("bw") ?: 0.0
    val borderColor: Int? = o.i("bc")
    val borderRadius: Double = o.d("br") ?: 0.0
    val background: Int? = o.i("bg")
    val clip: Boolean = o?.optBoolean("clip", false) ?: false
    /** processBoxShadow's output: what ReactViewManager.setBoxShadow receives. */
    val shadow: ReadableArray? = o?.optJSONArray("shadow")?.let { toReadable(it) }
    /** processBackgroundImage's output: what ReactViewManager.setBackgroundImage receives. */
    val image: ReadableArray? = o?.optJSONArray("image")?.let { toReadable(it) }
  }

  val label = Box(o.optJSONObject("label"))
  val labelRaised = Box(o.optJSONObject("labelRaised"))
  val labelText = Text(o.optJSONObject("labelText"))
  val labelSub = Text(o.optJSONObject("labelSub"))
  val frameLabel = Box(o.optJSONObject("frameLabel"))
  val frameTitle = Text(o.optJSONObject("frameTitle"))
  val frameSub = Text(o.optJSONObject("frameSub"))
  val frameMeta = Text(o.optJSONObject("frameMeta"))
  val fallbackCentre = Box(o.optJSONObject("fallbackCentre"))
  val fallbackText = Text(o.optJSONObject("fallbackText"))
  val newPill = Box(o.optJSONObject("newPill"))
  val newText = Text(o.optJSONObject("newText"))
  val filmPill = Box(o.optJSONObject("filmPill"))
  val seriesPill = Box(o.optJSONObject("seriesPill"))
  val progress = Box(o.optJSONObject("progress"))
  val progressFrame = Box(o.optJSONObject("progressFrame"))
  val progressFill = Box(o.optJSONObject("progressFill"))
  val progressHead = Box(o.optJSONObject("progressHead"))
  val remove = Box(o.optJSONObject("remove"))
  val removeGlyph = Text(o.optJSONObject("removeGlyph"))
  val iconSize: Double = o.optJSONObject("icon").d("size") ?: 11.0
  val iconFilmColor: Int = o.optJSONObject("icon").i("film") ?: 0
  val iconSeriesColor: Int = o.optJSONObject("icon").i("series") ?: 0

  companion object {
    private val cache = HashMap<String, CardDecor?>()

    /** The parsed decor of a `decor` prop (null when it is empty or unreadable). Once per string. */
    fun of(json: String): CardDecor? {
      if (json.isEmpty()) return null
      return cache.getOrPut(json) {
        try {
          CardDecor(JSONObject(json))
        } catch (_: Throwable) {
          null
        }
      }
    }

    private fun JSONObject?.d(k: String): Double? =
      if (this == null || !has(k) || isNull(k)) null else optDouble(k).takeIf { !it.isNaN() }

    /** A processed colour: processColor's signed 32-bit int (JSON may carry it as a double). */
    private fun JSONObject?.i(k: String): Int? =
      if (this == null || !has(k) || isNull(k)) null else optDouble(k).takeIf { !it.isNaN() }?.toLong()?.toInt()

    /** JSON → the bridge's map/array types, numbers as Double (what a JS number arrives as). */
    fun toReadable(a: JSONArray): JavaOnlyArray {
      val out = JavaOnlyArray()
      for (i in 0 until a.length()) {
        when (val v = a.opt(i)) {
          null, JSONObject.NULL -> out.pushNull()
          is JSONObject -> out.pushMap(toReadable(v))
          is JSONArray -> out.pushArray(toReadable(v))
          is Boolean -> out.pushBoolean(v)
          is Number -> out.pushDouble(v.toDouble())
          else -> out.pushString(v.toString())
        }
      }
      return out
    }

    fun toReadable(o: JSONObject): JavaOnlyMap {
      val out = JavaOnlyMap()
      val keys = o.keys()
      while (keys.hasNext()) {
        val k = keys.next()
        when (val v = o.opt(k)) {
          null, JSONObject.NULL -> out.putNull(k)
          is JSONObject -> out.putMap(k, toReadable(v))
          is JSONArray -> out.putArray(k, toReadable(v))
          is Boolean -> out.putBoolean(k, v)
          is Number -> out.putDouble(k, v.toDouble())
          else -> out.putString(k, v.toString())
        }
      }
      return out
    }
  }
}

/** What one card shows (AuroraCard props, Card.tsx DeepCard). */
data class CardContent(
  /** '' | 'label' | 'labelEp' | 'frame' | 'frameEp' */
  val mode: String = "",
  val t1: String = "",
  val t2: String = "",
  val t3: String = "",
  /** pct != null: the label sits higher (labelRaised). */
  val raised: Boolean = false,
  val tagNew: Boolean = false,
  /** '' | 'film' | 'series' */
  val tagKind: String = "",
  /** 0..100, −1 = no bar. */
  val pct: Int = -1,
  /** The frame card's bar (progressFrame). */
  val frameBar: Boolean = false,
  /** The tile's title (drawn when the tile shows). */
  val tileTitle: String = "",
  /** The ✕ (the focus layer of a removable card). */
  val xGlyph: Boolean = false,
) {
  val hasDecor: Boolean get() = mode.isNotEmpty() || tagNew || tagKind.isNotEmpty() || pct >= 0 || xGlyph
}
