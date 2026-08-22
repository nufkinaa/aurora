// Hash router. Routes render into #app; overlays (player) stack on top so
// Back works naturally on TVs.
import { $$ } from "./ui.js";

const routes = []; // {pattern: RegExp, render: fn(params)}
let appRoot;

export const route = (pattern, render) => {
  const names = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:[a-zA-Z]+/g, (m) => {
        names.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  routes.push({ regex, names, render });
};

export const navigate = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

const markNav = (hash) => {
  $$("[data-route]").forEach((a) => {
    const target = a.getAttribute("data-route");
    a.classList.toggle("active", target === hash || (target !== "#/" && hash.startsWith(target)));
  });
};

let current = { cleanup: null };

const render = async () => {
  const hash = location.hash || "#/";
  const path = hash.replace(/^#/, "");

  for (const r of routes) {
    const m = path.match(r.regex);
    if (!m) continue;

    // Decode params BEFORE tearing down the current screen: a malformed
    // %-escape (e.g. "#/search/%") throws, and throwing after cleanup() left
    // the old screen visible but dead (listeners/timers already removed).
    const params = {};
    try {
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    } catch {
      return navigate("#/");
    }

    if (typeof current.cleanup === "function") current.cleanup();
    current.cleanup = null;

    appRoot.innerHTML = "";
    markNav(hash);
    window.scrollTo(0, 0);
    const cleanup = await r.render(appRoot, params);
    if (typeof cleanup === "function") current.cleanup = cleanup;
    return;
  }

  // Unknown -> home
  navigate("#/");
};

export const startRouter = (root) => {
  appRoot = root;
  window.addEventListener("hashchange", render);
  render();
};
