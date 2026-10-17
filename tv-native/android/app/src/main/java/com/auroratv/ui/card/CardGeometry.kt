package com.auroratv.ui.card

import kotlin.math.max

/**
 * Where Yoga puts the boxes of Card.tsx's words, pills and progress bar — render switch
 * `cardtext` (CardDecor.kt; docs/qa/native-deep/DEVICE-PLAN.md §cardtext). Pure: no Android
 * types, so the JVM tests (CardGeometryTest) pin it against hand-computed Yoga results.
 *
 * Everything is in the card's PADDING BOX (the native art view's own rect: absolute fill
 * inside the card's 1 dp border), with that box's origin taken as Yoga's absolute origin. On a
 * canvas where the card sits on the pixel grid (density 2 on the Mi TV: every dp of these
 * styles is a whole pixel) that is exact; elsewhere a box may land one pixel off, which the
 * device's pixel diff would show.
 *
 * Fabric's Yoga rounds every node like this (yoga/algorithm/PixelGrid.cpp; Fabric never marks
 * a node as text, so no forced ceil/floor): a node's position RELATIVE to its parent is
 * rounded half-up, its size is round(absolute right) − round(absolute left). Android then
 * places each view at the rounded relative position, so the drawn absolute position is the
 * SUM of the rounded relative positions along the chain.
 */
object CardGeometry {

  /** yoga::roundValueToPixelGrid(value, scale, false, false), returning PIXELS. */
  fun roundPx(dp: Double, scale: Double): Double {
    var scaled = dp * scale
    var fract = scaled % 1.0
    if (fract < 0) fract += 1.0
    scaled =
      when {
        inexact(fract, 0.0) -> scaled - fract
        inexact(fract, 1.0) -> scaled - fract + 1.0
        else -> scaled - fract + (if (fract > 0.5 || inexact(fract, 0.5)) 1.0 else 0.0)
      }
    return scaled
  }

  private fun inexact(a: Double, b: Double) = Math.abs(a - b) < 0.0001

  /** One laid-out node: drawn at (x, y) px in the padding box, w × h px. */
  data class Box(val x: Int, val y: Int, val w: Int, val h: Int)

  /**
   * A node at (relX, relY) dp inside a parent whose UNROUNDED absolute origin is (absX, absY)
   * dp and whose DRAWN origin is (drawX, drawY) px, `w` × `h` dp.
   */
  class Node(val absX: Double, val absY: Double, val box: Box)

  fun place(parent: Node?, relX: Double, relY: Double, w: Double, h: Double, s: Double): Node {
    val pAbsX = parent?.absX ?: 0.0
    val pAbsY = parent?.absY ?: 0.0
    val ax = pAbsX + relX
    val ay = pAbsY + relY
    val x = roundPx(relX, s).toInt() + (parent?.box?.x ?: 0)
    val y = roundPx(relY, s).toInt() + (parent?.box?.y ?: 0)
    val pw = (roundPx(ax + w, s) - roundPx(ax, s)).toInt()
    val ph = (roundPx(ay + h, s) - roundPx(ay, s)).toInt()
    return Node(ax, ay, Box(x, y, pw, ph))
  }

  /** The padding box itself (the art view): w × h px at density s. */
  fun root(wPx: Int, hPx: Int): Node = Node(0.0, 0.0, Box(0, 0, wPx, hPx))

  /** A measured Text: its height in px (Layout.getLineBottom) and its top margin in dp. */
  class Line(val hPx: Int, val marginTopDp: Double)

  /**
   * `.card-label` / the frame card's label: an absolute column with `left`, `right` and
   * `bottom` set, its Text children stretched to its width, stacked with their margins.
   * Returns [label, line 0, line 1, …].
   */
  fun stack(root: Node, rootWdp: Double, rootHdp: Double, left: Double, right: Double, bottom: Double, lines: List<Line>, s: Double): List<Node> {
    val w = rootWdp - left - right
    var h = 0.0
    for (l in lines) h += l.marginTopDp + l.hPx / s
    val label = place(root, left, rootHdp - bottom - h, w, h, s)
    val out = ArrayList<Node>(lines.size + 1)
    out.add(label)
    var y = 0.0
    for (l in lines) {
      y += l.marginTopDp
      out.add(place(label, 0.0, y, w, l.hPx / s, s))
      y += l.hPx / s
    }
    return out
  }

  /**
   * A pill: an absolute View with `top` and `left` (or `right`), sized by its content (the
   * Text's measured px, or the 11 dp icon) plus padding and border. Returns [pill, content].
   * `contentWdp` / `contentHdp` in dp.
   */
  fun pill(
    root: Node, rootWdp: Double, top: Double, left: Double?, right: Double?,
    contentWdp: Double, contentHdp: Double,
    pt: Double, pr: Double, pb: Double, pl: Double, bw: Double, s: Double,
  ): List<Node> {
    val w = contentWdp + pl + pr + 2 * bw
    val h = contentHdp + pt + pb + 2 * bw
    val x = left ?: (rootWdp - (right ?: 0.0) - w)
    val p = place(root, x, top, w, h, s)
    val c = place(p, bw + pl, bw + pt, contentWdp, contentHdp, s)
    return listOf(p, c)
  }

  /**
   * `.card-progress`: the track (absolute, left/right/bottom/height), the fill (`width: pct%`,
   * height 100 %) and the bead (absolute right −3 top −2, 8 × 8 inside the fill).
   * Returns [track, fill, head].
   */
  fun progress(
    root: Node, rootWdp: Double, rootHdp: Double, left: Double, right: Double, bottom: Double, height: Double,
    pct: Int, headRight: Double, headTop: Double, headW: Double, headH: Double, s: Double,
  ): List<Node> {
    val tw = rootWdp - left - right
    val track = place(root, left, rootHdp - bottom - height, tw, height, s)
    val fw = tw * pct / 100.0
    val fill = place(track, 0.0, 0.0, fw, height, s)
    val head = place(fill, fw - headRight - headW, headTop, headW, headH, s)
    return listOf(track, fill, head)
  }

  /**
   * A Text centred in a box (`alignItems/justifyContent: center`, padding `pad`), the box at
   * (bx, by) dp, bw × bh dp (the fallback tile's title, the ✕). Returns [box, text].
   */
  fun centred(root: Node, bx: Double, by: Double, bwDp: Double, bhDp: Double, pad: Double, textWpx: Int, textHpx: Int, s: Double): List<Node> {
    val box = place(root, bx, by, bwDp, bhDp, s)
    val tw = textWpx / s
    val th = textHpx / s
    val innerW = bwDp - 2 * pad
    val innerH = bhDp - 2 * pad
    val t = place(box, pad + (innerW - tw) / 2.0, pad + (innerH - th) / 2.0, tw, th, s)
    return listOf(box, t)
  }

  /** The widest a Text may measure inside an AT_MOST box (Yoga hands the measure func px). */
  fun atMostPx(availDp: Double, s: Double): Float = (max(0.0, availDp) * s).toFloat()
}
