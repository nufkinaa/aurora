// Stage 2: decode every candidate IN CHROME (what a viewer sees) to a PNG.
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright-core");
const S = process.argv[2]; const OUT = path.join(S, process.argv[3] || "enc");
const enc = JSON.parse(fs.readFileSync(path.join(OUT, "encodes.json")));
const types = { ".webp": "image/webp", ".avif": "image/avif", ".jpg": "image/jpeg", ".png": "image/png" };
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage();
  await p.route("http://bench.local/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/") return r.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
    const f = decodeURIComponent(u.pathname.slice(3));
    r.fulfill({ contentType: types[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
  });
  await p.goto("http://bench.local/");
  let n = 0;
  for (const e of enc) {
    if (e.err || !e.bytes || e.key === "ref") continue;
    const dst = e.file.replace(/\.(webp|avif|jpg)$/, ".dec.png");
    if (fs.existsSync(dst) && !process.env.FORCE) continue;
    const url = "http://bench.local/f/" + encodeURIComponent(e.file);
    const data = await p.evaluate(async (u) => {
      const im = new Image(); im.src = u; await im.decode();
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const x = c.getContext("2d", { colorSpace: "srgb" }); x.drawImage(im, 0, 0);
      return c.toDataURL("image/png");
    }, url);
    fs.writeFileSync(dst, Buffer.from(data.split(",")[1], "base64"));
    if (++n % 100 === 0) console.log("decoded", n);
  }
  console.log("decoded total", n);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
