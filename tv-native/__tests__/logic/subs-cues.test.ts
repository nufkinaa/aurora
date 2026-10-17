// Reading subtitle files and finding the cue on screen (playback/cues.ts).
import {
  CUE_BOTTOM_LIFTED_FALLBACK,
  CUE_BOTTOM_PLAIN,
  CUE_GAP_ABOVE_CHROME,
  cueBottom,
  cueTextAt,
  parseTs,
  parseVtt,
} from '../../src/playback/cues';

const BOM = String.fromCharCode(0xfeff);

describe('timestamps', () => {
  test('every shape a track uses', () => {
    expect(parseTs('01:02:03.456')).toBeCloseTo(3723.456, 6);
    expect(parseTs('1:02:03.456')).toBeCloseTo(3723.456, 6);
    expect(parseTs('100:00:00.000')).toBe(360000);
    expect(parseTs('02:03.456')).toBeCloseTo(123.456, 6); // no hours (WebVTT)
    expect(parseTs('00:00:01,500')).toBe(1.5); // SRT comma
    expect(parseTs('00:00:01.5')).toBe(1.5); // short fraction
    expect(parseTs('00:00:01.05')).toBe(1.05);
    expect(parseTs('00:01:02')).toBe(62); // no fraction (broken SRT)
    expect(parseTs(' 00:00:04.000 align:start position:10%')).toBe(4);
  });
  test('not a time', () => {
    expect(parseTs('hello')).toBeNull();
    expect(parseTs('00:00:75.000')).toBeNull();
    expect(parseTs('')).toBeNull();
  });
});

describe('parseVtt', () => {
  test('a clean WebVTT file', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:03.000 --> 00:00:04.000\nTwo\nlines\n';
    expect(parseVtt(vtt)).toEqual([
      {start: 1, end: 2.5, text: 'Hello'},
      {start: 3, end: 4, text: 'Two\nlines'},
    ]);
  });

  test('BOM, a titled header, header metadata, X-TIMESTAMP-MAP, NOTE and STYLE blocks, cue ids', () => {
    const vtt = [
      `${BOM}WEBVTT - Hebrew subtitles`,
      'Kind: captions',
      'Language: he',
      'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
      '',
      'NOTE made by someone',
      'over two lines',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'intro-1',
      '00:01.000 --> 00:02.000 line:90%',
      'שלום',
      '',
      '2',
      '00:00:03.000 --> 00:00:04.000',
      'עולם',
    ].join('\n');
    expect(parseVtt(vtt)).toEqual([
      {start: 1, end: 2, text: 'שלום'},
      {start: 3, end: 4, text: 'עולם'},
    ]);
  });

  test('CRLF and bare CR line ends', () => {
    expect(parseVtt('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nA\r\n')).toEqual([{start: 1, end: 2, text: 'A'}]);
    expect(parseVtt('WEBVTT\r\r00:00:01.000 --> 00:00:02.000\rA\r')).toEqual([{start: 1, end: 2, text: 'A'}]);
  });

  test('a raw SRT, as /stream/torrent/sub passes one through (with or without its "WEBVTT" prefix)', () => {
    const srt = `${BOM}1\r\n00:00:01,000 --> 00:00:02,000\r\nFirst\r\n\r\n2\r\n00:00:03,250 --> 00:00:05,000\r\nSecond\r\nline\r\n`;
    const want = [
      {start: 1, end: 2, text: 'First'},
      {start: 3.25, end: 5, text: 'Second\nline'},
    ];
    expect(parseVtt(srt)).toEqual(want);
    expect(parseVtt(`WEBVTT\n\n${srt}`)).toEqual(want);
  });

  test('an SRT whose blank lines went missing', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n3\n00:00:05,000 --> 00:00:06,000\nThird';
    expect(parseVtt(srt).map(c => c.text)).toEqual(['First', 'Second', 'Third']);
  });

  test('markup, ASS overrides and entities are not drawn', () => {
    const vtt =
      'WEBVTT\n\n00:01.000 --> 00:02.000\n<v Roger><i>Hi</i> &amp; <b>bye</b></v>\n\n' +
      '00:03.000 --> 00:04.000\n{\\an8}Top &lt;3 &rlm;!\n\n' +
      '00:05.000 --> 00:06.000\n<c.yellow>Karaoke</c> <00:05.500>word';
    expect(parseVtt(vtt).map(c => c.text)).toEqual(['Hi & bye', 'Top <3 ‏!', 'Karaoke word']);
  });

  test('ASS / SSA dialogue lines', () => {
    const ass = [
      '[Script Info]',
      'Title: x',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nsecond line',
    ].join('\n');
    expect(parseVtt(ass)).toEqual([{start: 1, end: 2.5, text: 'Hello, world\nsecond line'}]);
  });

  test('out of order, empty and zero-length cues', () => {
    const vtt =
      'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nB\n\n00:00:01.000 --> 00:00:02.000\nA\n\n' +
      '00:00:07.000 --> 00:00:08.000\n<i></i>\n\n00:00:09.000 --> 00:00:09.000\nzero';
    expect(parseVtt(vtt).map(c => c.text)).toEqual(['A', 'B']);
  });

  test('nothing to read', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
    expect(parseVtt('<html>502 Bad Gateway</html>')).toEqual([]);
    expect(parseVtt(undefined as unknown as string)).toEqual([]);
  });
});

describe('the cue on screen', () => {
  const cues = parseVtt(
    'WEBVTT\n\n00:01.000 --> 00:03.000\none\n\n00:05.000 --> 00:07.000\ntwo\n\n00:06.000 --> 00:08.000\nthree\n\n00:20.000 --> 00:21.000\nfour',
  );
  test('before, inside, in a gap, at the end boundary, after', () => {
    expect(cueTextAt(cues, 0.5)).toBe('');
    expect(cueTextAt(cues, 1)).toBe('one');
    expect(cueTextAt(cues, 2.99)).toBe('one');
    expect(cueTextAt(cues, 3)).toBe('');
    expect(cueTextAt(cues, 4)).toBe('');
    expect(cueTextAt(cues, 25)).toBe('');
  });
  test('two cues at once are both shown, in order', () => {
    expect(cueTextAt(cues, 6.5)).toBe('two\nthree');
    expect(cueTextAt(cues, 7.5)).toBe('three');
  });
  test('stateless: a delay nudge or a seek either way lands on the right cue at once', () => {
    const delayed = (clock: number, delay: number) => cueTextAt(cues, clock - delay);
    expect(delayed(20.5, 0)).toBe('four');
    expect(delayed(20.5, 15)).toBe('two'); // +15 s later: back to "two"
    expect(delayed(20.5, 0)).toBe('four'); // and forward again
    expect(delayed(2, -18.5)).toBe('four');
    expect(cueTextAt(cues, 1.5)).toBe('one');
  });
  test('no cues', () => {
    expect(cueTextAt(null, 3)).toBe('');
    expect(cueTextAt([], 3)).toBe('');
    expect(cueTextAt(cues, NaN)).toBe('');
  });
  test('a long track', () => {
    const many = Array.from({length: 2000}, (_, i) => ({start: i * 3, end: i * 3 + 2, text: `c${i}`}));
    expect(cueTextAt(many, 3 * 1234 + 1)).toBe('c1234');
    expect(cueTextAt(many, 3 * 1234 + 2.5)).toBe('');
  });
});

describe('where the cue layer sits', () => {
  test('chrome hidden: the plain position', () => {
    expect(cueBottom(false, 140, 540)).toBe(CUE_BOTTOM_PLAIN);
  });
  test('chrome up: just above the measured bar', () => {
    expect(cueBottom(true, 120, 540)).toBe(120 + CUE_GAP_ABOVE_CHROME);
    expect(cueBottom(true, 180.4, 1080)).toBe(Math.round(180.4 + CUE_GAP_ABOVE_CHROME));
  });
  test('not measured yet: the old constant', () => {
    expect(cueBottom(true, null, 540)).toBe(CUE_BOTTOM_LIFTED_FALLBACK);
    expect(cueBottom(true, 0, 540)).toBe(CUE_BOTTOM_LIFTED_FALLBACK);
    expect(cueBottom(true, NaN)).toBe(CUE_BOTTOM_LIFTED_FALLBACK);
  });
  test('a mis-measure never throws the cue off the picture', () => {
    expect(cueBottom(true, 900, 540)).toBe(Math.round(540 * 0.55));
    expect(cueBottom(true, 10, 540)).toBe(CUE_BOTTOM_PLAIN);
  });
});
