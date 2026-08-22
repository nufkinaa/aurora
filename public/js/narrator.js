// Safe front door to the narrator (easter.js).
//
// The jokes are imported LAZILY through here, on purpose. easter.js is a static
// import away from being load-bearing: with `import * as x from "./easter.js"`
// at the top of a screen, a single syntax error in the jokes file stops the
// whole module graph from loading and the app renders nothing at all. That is
// exactly what happened when this was tested by deliberately corrupting it —
// blank page, no gate, no console error worth the name.
//
// So: one dynamic import, resolved once and cached, with the failure path
// returning an empty module. If easter.js is broken, missing, or throws at
// import time, `call()` becomes a no-op and every real feature carries on
// exactly as if the narrator had never existed.
let pending = null;

const load = () => {
  if (!pending) {
    pending = import("./easter.js").catch(() => ({}));
  }
  return pending;
};

// Fire-and-forget. Every message this thing produces is a toast, so nothing
// downstream ever needs the result — which is what lets the whole path be async
// and swallow everything.
export const call = (fn, ...args) => {
  try {
    load().then((m) => {
      try {
        if (typeof m[fn] === "function") m[fn](...args);
      } catch {}
    });
  } catch {}
};
