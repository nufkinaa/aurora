// NIGHT MODE and DIALOGUE BOOST on the website — the sound of the <video>
// through a small Web Audio graph. The same two switches, with the same names
// and the same numbers, are on the TV (tv-native/src/audioFx.ts and the native
// android/…/AudioFxModule.kt); both are the PERSON's (their profile's `prefs`),
// synced to every device. Default: both off.
//
//   Night mode      a compressor: loud bursts come down, quiet speech comes up
//                   (threshold −34 dB, 3:1, soft knee 10 dB, 5 ms / 250 ms,
//                   +6 dB make-up — measured as a whole, see FX_TRIM)
//   Dialogue boost  the voice band brought forward: +6 dB around 2.5 kHz
//                   (a wide peak, roughly 1–4 kHz), −4 dB under 200 Hz, and,
//                   when the film is 5.1 and is being down-mixed to stereo
//                   here, the centre channel (where the dialogue is) +3 dB
//   either on       a limiter at −1 dBFS, so nothing the two add can clip
//
// THE GRAPH (one per <video>, built the first time an option is on):
//
//   source ─┬───────────────────────────────── sum (stereo)
//           └─ up6 (6 ch, discrete) ─ split ─[C]─ centre ─┘
//   sum ─┬─ night ─ nightTrim ─ nightWet ─┐
//        └─ nightDelay ─ nightDry ────────┴─ low ─ peak
//   peak ─┬─ limiter ─ limTrim ─ limWet ─┐
//         └─ limDelay ─ limDry ──────────┴─ out ─ speakers
//
// NO CLICKS. A DynamicsCompressorNode's settings are k-rate (they change once
// per 128-sample block) and it recomputes its own make-up gain from them, so
// gliding them stepped the gain block by block — measured: a zipper on every
// switch of night mode. So the two compressors are set ONCE, to their real
// values, and always run; a switch crossfades between each one's output
// ("wet") and the same sound delayed by the compressor's own fixed look-ahead,
// 6 ms ("dry" — the spec's pre-delay, the same in every browser: the two are
// sample-aligned, so the mix is a smooth change of gain, never a comb). The
// compressor's detector has kept listening all along, so switching on does
// not swell either. The EQ and the centre are sample-accurate gains: they
// glide. Off is every wet at 0 and the EQ flat — the film's own sound, 12 ms
// later (picture and sound stay together: that is under a frame).
// A stereo or mono film has nothing on the splitter's third output, so the
// centre stage only ever lifts a real centre channel.
//
// WHERE IT CANNOT WORK (fxBlocked): iPhone and iPad, and Safari. WebKit plays
// HLS through its own system pipeline there; a page that routes that element
// into Web Audio gets silence on some versions, the native fullscreen player
// and AirPlay take the sound away from the page anyway — so the switches are
// greyed out with the reason, the film keeps its normal sound, and the
// person's choice stays on the profile for their other devices.
//
// PURE apart from the Web Audio objects it is handed: test/ui/player-options
// builds the very same chain in an OfflineAudioContext and measures it.

export const AUDIO_FX_DEFAULTS = { nightMode: false, dialogueBoost: false };
export const AUDIO_FX_KEYS = Object.keys(AUDIO_FX_DEFAULTS);
export const AUDIO_FX_NAMES = { nightMode: "Night mode", dialogueBoost: "Dialogue boost" };
export const AUDIO_FX_NOTES = {
  nightMode: "Loud bursts come down, quiet voices come up.",
  dialogueBoost: "Voices clearer over music and effects.",
};

// The numbers (the TV uses the same ones).
export const FX = {
  night: { threshold: -34, knee: 10, ratio: 3, attack: 0.005, release: 0.25, makeupDb: 6 },
  dialogue: { peakHz: 2500, peakQ: 0.8, peakDb: 6, lowHz: 200, lowDb: -4, centreDb: 3 },
  limiter: { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.1 },
  // the time constant of every switch's ramp (≈ 95 % there after 3×)
  rampS: 0.04,
};
// A DynamicsCompressorNode adds its own make-up gain, (1 / gain at 0 dBFS)^0.6
// (the spec's rule, the same in Chrome, Firefox and Safari). The trims take
// that back out so the stage as a whole gives exactly FX.night.makeupDb, and
// the limiter none at all. Worked out from those rules (and checked by
// measurement in test/ui/player-options.test.js).
const dbToGain = (db) => Math.pow(10, db / 20);
const kneeCurveOut = (thr, knee, ratio, xDb) => {
  // the static curve in dB (a quadratic soft knee centred on the knee range
  // [thr, thr + knee], then 1/ratio): close enough to the browsers' own
  // exponential knee at 0 dBFS, where only the straight part matters
  if (xDb <= thr) return xDb;
  if (knee > 0 && xDb < thr + knee) return xDb + ((1 / ratio - 1) * Math.pow(xDb - thr, 2)) / (2 * knee);
  const kneeEnd = thr + knee;
  const atKneeEnd = knee > 0 ? kneeEnd + ((1 / ratio - 1) * knee) / 2 : thr;
  return atKneeEnd + (xDb - kneeEnd) / ratio;
};
export const autoMakeupDb = ({ threshold, knee, ratio }) => -0.6 * kneeCurveOut(threshold, knee, ratio, 0);
export const FX_TRIM = {
  night: FX.night.makeupDb - autoMakeupDb(FX.night),
  limiter: -autoMakeupDb(FX.limiter),
};

// Why the switches cannot work in this browser (null: they can).
//   ua      navigator.userAgent
//   hasCtx  the browser has Web Audio at all
export const fxBlocked = ({ ua = "", hasCtx = true } = {}) => {
  if (!hasCtx) return "This browser can't change the sound.";
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua));
  if (apple) return "Not on iPhone, iPad or Safari — Apple's player keeps the sound to itself.";
  return null;
};

// The compressors' fixed look-ahead (DynamicsCompressorNode's pre-delay, 6 ms
// by the spec), which each dry path is delayed by to stay aligned.
export const COMP_DELAY_S = 0.006;

// The values every switchable stage takes for a pair of switches.
export const fxTargets = ({ nightMode = false, dialogueBoost = false } = {}) => ({
  night: nightMode ? 1 : 0, // the night compressor's share of the mix
  lowDb: dialogueBoost ? FX.dialogue.lowDb : 0,
  peakDb: dialogueBoost ? FX.dialogue.peakDb : 0,
  // what the centre adds on top of the normal down-mix (√½ of it): +3 dB
  // overall is √½ · 10^(3/20) ≈ 0.999, i.e. ≈ +0.29 more
  centre: dialogueBoost ? Math.SQRT1_2 * (dbToGain(FX.dialogue.centreDb) - 1) : 0,
  limiter: nightMode || dialogueBoost ? 1 : 0, // the limiter's share
});

const compressor = (ctx, c, trimDb) => {
  const n = ctx.createDynamicsCompressor();
  n.threshold.value = c.threshold;
  n.knee.value = c.knee;
  n.ratio.value = c.ratio;
  n.attack.value = c.attack;
  n.release.value = c.release;
  const trim = ctx.createGain();
  trim.gain.value = dbToGain(trimDb);
  return [n, trim];
};
const delay = (ctx) => {
  const d = ctx.createDelay(0.05);
  d.delayTime.value = COMP_DELAY_S;
  return d;
};

// Build the chain between `input` (any AudioNode: the <video>'s source, or a
// buffer source in a test) and `output` (the context's destination).
//   -> { nodes, set(options, { at, ramp }), dispose() }
export const buildFxChain = (ctx, input, output, options = AUDIO_FX_DEFAULTS, { fadeIn = 0 } = {}) => {
  const sum = ctx.createGain();
  sum.channelCount = 2;
  sum.channelCountMode = "explicit";
  sum.channelInterpretation = "speakers"; // a 5.1 film is down-mixed here by the standard rule
  const up6 = ctx.createGain();
  up6.channelCount = 6;
  up6.channelCountMode = "explicit";
  up6.channelInterpretation = "discrete"; // stereo stays L/R: nothing lands on the centre
  const split = ctx.createChannelSplitter(6);
  const centre = ctx.createGain();
  const [night, nightTrim] = compressor(ctx, FX.night, FX_TRIM.night);
  const nightWet = ctx.createGain();
  const nightDelay = delay(ctx);
  const nightDry = ctx.createGain();
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = FX.dialogue.lowHz;
  const peak = ctx.createBiquadFilter();
  peak.type = "peaking";
  peak.frequency.value = FX.dialogue.peakHz;
  peak.Q.value = FX.dialogue.peakQ;
  const [limiter, limTrim] = compressor(ctx, FX.limiter, FX_TRIM.limiter);
  const limWet = ctx.createGain();
  const limDelay = delay(ctx);
  const limDry = ctx.createGain();
  const out = ctx.createGain();

  input.connect(sum);
  input.connect(up6);
  up6.connect(split);
  split.connect(centre, 2);
  centre.connect(sum);
  sum.connect(night).connect(nightTrim).connect(nightWet).connect(low);
  sum.connect(nightDelay).connect(nightDry).connect(low);
  low.connect(peak);
  peak.connect(limiter).connect(limTrim).connect(limWet).connect(out);
  peak.connect(limDelay).connect(limDry).connect(out);
  out.connect(output);

  const nodes = { sum, up6, split, centre, night, nightTrim, nightWet, nightDelay, nightDry, low, peak, limiter, limTrim, limWet, limDelay, limDry, out };
  let current = { ...AUDIO_FX_DEFAULTS };

  // ramp (true): a short glide from where each value is — no click.
  // at: when (the context's clock; a test schedules into an offline render).
  const set = (options, { at = ctx.currentTime, ramp = true } = {}) => {
    current = { ...AUDIO_FX_DEFAULTS, ...current, ...(options || {}) };
    const t = fxTargets(current);
    const go = (param, v) => {
      param.cancelScheduledValues(at);
      if (ramp) param.setTargetAtTime(v, at, FX.rampS);
      else param.setValueAtTime(v, at);
    };
    go(nightWet.gain, t.night);
    go(nightDry.gain, 1 - t.night);
    go(low.gain, t.lowDb);
    go(peak.gain, t.peakDb);
    go(centre.gain, t.centre);
    go(limWet.gain, t.limiter);
    go(limDry.gain, 1 - t.limiter);
    return current;
  };
  set(options, { ramp: false });
  // The first time a playing film is routed in here the sound would jump from
  // the element's own path to this one: a quick fade makes that a dip, not a click.
  if (fadeIn > 0) {
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.setTargetAtTime(1, ctx.currentTime, fadeIn / 3);
  }
  const dispose = () => {
    for (const n of Object.values(nodes)) {
      try { n.disconnect(); } catch {}
    }
  };
  return { nodes, set, dispose, get options() { return { ...current }; } };
};

// ---- the player's side: one AudioContext for the page, one chain per <video> ----
let sharedCtx = null;
const chains = new WeakMap(); // <video> -> { source, chain }
const AC = () => (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)) || null;

// The controller the player keeps for its <video>.
//   apply(options)   switches as they are now (builds the graph the first
//                    time one is on; never before — a film nobody asked this
//                    of keeps the browser's own, untouched sound path)
//   blocked()        the reason the switches are greyed out here, or null
//   state()          for the tests: the graph and its live values
export const audioFxFor = (video, { ua = (typeof navigator !== "undefined" && navigator.userAgent) || "" } = {}) => {
  const reason = fxBlocked({ ua, hasCtx: !!AC() });
  let wanted = { ...AUDIO_FX_DEFAULTS };
  let waiting = null; // a context the browser has not let run yet
  const build = () => {
    if (chains.has(video)) return chains.get(video);
    if (!sharedCtx) sharedCtx = new (AC())();
    const ctx = sharedCtx;
    if (ctx.state !== "running") {
      // The browser has not allowed sound from this page yet (no tap since it
      // loaded). Routing the film into a silent context would mute it: wait
      // for the context, and ask again on the next tap or key.
      ctx.resume().catch(() => {});
      if (!waiting) {
        waiting = () => {
          if (ctx.state !== "running") return ctx.resume().catch(() => {});
          drop();
          apply(wanted);
        };
        const drop = () => {
          ctx.removeEventListener("statechange", waiting);
          window.removeEventListener("pointerdown", waiting, true);
          window.removeEventListener("keydown", waiting, true);
          waiting = null;
        };
        ctx.addEventListener("statechange", waiting);
        window.addEventListener("pointerdown", waiting, true);
        window.addEventListener("keydown", waiting, true);
      }
      return null;
    }
    const source = ctx.createMediaElementSource(video);
    const chain = buildFxChain(ctx, source, ctx.destination, wanted, { fadeIn: video.paused ? 0 : 0.06 });
    const rec = { source, chain, ctx };
    chains.set(video, rec);
    return rec;
  };
  const apply = (options) => {
    wanted = { ...AUDIO_FX_DEFAULTS, ...wanted, ...(options || {}) };
    if (reason) return false;
    const on = AUDIO_FX_KEYS.some((k) => wanted[k]);
    const rec = chains.get(video) || (on ? build() : null);
    if (!rec) return false;
    if (rec.ctx.state === "suspended") rec.ctx.resume().catch(() => {});
    rec.chain.set(wanted);
    return true;
  };
  const dispose = () => {
    // The element is going away with the player: its stages are let go. (A
    // MediaElementSource can never be undone on its element — the element is
    // not reused, so that does not matter.)
    const rec = chains.get(video);
    if (rec) {
      rec.chain.dispose();
      try { rec.source.disconnect(); } catch {}
      chains.delete(video);
    }
  };
  const state = () => {
    const rec = chains.get(video);
    if (!rec) return { built: false, wanted: { ...wanted }, blocked: reason, ctx: sharedCtx ? sharedCtx.state : null };
    const n = rec.chain.nodes;
    return {
      built: true,
      blocked: reason,
      ctx: rec.ctx.state,
      wanted: { ...wanted },
      night: { mix: n.nightWet.gain.value, dry: n.nightDry.gain.value, threshold: n.night.threshold.value, knee: n.night.knee.value, ratio: n.night.ratio.value, attack: n.night.attack.value, release: n.night.release.value, trim: n.nightTrim.gain.value, delay: n.nightDelay.delayTime.value },
      low: { type: n.low.type, frequency: n.low.frequency.value, gain: n.low.gain.value },
      peak: { type: n.peak.type, frequency: n.peak.frequency.value, Q: n.peak.Q.value, gain: n.peak.gain.value },
      centre: n.centre.gain.value,
      limiter: { mix: n.limWet.gain.value, dry: n.limDry.gain.value, threshold: n.limiter.threshold.value, ratio: n.limiter.ratio.value, trim: n.limTrim.gain.value },
      out: n.out.gain.value,
    };
  };
  // For the browser tests: the sound level (dB RMS) going into the chain and
  // coming out of it, read off two analysers hung on the side (never in the path).
  const levels = () => {
    const rec = chains.get(video);
    if (!rec) return null;
    if (!rec.taps) {
      const tap = () => {
        const a = rec.ctx.createAnalyser();
        a.fftSize = 8192;
        return a;
      };
      rec.taps = { in: tap(), out: tap() };
      rec.source.connect(rec.taps.in);
      rec.chain.nodes.out.connect(rec.taps.out);
    }
    const rms = (a) => {
      const d = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(d);
      let e = 0;
      for (const x of d) e += x * x;
      return e > 0 ? 10 * Math.log10(e / d.length) : -Infinity;
    };
    return { in: rms(rec.taps.in), out: rms(rec.taps.out) };
  };
  return { apply, blocked: () => reason, dispose, state, levels };
};
