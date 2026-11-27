// Preloaded into the rig's private instance (run.js → ui-test-server `preload`):
// every ffmpeg the server starts that ENCODES VIDEO (libx264 / libx265 / a
// hardware encoder — not "-c:v copy", not a still picture) is written to the
// log as one line, so a play's row can count its encoder starts:
//   [rig-encode] libx264 h=480 <the output's last path segment>
// Sound-only re-encodes (the jit copy's AAC) and stream copies are not counted.
"use strict";
const cp = require("child_process");
const VIDEO_ENCODERS = /^(libx264|libx265|libsvtav1|libaom-av1|h264_nvenc|hevc_nvenc|av1_nvenc|h264_qsv|hevc_qsv|h264_amf|hevc_amf|h264_vaapi|hevc_vaapi)$/;
const note = (file, args) => {
  try {
    if (!/ffmpeg/i.test(String(file))) return;
    const a = (args || []).map(String);
    for (let i = 0; i < a.length - 1; i++) {
      if ((a[i] === "-c:v" || a[i] === "-vcodec" || a[i] === "-codec:v") && VIDEO_ENCODERS.test(a[i + 1])) {
        const vf = a[a.indexOf("-vf") + 1] || "";
        const h = (/min\((\d+)/.exec(vf) || /scale=-2:(\d+)/.exec(vf) || [])[1] || "full";
        const out = (a[a.length - 1] || "").split(/[\\/]/).slice(-2).join("/");
        // (the boot's hardware-encoder probe — media/hwenc.js: small samples to "-" or nvenc/… —
        // and the speed calibration are not a viewer's encode)
        if (out === "-" || out.startsWith("nvenc/") || /calib/i.test(out)) return;
        process.stdout.write(`[rig-encode] ${a[i + 1]} h=${h} ${out}\n`);
        return;
      }
    }
  } catch {}
};
for (const name of ["spawn", "execFile"]) {
  const orig = cp[name];
  cp[name] = function (file, args, ...rest) {
    note(file, Array.isArray(args) ? args : []);
    return orig.call(this, file, args, ...rest);
  };
}
