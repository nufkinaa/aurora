// Server-Timing: how long the server itself took over an answer.
//
// "The film takes long to start" has three possible owners — this server,
// the line, the player — and from outside they look the same. Every /api and
// /stream answer now carries the standard Server-Timing header:
//
//   Server-Timing: app;dur=412.3, table;dur=3.1, probe;dur=96.0, seg;dur=310.2;desc="made"
//
//   app    from the request reaching Express to the first header going out
//   …      steps a route chose to name (res.timing(name, ms[, desc]))
//
// Browsers show it in DevTools (Network → Timing) and hand it to the page
// (PerformanceResourceTiming.serverTiming); tools/ttff reads it to split a
// request's wait into server and network. Durations only — nothing about
// what was asked or by whom.
"use strict";

const clean = (s) => String(s).replace(/[^\w.-]/g, "").slice(0, 24);
const fmt = (ms) => (Math.round(Math.max(0, Number(ms) || 0) * 10) / 10).toFixed(1);

// One header value from a list of steps. PURE.
const headerFor = (steps) =>
  steps
    .map((s) => {
      const name = clean(s.name);
      if (!name) return null;
      const desc = s.desc ? `;desc="${String(s.desc).replace(/[^\w .:-]/g, "").slice(0, 40)}"` : "";
      return `${name};dur=${fmt(s.ms)}${desc}`;
    })
    .filter(Boolean)
    .join(", ");

// Parse a Server-Timing header back into { name: { ms, desc } } (tests, tools).
const parse = (header) => {
  const out = {};
  for (const part of String(header || "").split(",")) {
    const bits = part.trim().split(";");
    const name = bits.shift();
    if (!name) continue;
    const e = { ms: 0, desc: null };
    for (const b of bits) {
      const [k, v] = b.split("=");
      if (k === "dur") e.ms = Number(v) || 0;
      else if (k === "desc") e.desc = String(v || "").replace(/^"|"$/g, "");
    }
    out[name] = e;
  }
  return out;
};

const MAX_STEPS = 8;

// Express middleware. Adds res.timing(name, ms, desc) and writes the header
// when the response's headers go out.
const middleware = (req, res, next) => {
  const t0 = process.hrtime.bigint();
  const steps = [];
  res.timing = (name, ms, desc) => {
    if (steps.length < MAX_STEPS) steps.push({ name, ms, desc });
  };
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    try {
      if (!res.headersSent && !res.getHeader("Server-Timing")) {
        const app = Number(process.hrtime.bigint() - t0) / 1e6;
        res.setHeader("Server-Timing", headerFor([{ name: "app", ms: app }, ...steps]));
      }
    } catch {}
    return writeHead.apply(this, args);
  };
  next();
};

// Time an async step and note it on the response: `await timed(res, "probe", () => probe())`.
const timed = async (res, name, fn, desc) => {
  const t0 = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    try { if (res && res.timing) res.timing(name, Number(process.hrtime.bigint() - t0) / 1e6, typeof desc === "function" ? desc() : desc); } catch {}
  }
};

module.exports = { middleware, timed, headerFor, parse };
