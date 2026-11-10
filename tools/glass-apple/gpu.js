// Is this headless Chrome drawing with the GPU? (backdrop filters differ in software)
const { launch } = require("../webperf/lib");
(async () => {
  const b = await launch({ extraArgs: process.argv.slice(2) });
  const p = await b.newPage();
  await p.goto("chrome://gpu");
  await p.waitForTimeout(2500);
  const t = await p.evaluate(() => {
    const walk = (n) => { let s = ""; if (n.shadowRoot) s += walk(n.shadowRoot); for (const c of n.childNodes) s += c.nodeType === 3 ? c.textContent : walk(c); return s + " "; };
    return walk(document.body).replace(/\s+/g, " ").slice(0, 1800);
  });
  console.log(t);
  await b.close();
})();
