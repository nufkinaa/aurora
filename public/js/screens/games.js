// Games: grid of 21 canvas arcade games. The engine (games/engine.js +
// games/arcade.js, classic scripts) is reused as-is - this screen provides
// the DOM contract it expects (game-canvas, game-overlay, leaderboards...).
import { el, icons, toast } from "../ui.js";
import { pushScope, popScope } from "../focus.js";
import { reportActivity, send } from "../ws.js";

export const GAMES = [
  { id: "snake", name: "Snake", desc: "Classic snake game", icon: "🐍" },
  { id: "pong", name: "Pong", desc: "Two-paddle arcade classic", icon: "🏓" },
  { id: "breakout", name: "Breakout", desc: "Break all the bricks", icon: "🧱" },
  { id: "spaceinvaders", name: "Space Invaders", desc: "Defend Earth from aliens", icon: "👾" },
  { id: "pacman", name: "Pac-Man", desc: "Eat dots, avoid ghosts", icon: "🟡" },
  { id: "tetris", name: "Blocks", desc: "Stack falling blocks", icon: "🟪" },
  { id: "flappy", name: "Flappy", desc: "Fly through pipes", icon: "🐤" },
  { id: "crossy", name: "Crossy", desc: "Cross the road safely", icon: "🐔" },
  { id: "doodlejump", name: "Doodle Jump", desc: "Jump to the top", icon: "🦘" },
  { id: "asteroids", name: "Asteroids", desc: "1979 arcade classic", icon: "☄️" },
  { id: "galaga", name: "Galaga", desc: "1981 space shooter", icon: "🚀" },
  { id: "game2048", name: "2048", desc: "Slide to combine", icon: "🔢" },
  { id: "simon", name: "Simon Says", desc: "Memory challenge", icon: "🎨" },
  { id: "trivia", name: "Trivia", desc: "Test your knowledge!", icon: "🧠" },
  { id: "wordle", name: "Wordle", desc: "Guess the 5-letter word", icon: "🟩" },
  { id: "hangman", name: "Hangman", desc: "Guess before you hang", icon: "🪢" },
  { id: "tower", name: "Tower Builder", desc: "Stack blocks sky high", icon: "🏗️" },
  { id: "runner", name: "Endless Runner", desc: "Run, jump, survive!", icon: "🏃" },
  { id: "scramble", name: "Word Scramble", desc: "Unscramble the word", icon: "🔤" },
  { id: "jetfighter", name: "Jet Fighter", desc: "1975 aerial combat", icon: "✈️" },
  { id: "gridlock", name: "Grid Lock", desc: "Slide cars to escape", icon: "🚗" },
];

// Game constructors are exposed by engine.js as window.AuroraGameClasses

let engineLoaded = false;
const loadEngine = () =>
  new Promise((resolve, reject) => {
    if (engineLoaded) return resolve();
    let remaining = 2;
    const done = () => {
      if (--remaining === 0) {
        engineLoaded = true;
        // engine's NameInputHandler.init ran before our DOM exists; rerun later
        resolve();
      }
    };
    for (const src of ["/js/games/engine.js", "/js/games/arcade.js"]) {
      const s = document.createElement("script");
      s.src = src;
      s.onload = done;
      s.onerror = reject;
      document.head.append(s);
    }
  });

const highScore = (gameId) => {
  try {
    const board = JSON.parse(localStorage.getItem("leaderboard_" + gameId) || "[]");
    if (!board.length) return null;
    board.sort((a, b) => b.score - a.score);
    return board[0];
  } catch {
    return null;
  }
};

const openGame = async (game) => {
  try {
    await loadEngine();
  } catch {
    return toast("Couldn't load the game engine", "⚠️");
  }

  reportActivity("Playing", game.name);

  const scoreEl = el("span", { class: "score", id: "game-score" }, "Score: 0");
  const canvas = el("canvas", { id: "game-canvas" });

  const overlay = el("div", { class: "game-overlay", id: "game-overlay" },
    el("h2", { id: "game-overlay-title" }, "Ready to play?"),
    el("p", { id: "game-overlay-text" }, "Arrow keys to move · Enter to act"),
    el("div", { id: "game-leaderboard", style: { display: "none", minWidth: "280px" } },
      el("div", { class: "menu-title", style: { textAlign: "center" } }, "Leaderboard"),
      el("div", { id: "leaderboard-list" })
    ),
    el("button", { class: "btn btn-primary focusable", id: "game-start-btn" }, "Start Game")
  );

  const nameModal = el("div", { class: "name-input-modal", id: "name-input-modal", style: { display: "none" } },
    el("div", { class: "modal", style: { textAlign: "center" } },
      el("h2", {}, "🏆 New high score!"),
      el("p", { id: "name-input-score", style: { color: "var(--text-dim)", marginBottom: "14px" } }),
      el("div", { class: "field" },
        el("input", { type: "text", id: "name-input-field", class: "focusable", maxlength: "16", placeholder: "Your name" })
      ),
      el("button", { class: "btn btn-primary focusable", id: "name-submit-btn" }, "Save score")
    )
  );

  const stage = el("div", { class: "game-stage ui-overlay" },
    el("div", { class: "game-head" },
      el("button", { class: "pbtn focusable", html: icons.back, "aria-label": "Close game", onclick: () => close() }),
      el("span", { class: "title" }, game.name),
      scoreEl,
      el("span", { style: { flex: 1 } }),
      el("button", {
        class: "pbtn focusable", id: "sound-toggle", "aria-label": "Toggle sound",
        onclick: () => window.SoundSystem && window.SoundSystem.toggleMute && window.SoundSystem.toggleMute(),
      }, "🔊")
    ),
    el("div", { class: "game-body" }, canvas, overlay, nameModal)
  );

  document.body.append(stage);
  document.body.style.overflow = "hidden";
  pushScope(stage);

  // engine hooks
  if (window.NameInputHandler) window.NameInputHandler.init();
  if (window.SoundSystem && window.SoundSystem.init) window.SoundSystem.init();
  if (window.LeaderboardManager) window.LeaderboardManager.renderLeaderboard(game.id);

  // Send scores to the server-side leaderboard too (once per game session)
  if (window.LeaderboardManager && !window.LeaderboardManager.__auroraPatched) {
    window.LeaderboardManager.__auroraPatched = true;
    const origAdd = window.LeaderboardManager.addScore.bind(window.LeaderboardManager);
    window.LeaderboardManager.addScore = (gameId, name, score) => {
      send({ type: "submit_score", gameId, name, score });
      return origAdd(gameId, name, score);
    };
  }

  const startBtn = overlay.querySelector("#game-start-btn");

  const startGame = () => {
    overlay.classList.add("hidden");
    document.body.classList.add("suspend-nav");

    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    const ClassRef = (window.AuroraGameClasses || {})[game.id];
    if (!ClassRef) {
      toast("Game unavailable", "⚠️");
      return close();
    }
    if (window.currentGameInstance?.stop) window.currentGameInstance.stop();
    window.currentGameInstance = new ClassRef(canvas, ctx);
    window.currentGameInstance.start();
  };
  startBtn.onclick = startGame;

  // The engine shows the overlay again on game over -> re-enable navigation
  const observer = new MutationObserver(() => {
    const overlayVisible = !overlay.classList.contains("hidden");
    const nameVisible = nameModal.style.display !== "none";
    document.body.classList.toggle("suspend-nav", !overlayVisible && !nameVisible);
    if (nameVisible) {
      nameModal.querySelector("#name-input-field").focus();
    } else if (overlayVisible) {
      startBtn.textContent = "Play again";
      startBtn.focus({ preventScroll: true });
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ["class", "style"] });
  observer.observe(nameModal, { attributes: true, attributeFilter: ["class", "style"] });

  const onBack = (e) => {
    e.preventDefault();
    if (nameModal.style.display !== "none") {
      window.NameInputHandler && window.NameInputHandler.submit();
      return;
    }
    close();
  };
  document.addEventListener("ui-back", onBack);

  const close = () => {
    if (window.currentGameInstance?.stop) window.currentGameInstance.stop();
    window.currentGameInstance = null;
    document.removeEventListener("ui-back", onBack);
    observer.disconnect();
    document.body.classList.remove("suspend-nav");
    document.body.style.overflow = "";
    popScope(stage);
    stage.remove();
    reportActivity("Browsing");
    refreshGrid();
  };

  startBtn.focus({ preventScroll: true });
};

let gridHost = null;
const refreshGrid = () => {
  if (!gridHost || !gridHost.isConnected) return;
  gridHost.innerHTML = "";
  for (const g of GAMES) {
    const hs = highScore(g.id);
    gridHost.append(
      el("button", { class: "game-card focusable", onclick: () => openGame(g) },
        el("div", { class: "g-icon" }, g.icon),
        el("div", { class: "g-name" }, g.name),
        el("div", { class: "g-desc" }, g.desc),
        hs && el("div", { class: "g-score" }, `Best: ${hs.score} · ${hs.name}`)
      )
    );
  }
};

export const renderGames = async (root) => {
  const screen = el("div", { class: "screen" },
    el("div", { class: "browse-head" },
      el("h1", {}, "Games"),
      el("span", { class: "count" }, `${GAMES.length} games`)
    )
  );
  gridHost = el("div", { class: "game-grid" });
  screen.append(gridHost);
  root.append(screen);
  refreshGrid();
};
