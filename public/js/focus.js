// Spatial navigation for TV remotes and keyboards.
//
// Any element with the .focusable class participates. Arrow keys (or D-pad)
// move focus geometrically; Enter activates; Back (Escape / LG 461 /
// Tizen 10009 / Android TV) emits a "ui-back" event; media keys emit
// "media-key" events the player listens for. Pointer remotes (LG magic
// remote) focus on hover, so both input styles stay in sync.

const BACK_KEYS = new Set(["Escape", "GoBack", "XF86Back", "BrowserBack"]);
const BACK_CODES = new Set([27, 461, 10009, 166]);

// scope stack: navigation is trapped inside the top scope (player, modal...)
const scopes = [document.body];

export const pushScope = (element) => {
  scopes.push(element);
  const first = firstFocusable(element);
  if (first) first.focus({ preventScroll: true });
};

export const popScope = (element) => {
  const i = scopes.lastIndexOf(element);
  if (i > 0) scopes.splice(i, 1);
};

export const currentScope = () => scopes[scopes.length - 1];

// Collect focusables with their rects in a SINGLE batched read per call.
// (Reading getBoundingClientRect once each — no getComputedStyle, no
// offsetParent — is the difference between snappy and laggy D-pad on a TV.)
const collect = (scope = currentScope()) => {
  const out = [];
  const nodes = scope.querySelectorAll(".focusable");
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    // Zero-area = display:none / detached; skip. A visible rect is proof
    // enough of focusability, cheaper than offsetParent/getComputedStyle.
    if (rect.width > 0 && rect.height > 0) out.push({ node, rect });
  }
  return out;
};

const focusables = (scope = currentScope()) => collect(scope).map((e) => e.node);

export const firstFocusable = (scope) => {
  const list = collect(scope);
  return list.length ? list[0].node : null;
};

export const focusFirst = (selector) => {
  const scope = currentScope();
  const target = selector ? scope.querySelector(selector) : firstFocusable(scope);
  if (target) target.focus({ preventScroll: true });
  return !!target;
};

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

// Pick the best candidate in `dir` from `from` using distance + alignment.
// Works off one batched rect read (no per-node reflow).
const findNext = (from, dir) => {
  const entries = collect();
  const fromRect = from.getBoundingClientRect();
  const fromC = center(fromRect);

  let best = null;
  let bestScore = Infinity;

  for (const { node, rect } of entries) {
    if (node === from) continue;
    const c = center(rect);
    const dx = c.x - fromC.x;
    const dy = c.y - fromC.y;

    let main, cross;
    if (dir === "left") { main = -dx; cross = Math.abs(dy); }
    else if (dir === "right") { main = dx; cross = Math.abs(dy); }
    else if (dir === "up") { main = -dy; cross = Math.abs(dx); }
    else { main = dy; cross = Math.abs(dx); }

    if (main <= 1) continue; // not in that direction

    // Strongly prefer aligned elements (same row/column)
    const overlap =
      dir === "left" || dir === "right"
        ? Math.min(fromRect.bottom, rect.bottom) - Math.max(fromRect.top, rect.top)
        : Math.min(fromRect.right, rect.right) - Math.max(fromRect.left, rect.left);
    const aligned = overlap > 0;

    const score = main + cross * (aligned ? 1.2 : 4) + (aligned ? 0 : 800);
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
};

// Is the node a live, on-screen focusable? (one rect read, no getComputedStyle)
const isVisible = (node) => {
  if (!node || !node.isConnected || !node.classList || !node.classList.contains("focusable")) {
    return false;
  }
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

const moveFocus = (dir) => {
  const active = document.activeElement;
  const from = isVisible(active) ? active : null;

  const target = from ? findNext(from, dir) : firstFocusable(currentScope());
  if (target) {
    target.focus({ preventScroll: true });
    // Centering the hero's or nav's controls would leave the page half-way
    // into the billboard - snap fully to the top instead. Detail pages'
    // action buttons (Play / Stream / My List) live inside .detail-hero and
    // need the same treatment, or the hero creeps up leaving a gap.
    if (target.closest(".hero, .nav, .detail-hero")) {
      // body is the real scroll container (body{overflow:auto} in standards
      // mode) — window.scrollTo alone is a silent no-op here.
      window.scrollTo({ top: 0, behavior: "smooth" });
      document.body.scrollTo({ top: 0, behavior: "smooth" });
      target.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    } else {
      target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
    return true;
  }
  return false;
};

const MEDIA_KEYS = {
  MediaPlayPause: "playpause", 179: "playpause",
  MediaPlay: "play", 415: "play",
  MediaPause: "pause", 19: "pause",
  MediaStop: "stop", 413: "stop",
  MediaRewind: "rewind", 412: "rewind",
  MediaFastForward: "forward", 417: "forward",
  MediaTrackNext: "next", 418: "next",
  MediaTrackPrevious: "prev", 419: "prev",
};

const emit = (name, detail) =>
  document.dispatchEvent(new CustomEvent(name, { detail, cancelable: true }));

// Only real text-entry fields should capture Left/Right (caret movement).
// Range/checkbox/button/etc. inputs must NOT — otherwise a focused volume
// slider traps the D-pad and you can't reach controls to its right.
const TEXT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "password", "number", "",
]);
const inTextInput = (node) => {
  if (!node) return false;
  if (node.isContentEditable || node.tagName === "TEXTAREA") return true;
  if (node.tagName === "INPUT") return TEXT_INPUT_TYPES.has((node.type || "text").toLowerCase());
  return false;
};

document.addEventListener(
  "keydown",
  (e) => {
    const key = e.key;
    const code = e.keyCode;
    const typing = inTextInput(document.activeElement);

    // Back
    if (BACK_KEYS.has(key) || BACK_CODES.has(code)) {
      if (typing) {
        document.activeElement.blur();
        e.preventDefault();
        return;
      }
      if (emit("ui-back")) e.preventDefault();
      return;
    }
    if (key === "Backspace" && !typing) {
      emit("ui-back");
      e.preventDefault();
      return;
    }

    // Media keys
    const media = MEDIA_KEYS[key] ?? MEDIA_KEYS[code];
    if (media) {
      emit("media-key", media);
      e.preventDefault();
      return;
    }

    // Arrows
    const dir =
      key === "ArrowLeft" || code === 37 ? "left" :
      key === "ArrowUp" || code === 38 ? "up" :
      key === "ArrowRight" || code === 39 ? "right" :
      key === "ArrowDown" || code === 40 ? "down" : null;

    if (dir) {
      // Let inputs keep left/right for the caret
      if (typing && (dir === "left" || dir === "right")) return;
      if (emit("nav-move", dir) === false) return; // a screen consumed it
      if (moveFocus(dir)) e.preventDefault();
      return;
    }

    // Enter -> click for non-native controls
    if ((key === "Enter" || code === 13) && !typing) {
      const active = document.activeElement;
      if (
        active &&
        active.classList.contains("focusable") &&
        active.tagName !== "BUTTON" &&
        active.tagName !== "A" &&
        active.tagName !== "INPUT"
      ) {
        active.click();
        e.preventDefault();
      }
    }
  },
  true
);

// Pointer remotes / mouse: hovering focuses, keeping D-pad position in sync
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest && e.target.closest(".focusable");
  if (target && currentScope().contains(target)) {
    target.focus({ preventScroll: true });
  }
});
