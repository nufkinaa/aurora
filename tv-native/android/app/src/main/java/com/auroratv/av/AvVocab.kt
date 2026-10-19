package com.auroratv.av

import android.media.MediaCodecInfo.CodecProfileLevel as P

/**
 * The words the server's capability report uses (src/media/avcaps.js), out of
 * Android's numbers: MIME types → codec names, CodecProfileLevel constants →
 * profile names and levels, HDR types and audio encodings → their names.
 * Pure (the constants are compile-time ints): AvVocabTest.kt checks it on
 * the JVM.
 */
object AvVocab {
  /** Video decoder MIME → the report's codec name. */
  val VIDEO_MIME = mapOf(
    "video/avc" to "h264",
    "video/hevc" to "hevc",
    "video/av01" to "av1",
    "video/x-vnd.on2.vp9" to "vp9",
    "video/x-vnd.on2.vp8" to "vp8",
    "video/mpeg2" to "mpeg2",
    "video/mp4v-es" to "mpeg4",
    "video/wvc1" to "vc1",
  )

  /** Audio decoder MIME → the report's codec name (what plays when DECODED here). */
  val AUDIO_MIME = mapOf(
    "audio/mp4a-latm" to "aac",
    "audio/ac3" to "ac3",
    "audio/eac3" to "eac3",
    "audio/eac3-joc" to "eac3",
    "audio/true-hd" to "truehd",
    "audio/vnd.dts" to "dts",
    "audio/vnd.dts.hd" to "dtshd",
    "audio/opus" to "opus",
    "audio/flac" to "flac",
    "audio/mpeg" to "mp3",
    "audio/vorbis" to "vorbis",
    "audio/raw" to "pcm",
    "audio/mpeg-L2" to "mp2",
    "audio/alac" to "alac",
  )

  /** The bitstreams asked about for passthrough: report name → (MIME, channels). */
  val PASSTHROUGH = linkedMapOf(
    "ac3" to ("audio/ac3" to 6),
    "eac3" to ("audio/eac3" to 6),
    "eac3-joc" to ("audio/eac3-joc" to 6),
    "dts" to ("audio/vnd.dts" to 6),
    "dtshd" to ("audio/vnd.dts.hd" to 8),
    "truehd" to ("audio/true-hd" to 8),
  )

  /** A decoder's profile constant → the report's profile name (null: not one it reads). */
  fun profileName(codec: String, profile: Int): String? = when (codec) {
    "h264" -> when (profile) {
      P.AVCProfileBaseline, P.AVCProfileConstrainedBaseline -> "baseline"
      P.AVCProfileMain, P.AVCProfileExtended -> "main"
      P.AVCProfileHigh, P.AVCProfileConstrainedHigh -> "high"
      P.AVCProfileHigh10 -> "high10"
      P.AVCProfileHigh422 -> "high422"
      P.AVCProfileHigh444 -> "high444"
      else -> null
    }
    "hevc" -> when (profile) {
      P.HEVCProfileMain, P.HEVCProfileMainStill -> "main"
      P.HEVCProfileMain10, P.HEVCProfileMain10HDR10, P.HEVCProfileMain10HDR10Plus -> "main10"
      else -> null
    }
    "vp9" -> when (profile) {
      P.VP9Profile0 -> "0"
      P.VP9Profile1 -> "1"
      P.VP9Profile2, P.VP9Profile2HDR, P.VP9Profile2HDR10Plus -> "2"
      P.VP9Profile3, P.VP9Profile3HDR, P.VP9Profile3HDR10Plus -> "3"
      else -> null
    }
    "av1" -> when (profile) {
      P.AV1ProfileMain8, P.AV1ProfileMain10, P.AV1ProfileMain10HDR10, P.AV1ProfileMain10HDR10Plus -> "main"
      else -> null
    }
    else -> null
  }

  /** H.264's level constant → its number (51 = 5.1); 0 when unknown. */
  fun avcLevel(level: Int): Int = when (level) {
    P.AVCLevel1, P.AVCLevel1b -> 10
    P.AVCLevel11 -> 11
    P.AVCLevel12 -> 12
    P.AVCLevel13 -> 13
    P.AVCLevel2 -> 20
    P.AVCLevel21 -> 21
    P.AVCLevel22 -> 22
    P.AVCLevel3 -> 30
    P.AVCLevel31 -> 31
    P.AVCLevel32 -> 32
    P.AVCLevel4 -> 40
    P.AVCLevel41 -> 41
    P.AVCLevel42 -> 42
    P.AVCLevel5 -> 50
    P.AVCLevel51 -> 51
    P.AVCLevel52 -> 52
    P.AVCLevel6 -> 60
    P.AVCLevel61 -> 61
    P.AVCLevel62 -> 62
    else -> 0
  }

  /** A Dolby Vision decoder's profile constant → the profile number; -1 when unknown. */
  fun dvProfile(profile: Int): Int = when (profile) {
    P.DolbyVisionProfileDvavPer -> 0
    P.DolbyVisionProfileDvavPen -> 1
    P.DolbyVisionProfileDvheDer -> 2
    P.DolbyVisionProfileDvheDen -> 3
    P.DolbyVisionProfileDvheDtr -> 4
    P.DolbyVisionProfileDvheStn -> 5
    P.DolbyVisionProfileDvheDth -> 6
    P.DolbyVisionProfileDvheDtb -> 7
    P.DolbyVisionProfileDvheSt -> 8
    P.DolbyVisionProfileDvavSe -> 9
    P.DolbyVisionProfileDvav110 -> 10
    else -> -1
  }

  /** Display.HdrCapabilities' HDR type → the report's name. */
  fun hdrName(type: Int): String? = when (type) {
    1 -> "dv" // HDR_TYPE_DOLBY_VISION
    2 -> "hdr10" // HDR_TYPE_HDR10
    3 -> "hlg" // HDR_TYPE_HLG
    4 -> "hdr10plus" // HDR_TYPE_HDR10_PLUS
    else -> null
  }

  /** A decoder that is software (slow on a TV's cores) — left out of the video report. */
  fun softwareName(name: String): Boolean {
    val n = name.lowercase()
    return n.startsWith("omx.google.") || n.startsWith("c2.android.") || n.startsWith("omx.ffmpeg.") || n.contains(".sw.") || n.endsWith(".sw")
  }
}
