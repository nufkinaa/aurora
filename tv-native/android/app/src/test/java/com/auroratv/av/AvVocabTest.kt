package com.auroratv.av

import android.media.MediaCodecInfo.CodecProfileLevel as P
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android's numbers → the capability report's words (AvVocab.kt; src/media/avcaps.js has the vocabulary). */
class AvVocabTest {
  @Test fun profiles() {
    assertEquals("high", AvVocab.profileName("h264", P.AVCProfileHigh))
    assertEquals("high", AvVocab.profileName("h264", P.AVCProfileConstrainedHigh))
    assertEquals("baseline", AvVocab.profileName("h264", P.AVCProfileConstrainedBaseline))
    assertEquals("high10", AvVocab.profileName("h264", P.AVCProfileHigh10))
    assertEquals("main10", AvVocab.profileName("hevc", P.HEVCProfileMain10))
    assertEquals("main10", AvVocab.profileName("hevc", P.HEVCProfileMain10HDR10))
    assertEquals("main", AvVocab.profileName("hevc", P.HEVCProfileMain))
    assertEquals("2", AvVocab.profileName("vp9", P.VP9Profile2HDR))
    assertEquals("0", AvVocab.profileName("vp9", P.VP9Profile0))
    assertEquals("main", AvVocab.profileName("av1", P.AV1ProfileMain10))
    assertNull(AvVocab.profileName("mpeg2", 1))
    assertNull(AvVocab.profileName("h264", 0x7fff0000))
  }

  @Test fun levelsAndDolbyVision() {
    assertEquals(51, AvVocab.avcLevel(P.AVCLevel51))
    assertEquals(41, AvVocab.avcLevel(P.AVCLevel41))
    assertEquals(0, AvVocab.avcLevel(0))
    assertEquals(5, AvVocab.dvProfile(P.DolbyVisionProfileDvheStn))
    assertEquals(8, AvVocab.dvProfile(P.DolbyVisionProfileDvheSt))
    assertEquals(7, AvVocab.dvProfile(P.DolbyVisionProfileDvheDtb))
    assertEquals(-1, AvVocab.dvProfile(0))
  }

  @Test fun mimesHdrAndSoftware() {
    assertEquals("hevc", AvVocab.VIDEO_MIME["video/hevc"])
    assertEquals("vp9", AvVocab.VIDEO_MIME["video/x-vnd.on2.vp9"])
    assertEquals("eac3", AvVocab.AUDIO_MIME["audio/eac3-joc"])
    assertEquals("dtshd", AvVocab.AUDIO_MIME["audio/vnd.dts.hd"])
    assertEquals(listOf("ac3", "eac3", "eac3-joc", "dts", "dtshd", "truehd"), AvVocab.PASSTHROUGH.keys.toList())
    assertEquals("hdr10", AvVocab.hdrName(2))
    assertEquals("dv", AvVocab.hdrName(1))
    assertNull(AvVocab.hdrName(9))
    assertTrue(AvVocab.softwareName("c2.android.hevc.decoder"))
    assertTrue(AvVocab.softwareName("OMX.google.h264.decoder"))
    assertFalse(AvVocab.softwareName("OMX.amlogic.hevc.decoder.awesome2"))
    assertFalse(AvVocab.softwareName("c2.amlogic.avc.decoder"))
  }
}
