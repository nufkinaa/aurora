// The glass look's page sky, painted off the page's thread (see
// aurora-sky.js for why). The page says hello with the address of the
// painter (aurora-sky-core.js, the very file it loaded itself); this worker
// loads it, checks it can draw, and only then is handed the canvas — a
// canvas given to a worker cannot be taken back, so nothing is handed over
// until the worker has shown it is there.
//   page -> { hello: url }                          worker -> { ready: true | false }
//   page -> { canvas, pace, stars, seed, frames, size, state, watch }
//   page -> { size: [cssWidth, cssHeight, density] }   (the window changed)
//   page -> { state: "run" | "still" | "nap" | "stop" } (shown? motion wanted? covered?)
//   worker -> { paint: ms, at: ms }                 (only when a tool is watching)
let core = null;
let sky = null;
let loop = null;
// "nap" (a player covers the sky) is a stop here: the page says when it ends.
let state = "stop";

self.onmessage = async ({ data }) => {
  if (data.hello) {
    try {
      core = await import(data.hello);
      if (!new OffscreenCanvas(1, 1).getContext("2d")) throw new Error("no 2d");
      self.postMessage({ ready: true });
    } catch {
      self.postMessage({ ready: false });
    }
    return;
  }
  if (data.canvas) {
    sky = core.makeSky(data.canvas, {
      mobile: false,
      pace: data.pace,
      stars: data.stars,
      seed: data.seed,
      makeCanvas: (w, h) => new OffscreenCanvas(w, h),
    });
    sky.size(...data.size);
    state = data.state;
    loop = core.makeLoop(sky.paint, {
      state: () => (state === "nap" ? "stop" : state),
      report: data.watch ? (ms, at) => self.postMessage({ paint: ms, at }) : null,
      frames: data.frames,
    });
    loop.kick();
    return;
  }
  if (!loop) return;
  if (data.size) {
    sky.size(...data.size);
    if (state === "still") loop.kick(); // the still frame, at the new size
  }
  if (data.state) {
    state = data.state;
    loop.kick();
  }
};
