// Stage 3: metrics of each Chrome-decoded candidate against the reference:
// SSIM (ffmpeg, yuv444p All), MS-SSIM, PSNR-HVS, VMAF, CAMBI banding (libvmaf).
const fs = require("fs"), path = require("path"), { execFile } = require("child_process");
const S = process.argv[2]; const OUT = path.join(S, process.argv[3] || "enc"); const FF = require("../../src/config").FFMPEG;
const enc = JSON.parse(fs.readFileSync(path.join(OUT, "encodes.json")));
const prev = fs.existsSync(path.join(OUT, "metrics.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "metrics.json"))) : [];
const have = new Map(prev.map((m) => [m.file, m]));
const metric = (dec, ref, log) => new Promise((res) => execFile(FF, ["-hide_banner", "-i", dec, "-i", ref, "-lavfi",
  `[0]format=yuv444p,split[a1][a2];[1]format=yuv444p,split[b1][b2];[a1][b1]ssim;[a2][b2]libvmaf=feature='name=float_ms_ssim|name=cambi|name=psnr_hvs':log_fmt=json:log_path='${path.basename(log)}':n_threads=2`, "-f", "null", "-"],
  { windowsHide: true, maxBuffer: 1 << 22, cwd: path.dirname(log) }, (e, so, se) => {
    const s = String(se); const m = /All:([\d.]+)/.exec(s);
    let j = null; try { j = JSON.parse(fs.readFileSync(log)).pooled_metrics; fs.unlinkSync(log); } catch {}
    res(j ? { ssim: m ? +m[1] : null, msssim: j.float_ms_ssim.mean, psnrhvs: j.psnr_hvs.mean, vmaf: j.vmaf.mean, cambi: j.cambi.mean } : { err: s.slice(-300) });
  }));
(async () => {
  const todo = enc.filter((e) => !e.err && e.bytes && e.key !== "ref" && !have.has(e.file));
  const out = [...prev]; let i = 0; const N = +process.env.CONC || 3;
  const worker = async () => { while (i < todo.length) { const e = todo[i++];
    const dec = e.file.replace(/\.(webp|avif|jpg)$/, ".dec.png"); const ref = path.join(path.dirname(e.file), "ref.png");
    const r = await metric(dec, ref, dec + `.${i}.json`); if (r.err) console.error(e.file, r.err);
    out.push({ ...e, ...r }); if (out.length % 100 === 0) console.log(out.length); } };
  await Promise.all(Array.from({ length: N }, worker));
  // the reference's own banding, for context
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(out));
  console.log("metrics", out.length);
})();
