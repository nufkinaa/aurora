// The player's content clock on a transcode (playback/clock.ts): a COPY job at
// an offset keeps the source's timestamps and starts at the keyframe before
// the offset, so media 0 is X-Aurora-Base, not the offset that names the job.
import {clockBaseFor, clockFromHeaders, MAX_GOP_SEC, toContent, toMedia} from '../../src/playback/clock';

const headers = (h: Record<string, string>) => (name: string) => {
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
  return k == null ? null : h[k];
};

describe('the clock the playlist answer publishes', () => {
  test('both headers', () => {
    expect(clockFromHeaders(headers({'X-Aurora-Base': '93.75', 'X-Aurora-Offset': '6.22'}))).toEqual({base: 93.75, offset: 6.22});
  });
  test('header names are read case-insensitively by fetch — the getter decides', () => {
    expect(clockFromHeaders(headers({'x-aurora-base': '12.5'}))).toEqual({base: 12.5, offset: 0});
  });
  test('no clock: absent, garbage, negative', () => {
    expect(clockFromHeaders(headers({}))).toBeNull();
    expect(clockFromHeaders(headers({'X-Aurora-Base': 'abc'}))).toBeNull();
    expect(clockFromHeaders(headers({'X-Aurora-Base': '-3'}))).toBeNull();
    expect(clockFromHeaders(() => {
      throw new Error('no headers');
    })).toBeNull();
  });
  test('a bad offset is 0, the base still counts', () => {
    expect(clockFromHeaders(headers({'X-Aurora-Base': '50', 'X-Aurora-Offset': 'x'}))).toEqual({base: 50, offset: 0});
    expect(clockFromHeaders(headers({'X-Aurora-Base': '50', 'X-Aurora-Offset': '-1'}))).toEqual({base: 50, offset: 0});
  });
});

describe('content time at media position 0', () => {
  const measured = {base: 93.75, offset: 6.22}; // -ss 100: video 93.75, audio 99.97

  test('a copy job at an offset starts at its keyframe', () => {
    expect(clockBaseFor(100, 'copy', measured)).toBe(93.75);
  });
  test("an encode, ss = 0, or no clock: the offset (today's behaviour)", () => {
    expect(clockBaseFor(100, 'h264', measured)).toBe(100);
    expect(clockBaseFor(100, 'h264-720', measured)).toBe(100);
    expect(clockBaseFor(0, 'copy', {base: 0.04, offset: 0})).toBe(0);
    expect(clockBaseFor(100, 'copy', null)).toBe(100);
    expect(clockBaseFor(100, 'copy', undefined)).toBe(100);
    expect(clockBaseFor(100.9, 'h264', null)).toBe(100); // the URL floors the offset
  });
  test('a base that cannot be this job’s keyframe is not believed', () => {
    // a server that did not keep the timestamps answers ~0 for any offset
    expect(clockBaseFor(600, 'copy', {base: 0.02, offset: 0})).toBe(600);
    expect(clockBaseFor(600, 'copy', {base: 600 - MAX_GOP_SEC - 1, offset: 0})).toBe(600);
    expect(clockBaseFor(600, 'copy', {base: 600 - MAX_GOP_SEC + 1, offset: 0})).toBe(600 - MAX_GOP_SEC + 1);
    // later than asked (audio-first file, rounding) by more than a beat
    expect(clockBaseFor(600, 'copy', {base: 603, offset: 0})).toBe(600);
    expect(clockBaseFor(600, 'copy', {base: 600.4, offset: 0})).toBe(600.4);
  });
  test('round trips', () => {
    expect(toContent(93.75, 6.22)).toBeCloseTo(99.97, 5);
    expect(toMedia(93.75, 99.97)).toBeCloseTo(6.22, 5);
    expect(toMedia(93.75, 50)).toBe(0); // never a negative seek
    expect(toContent(10, NaN)).toBe(10);
  });

  test('the bug, end to end: resuming an EAC3 film at 1:40', () => {
    // ExoPlayer starts at EXT-X-START (the offset) and reports media time from
    // the first sample of segment 0.
    const mediaAtStart = measured.offset;
    const old = 100 + mediaAtStart; // content = streamOffset + currentTime
    const now = toContent(clockBaseFor(100, 'copy', measured), mediaAtStart);
    expect(old - 99.97).toBeGreaterThan(6); // the scrubber, the saved point and every cue 6 s ahead
    expect(Math.abs(now - 99.97)).toBeLessThan(0.01);
    // a cue at content 100.5 is now on screen when the picture is at 100.5
    const cueAt = 100.5;
    expect(toMedia(clockBaseFor(100, 'copy', measured), cueAt)).toBeCloseTo(6.75, 5);
  });
});
