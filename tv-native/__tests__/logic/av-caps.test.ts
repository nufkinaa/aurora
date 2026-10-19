// Picture and sound (TV round 2026-10-19, src/avCaps.ts): the report this box
// sends (what it decodes, passes through, shows as HDR — minus what it was
// caught lying about), how the player reads the server's decision, which
// failures count as a lie, and when the screen is asked for the film's
// frame rate. Plus the two person-level settings it brings.
import {armPlan, buildReport, lieFrom, mergeLies, NativeAv, profileFor, readPlay, streamPlan, wantsFrameRate} from '../../src/avCaps';
import {streamPlayItem} from '../../src/playBest';
import {PERSON_DEFAULTS, readPerson} from '../../src/personPrefs';

// what AvModule.kt answers on a realistic Mi TV (Amlogic s7d)
const MITV: NativeAv = {
  model: 'MiTV-AFMU0',
  sdk: 34,
  video: {
    h264: {profiles: ['baseline', 'high', 'main'], maxW: 4096, maxH: 2304, maxFps: 120, maxLevel: 51},
    hevc: {profiles: ['main', 'main10'], maxW: 4096, maxH: 2304, maxFps: 120},
    vp9: {profiles: ['0', '2'], maxW: 4096, maxH: 2304},
    mpeg2: {profiles: [], maxW: 1920, maxH: 1088},
  },
  dv: [],
  hdr: ['hdr10', 'hlg'],
  audioDecode: ['aac', 'ac3', 'eac3', 'flac', 'mp3', 'opus', 'pcm', 'vorbis'],
  passthrough: ['ac3', 'eac3', 'eac3-joc'],
  maxChannels: 8,
  display: {w: 1920, h: 1080, hz: 60, modes: [[1920, 1080, 60], [1920, 1080, 50], [1920, 1080, 24]]},
};

describe('the report', () => {
  test('what the box said, in the server’s words; every container ExoPlayer opens', () => {
    const r = buildReport(MITV);
    expect(r.client).toBe('tv');
    expect(r.model).toBe('MiTV-AFMU0');
    expect(Object.keys(r.video).sort()).toEqual(['h264', 'hevc', 'mpeg2', 'vp9']);
    expect(r.video.hevc.profiles).toEqual(['main', 'main10']);
    expect(r.audio).toEqual({decode: MITV.audioDecode, passthrough: ['ac3', 'eac3', 'eac3-joc'], maxChannels: 8});
    expect(r.hdr).toEqual(['hdr10', 'hlg']);
    expect(Object.keys(r.containers).sort()).toEqual(['avi', 'mkv', 'mov', 'mp4', 'ts', 'webm']);
    expect(r.display).toEqual(MITV.display);
  });
  test('minus the lies: a passthrough that failed (and Atmos with its E-AC-3), a decoder, a profile', () => {
    const r = buildReport(MITV, {passthrough: ['eac3'], decode: ['ac3'], video: ['hevc:main10', 'vp9']});
    expect(r.audio.passthrough).toEqual(['ac3']);
    expect(r.audio.decode).not.toContain('ac3');
    expect(r.video.hevc.profiles).toEqual(['main']);
    expect(r.video.vp9).toBeUndefined();
    // the plainest profile lied: the decoder is not trusted with any — the codec is not offered
    const r2 = buildReport(MITV, {video: ['hevc:main']});
    expect(r2.video.hevc).toBeUndefined();
    // H.264 High lied: Baseline and Main stay, High and above go
    expect(buildReport(MITV, {video: ['h264:high']}).video.h264.profiles).toEqual(['baseline', 'main']);
    expect(profileFor('hevc', 10)).toBe('main10');
    expect(profileFor('hevc', 8)).toBe('main');
    expect(profileFor('h264', 8)).toBe('high');
    expect(profileFor('vp9', 10)).toBe('2');
    expect(profileFor('mpeg2', 8)).toBeNull();
  });
  test('a box that could say nothing still sends a report the server reads', () => {
    const r = buildReport(null);
    expect(r).toMatchObject({client: 'tv', video: {}, hdr: [], dv: [], audio: {decode: [], passthrough: []}});
    expect(r.display).toBeUndefined();
  });
});

describe('the decision, read', () => {
  const base = {audioIdx: 0, hasVideoUrl: true, hasBase: true};
  test('direct / remux / transcode → the file, the copy, the encode', () => {
    expect(armPlan({mode: 'direct'}, base)).toBe('direct');
    expect(armPlan({mode: 'remux'}, base)).toBe('copy');
    expect(armPlan({mode: 'transcode'}, base)).toBe('h264');
  });
  test('a dub other than the first track goes through the copy (only the server maps it in)', () => {
    expect(armPlan({mode: 'direct'}, {...base, audioIdx: 2})).toBe('copy');
    expect(armPlan({mode: 'transcode'}, {...base, audioIdx: 2})).toBe('h264');
  });
  test('no decision, or nothing to transcode from: the player’s own rule', () => {
    expect(armPlan(null, base)).toBeNull();
    expect(armPlan({mode: 'direct'}, {...base, hasBase: false})).toBeNull();
    expect(armPlan({mode: 'direct'}, {...base, hasVideoUrl: false})).toBe('h264');
  });
  test('readPlay keeps only a real answer', () => {
    expect(readPlay({mode: 'direct', fps: 23.976})).toEqual({mode: 'direct', fps: 23.976});
    expect(readPlay({mode: 'teleport'})).toBeNull();
    expect(readPlay(null)).toBeNull();
    expect(readPlay('direct')).toBeNull();
  });
  test('a torrent source: the decision replaces the release-tag rule', () => {
    expect(streamPlan({mode: 'direct'})).toEqual({needsTranscode: false, transcodeV: 'copy'});
    expect(streamPlan({mode: 'remux'})).toEqual({needsTranscode: true, transcodeV: 'copy'});
    expect(streamPlan({mode: 'transcode'})).toEqual({needsTranscode: true, transcodeV: 'h264'});
    expect(streamPlan(null)).toBeNull();
    const film = {type: 'movie' as const, imdbId: 'tt1', title: 'Film'};
    const s = {infoHash: 'a'.repeat(40), fileIdx: 0, quality: '2160p', tags: ['H.265', 'DD+', 'HDR']};
    // without a decision: H.265 → the encode (the old rule)
    expect(streamPlayItem(s, film)).toMatchObject({needsTranscode: true, transcodeV: 'h264'});
    // with this box's decision: the HEVC plays as it is, the DD+ goes through
    expect(streamPlayItem({...s, play: {mode: 'direct'}}, film)).toMatchObject({needsTranscode: false, transcodeV: 'copy'});
    expect(streamPlayItem({...s, play: {mode: 'bogus'}}, film)).toMatchObject({needsTranscode: true, transcodeV: 'h264'});
  });
});

describe('the lies', () => {
  const pass = {mode: 'direct' as const, audio: 'passthrough' as const, form: 'eac3'};
  const facts = {videoCodec: 'hevc', videoProfile: 'main10', audioCodec: 'eac3'};
  test('the sound did not open: the passthrough form lied (or the decoder, when it was decoded)', () => {
    expect(lieFrom({detail: 'ExoPlaybackException: ERROR_CODE_AUDIO_TRACK_INIT_FAILED', code: '25001'}, pass, facts)).toEqual({passthrough: ['eac3']});
    expect(lieFrom({code: '25001'}, {mode: 'direct', audio: 'decode'}, facts)).toEqual({decode: ['eac3']});
  });
  test('the picture’s decoder would not start: that codec / profile lied', () => {
    expect(lieFrom({detail: 'ExoPlaybackException: ERROR_CODE_DECODER_INIT_FAILED MediaCodecVideoRenderer video/hevc', code: '24001'}, pass, facts)).toEqual({video: ['hevc:main10']});
    expect(lieFrom({detail: 'ERROR_CODE_DECODING_FORMAT_UNSUPPORTED video/hevc'}, pass, {...facts, videoProfile: null})).toEqual({video: ['hevc']});
    expect(lieFrom({detail: 'ERROR_CODE_DECODER_INIT_FAILED MediaCodecAudioRenderer audio/eac3'}, {mode: 'direct', audio: 'decode'}, facts)).toEqual({decode: ['eac3']});
  });
  test('not a lie: damaged bytes, the network, a start the server did not decide, a non-direct start', () => {
    expect(lieFrom({detail: 'ERROR_CODE_DECODING_FAILED video/hevc', code: '24003'}, pass, facts)).toBeNull();
    expect(lieFrom({detail: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED', code: '22001'}, pass, facts)).toBeNull();
    expect(lieFrom({code: '25001'}, null, facts)).toBeNull();
    expect(lieFrom({code: '25001'}, {mode: 'remux', audio: 'passthrough', form: 'eac3'}, facts)).toBeNull();
    // a decoder failure that names neither side cannot be pinned down
    expect(lieFrom({detail: 'ERROR_CODE_DECODER_INIT_FAILED', code: '24001'}, pass, facts)).toBeNull();
  });
  test('kept lists merge, each entry once', () => {
    expect(mergeLies({passthrough: ['eac3']}, {passthrough: ['eac3', 'dts'], video: ['vp9']})).toEqual({passthrough: ['eac3', 'dts'], video: ['vp9']});
    expect(mergeLies(null, null)).toEqual({});
  });
});

describe('refresh-rate matching', () => {
  test('asked for a known film rate unless the person said Off', () => {
    expect(wantsFrameRate('auto', 23.976)).toBe(true);
    expect(wantsFrameRate(undefined, 25)).toBe(true);
    expect(wantsFrameRate('off', 23.976)).toBe(false);
    expect(wantsFrameRate('auto', 0)).toBe(false);
    expect(wantsFrameRate('auto', null)).toBe(false);
    expect(wantsFrameRate('auto', 1000)).toBe(false);
  });
});

describe('the two settings follow the person', () => {
  test('closed sets, both default Auto', () => {
    expect(PERSON_DEFAULTS.matchFrameRate).toBe('auto');
    expect(PERSON_DEFAULTS.surround).toBe('auto');
    expect(readPerson({matchFrameRate: 'off', surround: 'stereo'})).toEqual({matchFrameRate: 'off', surround: 'stereo'});
    expect(readPerson({matchFrameRate: true, surround: 'dolby'})).toEqual({});
  });
});
