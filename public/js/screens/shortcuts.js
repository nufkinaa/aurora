// Keyboard shortcuts overlay ("?").
import { el } from "../ui.js";
import { pushScope, popScope } from "../focus.js";

const SHORTCUTS = [
  ["Arrows", "Move around (D-pad on remotes)"],
  ["Enter", "Select / OK"],
  ["Esc / Back", "Go back, close menus"],
  ["Space", "Play / pause"],
  ["← / →", "Skip 10s — keep tapping to jump faster"],
  ["C", "Subtitles menu"],
  ["M", "Mute"],
  ["F", "Fullscreen"],
  ["?", "This overlay"],
];

let open = false;

export const showShortcutsOverlay = () => {
  if (open) return;
  open = true;

  const close = () => {
    open = false;
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
  };
  const onBack = (e) => { e.preventDefault(); close(); };

  const backdrop = el("div", {
    class: "modal-backdrop ui-overlay",
    onclick: (e) => e.target === backdrop && close(),
  },
    el("div", { class: "modal", style: { maxWidth: "440px" } },
      el("h2", {}, "Keyboard shortcuts"),
      el("div", { class: "shortcut-list" },
        SHORTCUTS.map(([key, desc]) =>
          el("div", { class: "shortcut-row" },
            el("kbd", {}, key),
            el("span", {}, desc)
          )
        )
      ),
      el("button", { class: "btn focusable", style: { marginTop: "18px" }, onclick: close }, "Close")
    )
  );

  document.body.append(backdrop);
  document.addEventListener("ui-back", onBack);
  pushScope(backdrop);
};
