// side-by-side crops of Chrome-decoded pictures: crop.js <out.png> <x> <y> <w> <h> <zoom> <label=file.png>...
const { execFileSync } = require("child_process"); const FF = require("../../src/config").FFMPEG;
const [out, x, y, w, h, z, ...panels] = process.argv.slice(2);
const ins = [], f = [];
panels.forEach((p, i) => { const [label, file] = p.split("="); ins.push("-i", file);
  f.push(`[${i}]crop=${w}:${h}:${x}:${y}${process.env.BOOST ? ",format=rgb24,lutrgb=r='clip(val*" + process.env.BOOST + ",0,255)':g='clip(val*" + process.env.BOOST + ",0,255)':b='clip(val*" + process.env.BOOST + ",0,255)'" : ""},scale=iw*${z}:ih*${z}:flags=neighbor,pad=iw:ih+28:0:28:color=white,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='${label}':x=6:y=5:fontsize=18:fontcolor=black[p${i}]`); });
const graph = f.join(";") + ";" + panels.map((_, i) => `[p${i}]`).join("") + `hstack=inputs=${panels.length}:shortest=0,pad=iw+0:ih:0:0[o]`;
execFileSync(FF, ["-v", "error", "-y", ...ins, "-filter_complex", graph, "-map", "[o]", "-frames:v", "1", out]);
console.log(out);
