// ES module half of the test-impact tracer (see trace-preload.cjs). Registered with
// module.register, it runs on Node's loader thread and writes every file: URL that a
// test process imports to <dir>/<pid>-esm<thread>.log. It only observes: each hook
// hands back exactly what the next hook returned.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let fd = -1;
const seen = new Set();

export function initialize(data) {
  try {
    fd = fs.openSync(data.file, "a");
    fs.writeSync(fd, `t ${data.owner}\n`);
  } catch { fd = -1; }
}

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  try {
    const url = r && r.url;
    if (fd >= 0 && url && url.startsWith("file:") && !seen.has(url)) {
      seen.add(url);
      const p = fileURLToPath(url.split("?")[0].split("#")[0]);
      if (!/[\\/]node_modules[\\/]/.test(p)) fs.writeSync(fd, `r ${p}\n`);
    }
  } catch { /* never break a load over tracing */ }
  return r;
}
