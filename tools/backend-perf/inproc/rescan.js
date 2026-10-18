// Runs INSIDE the private instance (probe /exec): ONE periodic rescan, the
// way server.js's ten-minute timer does it on the code being measured —
// scanAsync() + enrich() where the scanner has it, scan() + enrich() before.
// Resolves when the rescan (and the probe pass it starts) is over.
//   arg.touch   a file path to create first (a library change), or null
// -> { mode, wallMs, version, changed, calls }
module.exports = async (arg = {}, ctx) => {
  const fs = require("fs");
  const path = require("path");
  const scanner = ctx.req("src/media/scanner");
  if (arg.touch) { fs.mkdirSync(path.dirname(arg.touch), { recursive: true }); fs.writeFileSync(arg.touch, "x"); }
  if (arg.untouch) { try { fs.rmSync(path.dirname(arg.untouch), { recursive: true, force: true }); } catch {} }
  const v0 = scanner.index.version;
  const t0 = ctx.now();
  let mode;
  if (typeof scanner.scanAsync === "function") {
    mode = "async";
    await scanner.scanAsync();
  } else {
    mode = "sync";
    scanner.scan();
  }
  scanner.enrich();
  // let the enrich pass (no new files: it finishes at once) and the listeners settle
  for (let i = 0; i < 200 && scanner.isEnriching(); i++) await new Promise((r) => setTimeout(r, 25));
  return { mode, wallMs: Math.round(ctx.now() - t0), version: scanner.index.version, changed: v0 !== undefined ? scanner.index.version !== v0 : null, calls: scanner.scanStats ? scanner.scanStats().last : null };
};
