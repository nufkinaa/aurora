// The CPU half of the audio sync, off the server's event loop: a worker
// thread per task (media/speech.js starts them).
//
//   { task: "rows" }    then messages { pcm: ArrayBuffer (s16le) } … { end: true }
//                       -> { rows: Float32Array }  (media/vad.js raw rows)
//   { task: "prob", rows }            -> { speech: Uint8Array }
//   { task: "align", speech, cues, opts } -> { result }
"use strict";
const { parentPort, workerData } = require("worker_threads");
const vad = require("./vad");
const audiosync = require("./audiosync");

const task = workerData && workerData.task;
const fail = (e) => parentPort.postMessage({ error: (e && e.message) || String(e) });

if (task === "rows") {
  const x = vad.createExtractor();
  let carry = null; // an odd byte left from the last buffer
  parentPort.on("message", (m) => {
    try {
      if (m.pcm) {
        let bytes = new Uint8Array(m.pcm);
        if (carry) {
          const b = new Uint8Array(bytes.length + 1);
          b[0] = carry[0];
          b.set(bytes, 1);
          bytes = b;
          carry = null;
        }
        if (bytes.length & 1) {
          carry = bytes.slice(bytes.length - 1);
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        const aligned = new Uint8Array(bytes); // copy: Int16Array needs an even byte offset
        x.push(new Int16Array(aligned.buffer, 0, aligned.length / 2));
      } else if (m.end) {
        const rows = x.end();
        parentPort.postMessage({ rows }, [rows.buffer]);
      }
    } catch (e) {
      fail(e);
    }
  });
} else if (task === "prob") {
  try {
    const speech = vad.probabilities(workerData.rows);
    parentPort.postMessage({ speech }, [speech.buffer]);
  } catch (e) {
    fail(e);
  }
} else if (task === "align") {
  try {
    const result = audiosync.align(workerData.speech, workerData.cues, workerData.opts || {});
    parentPort.postMessage({ result });
  } catch (e) {
    fail(e);
  }
} else {
  fail(new Error(`unknown task ${task}`));
}
