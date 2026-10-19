// Player options (2026-10-19) in a real Chrome: night mode, dialogue boost
// and the look of subtitles — the PERSON's, the same on the TV.
//   - the switches build the Web Audio graph on the real <video> and set its
//     values (read back off the live nodes), and the sound coming out of it
//     changes (two analysers on the side);
//   - the very same chain, rendered offline over a made clip of loud bursts
//     and quiet speech, narrows the loudness range; the boost lifts the voice
//     band and a 5.1 centre; a switch mid-sound makes no click;
//   - the look reaches Chrome's own cue boxes (computed style, read through
//     the user-agent shadow DOM), on desktop and phone, in both looks; Raised
//     moves them up and the lift above the timeline still works;
//   - Settings' live sample, the profile, another browser, and the one-time
//     move of a browser's old subtitle size / background;
//   - an iPhone gets the switches greyed with the reason, and no graph.
const path = require("path");
const assert = require("node:assert/strict");
const { suite, player, waitForScreen, assertNoHorizontalOverflow, DESKTOP, PHONE, ARTIFACTS } = require("./helpers");

const ui = suite();
const shot = (page, name) => page.screenshot({ path: path.join(ARTIFACTS, `player-options-${name}.png`) }).catch(() => {});

const fxState = (page) => page.evaluate(() => document.querySelector(".player video").auroraFx.state());
const fxLevels = async (page) => {
  // a few reads a beat apart, averaged (one window of a tone is steady, but
  // the first read after the taps are hung is empty)
  const reads = [];
  for (let i = 0; i < 6; i++) {
    const l = await page.evaluate(() => document.querySelector(".player video").auroraFx.levels());
    if (l && Number.isFinite(l.in) && Number.isFinite(l.out)) reads.push(l);
    await page.waitForTimeout(120);
  }
  assert.ok(reads.length >= 3, "the analysers read the sound");
  const avg = (k) => reads.reduce((a, r) => a + r[k], 0) / reads.length;
  return { in: avg("in"), out: avg("out") };
};
const fxRow = (page, key) => page.locator(`.player .menu [data-fx="${key}"]`);
const serverPrefs = async (api, me) => ((await api.profile(me.id)).prefs || {});

// ---------------------------------------------------------------- the sound, live
ui.test("night mode and dialogue boost: the switches build the graph on the real <video> and set its values", async ({ page, srv, api, signIn, freshProfile, lib }) => {
  const me = await freshProfile();
  await signIn(me);
  await player.open(page, srv, lib.film1.id);
  // nobody asked: the browser's own sound path, untouched
  assert.equal((await fxState(page)).built, false);

  const items = await player.menu(page, "Settings", { all: true });
  const names = items.map((i) => i.text);
  for (const want of ["Night mode", "Dialogue boost"]) assert.ok(names.some((n) => n.startsWith(want)), `no ${want} in ${JSON.stringify(names)}`);
  // the Audio section has them even with one dub (and no dub list)
  assert.equal(await page.locator('.player .menu [data-ui="player.audio.pick"]').count(), 0);
  assert.equal(await fxRow(page, "nightMode").getAttribute("aria-checked"), "false");
  await shot(page, "gear-menu");

  await fxRow(page, "nightMode").click();
  // the night compressor takes over the mix (it is set once, to its values,
  // and crossfaded in against the same sound delayed by its look-ahead)
  await page.waitForFunction(() => {
    const s = document.querySelector(".player video").auroraFx.state();
    return s.built && s.night.mix > 0.99 && s.night.dry < 0.01 && s.limiter.mix > 0.99;
  });
  let st = await fxState(page);
  assert.equal(st.ctx, "running");
  assert.equal(st.night.threshold, -34);
  assert.ok(Math.abs(st.night.ratio - 3) < 1e-6 && Math.abs(st.night.knee - 10) < 1e-6, `ratio ${st.night.ratio} knee ${st.night.knee}`);
  assert.ok(Math.abs(st.night.attack - 0.005) < 1e-4 && Math.abs(st.night.release - 0.25) < 1e-4);
  assert.ok(Math.abs(20 * Math.log10(st.night.trim) - -5.6) < 0.1, `night trim ${st.night.trim}`);
  assert.ok(Math.abs(st.night.delay - 0.006) < 1e-6, "the dry path is delayed by the compressor's look-ahead");
  assert.ok(Math.abs(st.limiter.threshold + 1) < 1e-6 && Math.abs(st.limiter.ratio - 20) < 1e-6);
  assert.equal(st.peak.gain, 0, "night mode alone leaves the EQ flat");
  assert.equal(await fxRow(page, "nightMode").getAttribute("aria-checked"), "true");
  await page.waitForFunction(async (id) => ((await (await fetch("/api/profiles")).json()).find((p) => p.id === id).prefs || {}).nightMode === true, me.id);

  // the sound through it: Film One is a steady 440 Hz tone at about -24 dB
  // RMS, where this curve gives about +0.8 dB (measured offline below)
  const night = await fxLevels(page);
  assert.ok(night.out - night.in > 0.4 && night.out - night.in < 1.6, `night: in ${night.in.toFixed(2)} out ${night.out.toFixed(2)}`);

  await fxRow(page, "dialogueBoost").click();
  await page.waitForFunction(() => {
    const s = document.querySelector(".player video").auroraFx.state();
    return Math.abs(s.peak.gain - 6) < 0.05 && Math.abs(s.low.gain + 4) < 0.05;
  });
  st = await fxState(page);
  assert.equal(st.peak.type, "peaking");
  assert.equal(st.peak.frequency, 2500);
  assert.ok(Math.abs(st.peak.Q - 0.8) < 1e-6);
  assert.equal(st.low.type, "lowshelf");
  assert.equal(st.low.frequency, 200);
  assert.ok(Math.abs(st.centre - 0.2917) < 0.01, `centre ${st.centre}`);

  // both off: every stage back to neutral, and the sound is the film's own
  await fxRow(page, "nightMode").click();
  await fxRow(page, "dialogueBoost").click();
  await page.waitForFunction(() => {
    const s = document.querySelector(".player video").auroraFx.state();
    return s.night.mix < 0.005 && s.night.dry > 0.995 && Math.abs(s.peak.gain) < 0.02 && Math.abs(s.low.gain) < 0.02 &&
      Math.abs(s.centre) < 0.005 && s.limiter.mix < 0.005 && s.limiter.dry > 0.995;
  });
  await page.waitForTimeout(300);
  const off = await fxLevels(page);
  assert.ok(Math.abs(off.out - off.in) < 0.3, `off: in ${off.in.toFixed(2)} out ${off.out.toFixed(2)}`);
  const p = await serverPrefs(api, me);
  assert.equal(p.nightMode, false);
  assert.equal(p.dialogueBoost, false);
});

ui.test("a person who left night mode on gets it on the next film, in another browser too (hls.js)", async ({ page, srv, api, signIn, freshProfile, lib }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { nightMode: true } }, await api.as(me));
  await signIn(me);
  // Film Two plays through the server's repackaging and hls.js (MSE)
  await player.open(page, srv, lib.film2.id);
  await page.waitForFunction(() => {
    const s = document.querySelector(".player video").auroraFx.state();
    return s.built && s.night.mix > 0.99;
  }, null, { timeout: 15000 });
  const lv = await fxLevels(page);
  assert.ok(Number.isFinite(lv.out) && lv.out > -60, `sound comes out of the graph on hls.js (${lv.out.toFixed(1)} dB)`);
  await player.menu(page, "Settings");
  assert.equal(await fxRow(page, "nightMode").getAttribute("aria-checked"), "true");
});

// ------------------------------------------- the chain itself, measured offline
ui.test("offline render of the same chain: night mode narrows the loudness range, the boost lifts the voice band and a 5.1 centre, no click on a switch", async ({ page, goto, signIn, freshProfile }) => {
  await signIn(await freshProfile());
  await goto("#/movies");
  const r = await page.evaluate(async () => {
    const { buildFxChain } = await import("/js/audiofx.js");
    const SR = 48000;
    // a film in miniature: quiet speech (band-limited noise, syllables at 4 Hz,
    // -40 dB RMS) and loud bursts (full-band noise, -6 dB RMS), 1.5 s each
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const clip = (ctx) => {
      const n = SR * 12;
      const buf = ctx.createBuffer(2, n, SR);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      let lp = 0, hp = 0, prev = 0;
      const seg = SR * 1.5;
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const loud = Math.floor(i / seg) % 2 === 1;
        const w = rnd();
        if (loud) raw[i] = w;
        else {
          lp += 0.35 * (w - lp); // ~3 kHz low-pass
          hp = 0.97 * (hp + lp - prev); // ~250 Hz high-pass
          prev = lp;
          raw[i] = hp * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SR));
        }
      }
      // scale each segment to its level
      for (let s0 = 0; s0 < n; s0 += seg) {
        const loud = Math.floor(s0 / seg) % 2 === 1;
        let e = 0;
        for (let i = s0; i < s0 + seg; i++) e += raw[i] * raw[i];
        const g = Math.pow(10, (loud ? -6 : -40) / 20) / Math.sqrt(e / seg);
        for (let i = s0; i < s0 + seg; i++) L[i] = R[i] = raw[i] * g;
      }
      return buf;
    };
    const render = async (opts, make = clip, channels = 2) => {
      const ctx = new OfflineAudioContext(2, SR * 12, SR);
      const src = ctx.createBufferSource();
      src.buffer = make(ctx, channels);
      buildFxChain(ctx, src, ctx.destination, opts);
      src.start();
      return (await ctx.startRendering()).getChannelData(0);
    };
    // short-term loudness: 400 ms windows (dB RMS); the range p95 - p10
    const windows = (x) => {
      const w = SR * 0.4, out = [];
      for (let s0 = SR; s0 + w <= x.length; s0 += w) {
        let e = 0;
        for (let i = s0; i < s0 + w; i++) e += x[i] * x[i];
        out.push(10 * Math.log10(e / w + 1e-20));
      }
      return out;
    };
    const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const off = windows(await render({}));
    const night = windows(await render({ nightMode: true }));
    const lra = (w) => pct(w, 0.95) - pct(w, 0.1);
    // the quiet and the loud windows (by the input's own segments: even = quiet)
    const seg = (w, loud) => w.filter((_, i) => { const t = 1 + i * 0.4 + 0.2; return (Math.floor(t / 1.5) % 2 === 1) === loud && (t % 1.5) > 0.3 && (t % 1.5) < 1.2; });
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

    // the voice band against the rumble: 120 Hz + 2.5 kHz, equal, -20 dB each
    const tones = (ctx) => {
      const buf = ctx.createBuffer(2, SR * 12, SR);
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.1 * Math.sin((2 * Math.PI * 120 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 2500 * i) / SR); }
      return buf;
    };
    const goertzel = (x, hz) => {
      const k = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(k);
      let s1 = 0, s2 = 0;
      const from = SR * 2, to = SR * 6;
      for (let i = from; i < to; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      return 10 * Math.log10(s1 * s1 + s2 * s2 - c * s1 * s2);
    };
    const tOff = await render({}, tones), tOn = await render({ dialogueBoost: true }, tones);
    const voiceLift = (goertzel(tOn, 2500) - goertzel(tOn, 120)) - (goertzel(tOff, 2500) - goertzel(tOff, 120));

    // a 5.1 film: a 1 kHz tone on the centre only, then on the front left only
    const surround = (ch) => (ctx) => {
      const buf = ctx.createBuffer(6, SR * 12, SR);
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / SR);
      return buf;
    };
    const level = (x) => { let e = 0; for (let i = SR * 2; i < SR * 6; i++) e += x[i] * x[i]; return 10 * Math.log10(e / (SR * 4)); };
    const cOff = level(await render({}, surround(2))), cOn = level(await render({ dialogueBoost: true }, surround(2)));
    const lOff = level(await render({}, surround(0))), lOn = level(await render({ dialogueBoost: true }, surround(0)));
    // a stereo film: nothing reaches the centre stage
    const sOff = level(await render({}, tones)), sOn = level(await render({ dialogueBoost: true }, tones));

    // a switch mid-sound. A click is broadband: the second difference of a
    // pure tone is tiny and smooth, a step in its gain makes it jump. And the
    // level must glide from the one to the other: no swell, no dip.
    const sw = async (from, to) => {
      const ctx = new OfflineAudioContext(2, SR * 3, SR);
      const src = ctx.createBufferSource();
      const b = ctx.createBuffer(2, SR * 3, SR);
      for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR); }
      src.buffer = b;
      const chain = buildFxChain(ctx, src, ctx.destination, from);
      src.start();
      ctx.suspend(1).then(() => { chain.set(to); ctx.resume(); });
      const y = (await ctx.startRendering()).getChannelData(0);
      const sd = (a, z) => { let m = 0; for (let i = a + 2; i < z; i++) m = Math.max(m, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2])); return m; };
      const env = (a, z) => { let m = 0; for (let i = a; i < z; i++) m = Math.max(m, Math.abs(y[i])); return m; };
      const before = env(SR * 0.8, SR * 0.99), after = env(SR * 2.5, SR * 2.99);
      let hi = 0, lo = Infinity;
      for (let t = SR; t < SR * 2.5; t += SR / 100) { const e = env(t, t + SR / 100); hi = Math.max(hi, e); lo = Math.min(lo, e); }
      return {
        click: sd(SR * 0.99, SR * 1.5) / Math.max(sd(SR * 0.5, SR * 0.99), sd(SR * 2.5, SR * 2.99)),
        swellDb: 20 * Math.log10(hi / Math.max(before, after)),
        dipDb: 20 * Math.log10(lo / Math.min(before, after)),
      };
    };
    const swOn = await sw({}, { nightMode: true, dialogueBoost: true });
    const swOff = await sw({ nightMode: true, dialogueBoost: true }, {});
    const swNight = await sw({}, { nightMode: true });
    return {
      lraOff: lra(off), lraNight: lra(night),
      quietOff: mean(seg(off, false)), quietNight: mean(seg(night, false)),
      loudOff: mean(seg(off, true)), loudNight: mean(seg(night, true)),
      voiceLift, centreLift: cOn - cOff, leftLift: lOn - lOff, stereoLift: sOn - sOff,
      swOn, swOff, swNight,
    };
  });
  const f = (n) => n.toFixed(1);
  console.log(`# offline: LRA ${f(r.lraOff)} -> ${f(r.lraNight)} dB; quiet ${f(r.quietOff)} -> ${f(r.quietNight)}; loud ${f(r.loudOff)} -> ${f(r.loudNight)}; voice band +${f(r.voiceLift)} dB; 5.1 centre ${f(r.centreLift)} / left ${f(r.leftLift)} / stereo ${f(r.stereoLift)} dB; switching on/off/night: click x${r.swOn.click.toFixed(2)}/${r.swOff.click.toFixed(2)}/${r.swNight.click.toFixed(2)}, swell ${f(r.swOn.swellDb)}/${f(r.swOff.swellDb)}/${f(r.swNight.swellDb)} dB, dip ${f(r.swOn.dipDb)}/${f(r.swOff.dipDb)}/${f(r.swNight.dipDb)} dB`);
  assert.ok(r.lraOff > 30, `the clip spans a wide range (${f(r.lraOff)} dB)`);
  assert.ok(r.lraNight < r.lraOff - 12, `night mode narrows the range: ${f(r.lraOff)} -> ${f(r.lraNight)} dB`);
  assert.ok(r.quietNight - r.quietOff > 4, `quiet speech comes up (${f(r.quietOff)} -> ${f(r.quietNight)})`);
  assert.ok(r.loudOff - r.loudNight > 8, `loud bursts come down (${f(r.loudOff)} -> ${f(r.loudNight)})`);
  assert.ok(r.voiceLift > 8 && r.voiceLift < 12, `the voice band against the rumble: +${f(r.voiceLift)} dB (6 up, 4 down)`);
  // the 1 kHz tone gets the same EQ either way; the centre gets its +3 dB on top
  assert.ok(Math.abs(r.centreLift - r.leftLift - 3) < 0.4, `centre ${f(r.centreLift)} vs left ${f(r.leftLift)}`);
  assert.ok(Math.abs(r.stereoLift - r.leftLift) < 3, "a stereo film gets no centre stage");
  for (const [what, x] of [["on", r.swOn], ["off", r.swOff], ["night only", r.swNight]]) {
    assert.ok(x.click < 1.3, `no click switching ${what}: the second difference jumps x${x.click.toFixed(2)}`);
    assert.ok(x.swellDb < 0.5, `no swell switching ${what} (${f(x.swellDb)} dB)`);
    assert.ok(x.dipDb > -0.5, `no dip switching ${what} (${f(x.dipDb)} dB)`);
  }
});

// ---------------------------------------------------------------- the look
// Chrome's cue boxes, through the user-agent shadow root: their computed style and box.
const cueLooks = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const ids = [];
    const walk = (n) => {
      const a = n.attributes || [];
      const i = a.indexOf("pseudo");
      if (i >= 0 && a[i + 1] === "cue") ids.push(n.backendNodeId);
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    };
    walk(root);
    if (!ids.length) return [];
    const { nodeIds } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: ids });
    const out = [];
    for (let i = 0; i < nodeIds.length; i++) {
      try {
        const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId: nodeIds[i] });
        const css = Object.fromEntries(computedStyle.map((p) => [p.name, p.value]));
        const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: ids[i] });
        out.push({ color: css.color, background: css["background-color"], shadow: css["text-shadow"], weight: css["font-weight"], size: parseFloat(css["font-size"]), top: model.border[1], bottom: model.border[5] });
      } catch {}
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
};
const waitLook = async (page, test, what) => {
  const deadline = Date.now() + 6000;
  let got = [];
  while (Date.now() < deadline) {
    got = await cueLooks(page);
    if (got.length && got.every(test)) return got;
    await page.waitForTimeout(150);
  }
  throw new Error(`cues never looked ${what}: ${JSON.stringify(got)}`);
};
const pauseOnCue = async (page, at = 10.5) => {
  await page.evaluate((at) => { const v = document.querySelector(".player video"); v.pause(); v.currentTime = at; }, at);
  await page.waitForFunction(() => {
    const t = [...document.querySelector(".player video").textTracks].find((x) => x.mode === "showing");
    return t && t.activeCues && t.activeCues.length > 0;
  });
};
const styleRow = (page, key) => page.locator(`.player .menu [data-style="${key}"]`);
const pressStyle = async (page, key, times = 1) => {
  for (let i = 0; i < times; i++) await styleRow(page, key).click();
};

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  for (const look of ["glass", "legacy"]) {
    ui.test(`${name}, ${look}: the subtitle menu's style rows change the cues on screen at once, with a live sample`, { viewport }, async ({ page, srv, api, signIn, freshProfile, lib }) => {
      const me = await freshProfile();
      if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, await api.as(me));
      await signIn(me);
      await player.open(page, srv, lib.film1.id);
      await player.pick(page, "Subtitles", "English");
      await page.keyboard.press("Escape");
      await pauseOnCue(page);
      // the defaults: white, bold, the box at 75 %
      await waitLook(page, (c) => c.color === "rgb(255, 255, 255)" && c.background === "rgba(0, 0, 0, 0.75)" && c.weight === "700", "like the defaults");

      const items = await player.menu(page, "Subtitles", { all: true });
      for (const want of ["Size", "Text colour", "Background", "Box opacity", "Text weight", "Position"]) assert.ok(items.some((i) => i.text === want), `no ${want} row in ${JSON.stringify(items.map((i) => i.text))}`);
      assert.ok(await page.locator(".player .menu .sub-preview .sub-preview-cue").isVisible() || name === "phone", "the sample is in the menu");
      const sample = () => page.evaluate(() => { const c = getComputedStyle(document.querySelector(".player .menu .sub-preview-cue")); return { color: c.color, background: c.backgroundColor, weight: c.fontWeight, shadow: c.textShadow }; });

      const size0 = (await cueLooks(page))[0].size;
      await pressStyle(page, "subColor"); // white -> yellow
      await pressStyle(page, "subWeight"); // bold -> regular
      await pressStyle(page, "subSize", 2); // M -> L -> XL
      await pressStyle(page, "subOpacity", 2); // 75 -> 100 -> 25
      const cues = await waitLook(page, (c) => c.color === "rgb(255, 225, 77)" && c.weight === "400" && c.background === "rgba(0, 0, 0, 0.25)", "yellow, regular, a 25 % box");
      assert.ok(cues[0].size > size0, `XL is bigger than M (${cues[0].size} vs ${size0})`);
      assert.deepEqual((await sample()).color, "rgb(255, 225, 77)", "the sample changed with them");
      assert.equal((await sample()).background, "rgba(0, 0, 0, 0.25)");
      await shot(page, `${name}-${look}-menu`);

      // the outline: no box, eight dark offsets
      await pressStyle(page, "subBg", 3); // box -> none -> shadow -> outline
      assert.equal(await styleRow(page, "subOpacity").isVisible(), false, "the box's opacity goes with the box");
      const outlined = await waitLook(page, (c) => c.background === "rgba(0, 0, 0, 0)" && (c.shadow.match(/rgb\(0, 0, 0\)/g) || []).length === 8, "outlined");
      assert.ok(outlined.length);
      await page.keyboard.press("Escape");
      await shot(page, `${name}-${look}-outline`);

      // the person has them now (the TV reads the same profile)
      await page.waitForFunction(async (id) => {
        const p = ((await (await fetch("/api/profiles")).json()).find((x) => x.id === id).prefs) || {};
        return p.subColor === "yellow" && p.subWeight === "normal" && p.subSize === "XL" && p.subOpacity === 25 && p.subBg === "outline";
      }, me.id);
      if (name === "phone") await assertNoHorizontalOverflow(page, "the player with the subtitle menu used");
    });
  }

  ui.test(`${name}: Raised lifts the cues up the picture, and they still step above the timeline when it shows`, { viewport }, async ({ page, srv, api, signIn, freshProfile, lib }) => {
    const me = await freshProfile();
    await signIn(me);
    await player.open(page, srv, lib.film1.id);
    await player.pick(page, "Subtitles", "English");
    await page.keyboard.press("Escape");
    // hidden controls, lower: where the browser puts it
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => document.querySelector(".player").classList.contains("controls-hidden"), null, { timeout: 15000 });
    const lower = await waitLook(page, () => true, "drawn");
    // raised, from the menu (the pointer brought back over the picture first:
    // on a phone the helper's own wake point is off the screen)
    await page.mouse.move(150, 300);
    await page.mouse.move(160, 320);
    await page.waitForFunction(() => !document.querySelector(".player").classList.contains("controls-hidden"));
    await player.menu(page, "Subtitles");
    await pressStyle(page, "subPos");
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelector(".player video").play());
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => document.querySelector(".player").classList.contains("controls-hidden"), null, { timeout: 15000 });
    const v = await page.evaluate(() => { const r = document.querySelector(".player video").getBoundingClientRect(); return { top: r.top, h: r.height }; });
    const raised = await waitLook(page, (c) => c.bottom <= v.top + v.h * 0.8 + 8, "raised");
    assert.ok(raised[0].bottom < lower[0].bottom - 5, `raised (${raised[0].bottom.toFixed(0)}) is above lower (${lower[0].bottom.toFixed(0)})`);
    await shot(page, `${name}-raised`);
    // the controls come up: still clear of the dock
    await pauseOnCue(page);
    await player.wake(page);
    const dockTop = await page.evaluate(() => document.querySelector(".player .player-bottom").getBoundingClientRect().top);
    const lifted = await waitLook(page, (c) => c.bottom <= dockTop, "above the dock");
    assert.ok(lifted.length);
    assert.equal((await api.profile(me.id)).prefs.subPos, "raised");
  });
}

ui.test("Hebrew cues keep their direction in every look (RTL)", async ({ page, srv, signIn, freshProfile, lib, api }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { subBg: "outline", subColor: "cyan", subSize: "L" } }, await api.as(me));
  await signIn(me);
  await player.open(page, srv, lib.film1.id);
  await player.pick(page, "Subtitles", "Hebrew");
  await page.keyboard.press("Escape");
  await pauseOnCue(page);
  const cues = await waitLook(page, (c) => c.color === "rgb(94, 231, 255)", "cyan");
  assert.ok(cues.length);
  const text = await page.evaluate(() => [...document.querySelector(".player video").textTracks].find((t) => t.mode === "showing").activeCues[0].text);
  assert.match(text, /HE/);
  await shot(page, "hebrew-outline");
});

// ---------------------------------------------------------------- Settings
ui.test("Settings: the sample changes as you press, the profile carries it, and another browser plays it that way", async ({ page, srv, api, signIn, freshProfile, lib, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await goto("#/preferences");
  await page.waitForSelector(".sub-preview.big .sub-preview-cue");
  const sample = () => page.evaluate(() => { const c = getComputedStyle(document.querySelector(".sub-preview.big .sub-preview-cue")); return { color: c.color, background: c.backgroundColor, size: parseFloat(c.fontSize), shadow: c.textShadow }; });
  const s0 = await sample();
  assert.equal(s0.color, "rgb(255, 255, 255)");
  assert.equal(s0.background, "rgba(0, 0, 0, 0.75)");
  const press = (key) => page.click(`.pref-item[data-style="${key}"] .pref-item-value`);
  await press("subColor"); // yellow
  await press("subColor"); // cyan
  await press("subSize"); // L
  await press("subBg"); // none
  await press("subBg"); // shadow
  const s1 = await sample();
  assert.equal(s1.color, "rgb(94, 231, 255)");
  assert.equal(s1.background, "rgba(0, 0, 0, 0)");
  assert.notEqual(s1.shadow, "none");
  assert.ok(s1.size > s0.size);
  assert.equal(await page.locator('.pref-item[data-style="subOpacity"]').isVisible(), false, "no box, no box opacity");
  assert.equal((await page.textContent('.pref-item[data-style="subColor"] .pref-item-value')).trim(), "Cyan");
  // the sound, here too: switches that follow the person
  await page.click('.pref-item[data-fx="dialogueBoost"] .pref-item-value');
  await page.waitForFunction(async (id) => {
    const p = ((await (await fetch("/api/profiles")).json()).find((x) => x.id === id).prefs) || {};
    return p.subColor === "cyan" && p.subSize === "L" && p.subBg === "shadow" && p.dialogueBoost === true;
  }, me.id);
  await shot(page, "settings");

  // another browser, the same person: the film plays with that look and sound
  const other = await page.context().browser().newContext({ viewport: DESKTOP, serviceWorkers: "block" });
  try {
    await other.route((url) => url.origin !== srv.url && /^https?:$/.test(url.protocol), (route) => route.fulfill({ status: 404, body: "" }).catch(() => {}));
    const p2 = await other.newPage();
    await p2.addInitScript((id) => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("aurora-profile", id); localStorage.setItem("aurora-kbd-hint", "1"); localStorage.setItem("aurora-nav-hinted", "1"); } } catch {} }, me.id);
    await player.open(p2, srv, lib.film1.id);
    await player.pick(p2, "Subtitles", "English");
    await p2.keyboard.press("Escape");
    await pauseOnCue(p2);
    await waitLook(p2, (c) => c.color === "rgb(94, 231, 255)" && c.background === "rgba(0, 0, 0, 0)", "as chosen in the other browser");
    await p2.waitForFunction(() => {
      const s = document.querySelector(".player video").auroraFx.state();
      return s.built && Math.abs(s.peak.gain - 6) < 0.05;
    });
  } finally {
    await other.close();
  }
});

ui.test("the one-time move: this browser's old subtitle size and background become the person's, once", async ({ page, srv, api, signIn, freshProfile, goto }) => {
  const me = await freshProfile();
  await signIn(me);
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("ui-old-seeded")) {
        localStorage.setItem("ui-old-seeded", "1");
        localStorage.setItem("aurora-player", JSON.stringify({ cueSize: "L", cueBackground: false }));
      }
    } catch {}
  });
  await goto("#/preferences");
  await page.waitForFunction(async (id) => {
    const p = ((await (await fetch("/api/profiles")).json()).find((x) => x.id === id).prefs) || {};
    return p.subSize === "L" && p.subBg === "none";
  }, me.id);
  assert.equal((await page.textContent('.pref-item[data-style="subSize"] .pref-item-value')).trim(), "Large");
  // the person changes it; a reload does not move the old value over it again
  await page.click('.pref-item[data-style="subSize"] .pref-item-value'); // XL
  await page.waitForFunction(async (id) => ((await (await fetch("/api/profiles")).json()).find((x) => x.id === id).prefs || {}).subSize === "XL", me.id);
  await page.reload();
  await waitForScreen(page);
  await page.waitForTimeout(600);
  assert.equal((await api.profile(me.id)).prefs.subSize, "XL");
  assert.equal((await page.textContent('.pref-item[data-style="subSize"] .pref-item-value')).trim(), "Extra large");
});

// ---------------------------------------------------------------- iPhone
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
ui.test("iPhone: the sound switches are there, greyed, with the reason — and the film keeps its own sound path", { viewport: PHONE }, async ({ page, srv, signIn, freshProfile, lib, api, goto }) => {
  const me = await freshProfile();
  await api.ok("PUT", `/api/profiles/${me.id}`, { prefs: { nightMode: true } }, await api.as(me));
  await signIn(me);
  await page.addInitScript((ua) => { Object.defineProperty(navigator, "userAgent", { get: () => ua }); }, IPHONE_UA);
  await player.open(page, srv, lib.film1.id);
  await player.menu(page, "Settings");
  const row = fxRow(page, "nightMode");
  assert.equal(await row.getAttribute("aria-disabled"), "true");
  assert.match(await row.textContent(), /Not on iPhone, iPad or Safari/);
  await row.click({ force: true }); // aria-disabled, but a real button: a press says why again
  const st = await fxState(page);
  assert.equal(st.built, false, "no Web Audio graph on an iPhone");
  assert.match(st.blocked, /iPhone/);
  // the person's choice is kept for their other devices
  assert.equal((await api.profile(me.id)).prefs.nightMode, true);
  await shot(page, "iphone-gear");
  await page.keyboard.press("Escape");
  await goto("#/preferences");
  const pref = page.locator('.pref-item[data-fx="nightMode"]');
  assert.match(await pref.textContent(), /Not here/);
  assert.ok(await pref.evaluate((n) => n.classList.contains("disabled")));
});

ui.run({ concurrency: 2 });
