// A player's buffer, simulated: what the viewer would have SEEN, given when
// the bytes / segments actually arrived.
//
//   const b = new Buffer({ startSec: 2.5, rebufferSec: 5 });
//   b.fed(seconds)       media now buffered up to this many seconds (absolute position)
//   b.tick()             advance the clock (called every 100 ms by the owner)
//   b.seek(pos)          playhead jumps; the buffer is empty until fed again
//   b.ahead()            seconds buffered ahead of the playhead
//   b.report()           { ttffMs, stalls, stallMs, seeks, seekMs[], playedSec, ... }
//
// Start rule: playback starts (and resumes after a stall or a seek) once
// `startSec` (after a stall: `rebufferSec`) is buffered ahead of the playhead
// — ExoPlayer's bufferForPlaybackMs / bufferForPlaybackAfterRebufferMs, and
// about what Chrome's media element and hls.js wait for. A stall is the
// playhead reaching the end of what is buffered before the end of the title.
"use strict";

class PlayBuffer {
  constructor({ startSec = 2.5, rebufferSec = 5, durationSec = Infinity, startAt = 0, now = () => Date.now() } = {}) {
    this.startSec = startSec; this.rebufferSec = rebufferSec; this.durationSec = durationSec;
    this.now = now;
    this.t0 = now();
    this.pos = startAt; // playhead (s)
    this.end = startAt; // buffered up to (s)
    this.state = "starting"; // starting | playing | stalled | seeking | ended
    this.lastTick = this.t0;
    this.ttffMs = null;
    this.stalls = 0; this.stallMs = 0; this.stallAt = 0;
    this.seeks = 0; this.seekMs = []; this.seekAt = 0;
    this.playedSec = 0;
  }
  fed(absSec) { if (absSec > this.end) this.end = Math.min(absSec, this.durationSec); }
  ahead() { return this.end - this.pos; }
  seek(to) {
    this.tick();
    if (this.state === "stalled") { this.stallMs += this.now() - this.stallAt; }
    this.pos = to; this.end = to;
    this.state = "seeking"; this.seekAt = this.now(); this.seeks++;
  }
  tick() {
    const t = this.now();
    const dt = (t - this.lastTick) / 1000;
    this.lastTick = t;
    const atEnd = this.end >= this.durationSec - 0.05;
    if (this.state === "playing") {
      const step = Math.min(dt, Math.max(0, this.end - this.pos));
      this.pos += step;
      this.playedSec += step;
      if (this.pos >= this.durationSec - 0.05) { this.state = "ended"; return; }
      if (this.pos >= this.end - 0.01 && !atEnd) { this.state = "stalled"; this.stalls++; this.stallAt = t; }
    } else if (this.state === "starting" || this.state === "seeking") {
      if (this.ahead() >= this.startSec || (atEnd && this.ahead() > 0)) {
        if (this.state === "starting") this.ttffMs = t - this.t0;
        else this.seekMs.push(t - this.seekAt);
        this.state = "playing";
      }
    } else if (this.state === "stalled") {
      if (this.ahead() >= this.rebufferSec || (atEnd && this.ahead() > 0)) { this.stallMs += t - this.stallAt; this.state = "playing"; }
    }
  }
  report() {
    const t = this.now();
    const openStall = this.state === "stalled" ? t - this.stallAt : 0;
    return {
      state: this.state, ttffMs: this.ttffMs, stalls: this.stalls, stallMs: Math.round(this.stallMs + openStall),
      seeks: this.seeks, seekMs: this.seekMs.map(Math.round), playedSec: Math.round(this.playedSec), wallSec: Math.round((t - this.t0) / 1000),
      neverStarted: this.ttffMs == null,
    };
  }
}

module.exports = { PlayBuffer };
