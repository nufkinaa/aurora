// Leaderboard Manager
var LeaderboardManager = {
  getLeaderboard: function (gameId) {
    try {
      var data = localStorage.getItem("leaderboard_" + gameId);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  },

  saveLeaderboard: function (gameId, leaderboard) {
    try {
      localStorage.setItem(
        "leaderboard_" + gameId,
        JSON.stringify(leaderboard)
      );
    } catch (e) {
      console.log("Could not save leaderboard");
    }
  },

  isHighScore: function (gameId, score) {
    var leaderboard = this.getLeaderboard(gameId);
    if (leaderboard.length < 10) return score > 0;
    return score > leaderboard[leaderboard.length - 1].score;
  },

  addScore: function (gameId, name, score) {
    var leaderboard = this.getLeaderboard(gameId);
    leaderboard.push({ name: name, score: score, date: Date.now() });

    // Sort by score descending
    leaderboard.sort(function (a, b) {
      return b.score - a.score;
    });

    // Keep only top 10
    if (leaderboard.length > 10) {
      leaderboard = leaderboard.slice(0, 10);
    }

    this.saveLeaderboard(gameId, leaderboard);
    return leaderboard;
  },

  renderLeaderboard: function (gameId) {
    var leaderboard = this.getLeaderboard(gameId);
    var listEl = document.getElementById("leaderboard-list");
    var boardEl = document.getElementById("game-leaderboard");

    if (!listEl || !boardEl) return;

    if (leaderboard.length === 0) {
      listEl.innerHTML =
        '<div class="leaderboard-empty">No scores yet. Be the first!</div>';
    } else {
      var html = "";
      for (var i = 0; i < leaderboard.length; i++) {
        var entry = leaderboard[i];
        html +=
          '<div class="leaderboard-entry">' +
          '<span class="leaderboard-rank">#' +
          (i + 1) +
          "</span>" +
          '<span class="leaderboard-name">' +
          entry.name +
          "</span>" +
          '<span class="leaderboard-score">' +
          entry.score +
          "</span>" +
          "</div>";
      }
      listEl.innerHTML = html;
    }

    boardEl.style.display = "block";
  },
};

// Name Input Handler
var NameInputHandler = {
  pendingGameId: null,
  pendingScore: 0,

  show: function (gameId, score) {
    this.pendingGameId = gameId;
    this.pendingScore = score;

    var modal = document.getElementById("name-input-modal");
    var scoreText = document.getElementById("name-input-score");
    var input = document.getElementById("name-input-field");

    if (scoreText) scoreText.textContent = "Score: " + score;
    if (input) input.value = "";

    if (modal) {
      modal.style.display = "flex";
      modal.style.display = "-webkit-flex";
      modal.className = "name-input-modal active";
    }

    if (input) {
      setTimeout(function () {
        input.focus();
      }, 100);
    }
  },

  hide: function () {
    var modal = document.getElementById("name-input-modal");
    if (modal) {
      modal.style.display = "none";
      modal.className = "name-input-modal";
    }
  },

  submit: function () {
    var input = document.getElementById("name-input-field");
    var name = input ? input.value.trim() : "";

    if (!name) name = "PLAYER";

    LeaderboardManager.addScore(this.pendingGameId, name, this.pendingScore);
    this.hide();

    // Show updated leaderboard
    LeaderboardManager.renderLeaderboard(this.pendingGameId);

    // Focus play again button
    var btn = document.getElementById("game-start-btn");
    if (btn) btn.focus();
  },

  init: function () {
    var self = this;
    var submitBtn = document.getElementById("name-submit-btn");
    var input = document.getElementById("name-input-field");

    if (submitBtn) {
      submitBtn.onclick = function () {
        self.submit();
      };
    }

    if (input) {
      input.onkeydown = function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
          self.submit();
        }
      };
    }
  },
};

// Initialize name input handler when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    NameInputHandler.init();
  });
} else {
  NameInputHandler.init();
}

// Global session counter to prevent race conditions
var globalGameSession = 0;

// Base Game Class
class BaseGame {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.running = false;
    this.score = 0;
    this.animationId = null;
    this.keys = {};
    this.gameId = "unknown";
    this.isGameOver = false;
    this.sessionId = 0;
    this.startTime = 0;
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
  }

  start() {
    // Cancel any existing animation frame first
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Increment global session to invalidate any pending callbacks
    globalGameSession++;
    this.sessionId = globalGameSession;

    this.running = true;
    this.isGameOver = false;
    this.score = 0;
    this.startTime = Date.now();
    this.keys = {}; // Clear any stuck keys
    this.updateScore();

    document.addEventListener("keydown", this.handleKeyDown);
    document.addEventListener("keyup", this.handleKeyUp);
    this.init();
    this.gameLoop();
  }

  stop() {
    this.running = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    document.removeEventListener("keydown", this.handleKeyDown);
    document.removeEventListener("keyup", this.handleKeyUp);
  }

  handleKeyDown(e) {
    // Supported keys: arrows, space, enter, and number keys 0-9
    var dominated = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      " ",
      "Enter",
    ];
    var dominated2 = [
      38, 40, 37, 39, 32, 13, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
    ]; // keyCodes including Enter and 0-9
    var keyCodeToName = {
      38: "ArrowUp",
      40: "ArrowDown",
      37: "ArrowLeft",
      39: "ArrowRight",
      32: " ",
      13: "Enter",
      48: "0",
      49: "1",
      50: "2",
      51: "3",
      52: "4",
      53: "5",
      54: "6",
      55: "7",
      56: "8",
      57: "9",
    };

    if (
      dominated.indexOf(e.key) !== -1 ||
      dominated2.indexOf(e.keyCode) !== -1 ||
      (e.key >= "0" && e.key <= "9")
    ) {
      e.preventDefault();

      if (e.key) {
        this.keys[e.key] = true;
        // Also set 'action' for Enter or Space (TV remote center button)
        if (e.key === "Enter" || e.key === " ") {
          this.keys["action"] = true;
        }
      }
      if (e.keyCode) {
        this.keys[e.keyCode] = true;
        var keyName = keyCodeToName[e.keyCode];
        if (keyName) {
          this.keys[keyName] = true;
          if (keyName === "Enter" || keyName === " ") {
            this.keys["action"] = true;
          }
        }
      }
    }
  }

  handleKeyUp(e) {
    var keyCodeToName = {
      38: "ArrowUp",
      40: "ArrowDown",
      37: "ArrowLeft",
      39: "ArrowRight",
      32: " ",
      13: "Enter",
      48: "0",
      49: "1",
      50: "2",
      51: "3",
      52: "4",
      53: "5",
      54: "6",
      55: "7",
      56: "8",
      57: "9",
    };

    if (e.key) {
      this.keys[e.key] = false;
      if (e.key === "Enter" || e.key === " ") {
        this.keys["action"] = false;
      }
    }
    if (e.keyCode) {
      this.keys[e.keyCode] = false;
      var keyName = keyCodeToName[e.keyCode];
      if (keyName) {
        this.keys[keyName] = false;
        if (keyName === "Enter" || keyName === " ") {
          this.keys["action"] = false;
        }
      }
    }
  }

  updateScore() {
    var el = document.getElementById("game-score");
    if (el) el.textContent = "Score: " + this.score;
  }

  gameOver() {
    // Check if this session is still valid (prevents race condition)
    if (this.sessionId !== globalGameSession) return;

    // Prevent multiple gameOver calls
    if (this.isGameOver) return;
    this.isGameOver = true;

    this.stop();

    // Play game over sound
    if (typeof SoundSystem !== "undefined") {
      SoundSystem.playGameOver();
    }

    // Screen shake effect
    if (typeof ScreenShake !== "undefined") {
      ScreenShake.shake();
    }

    // Record stats
    var duration = Date.now() - this.startTime;
    if (typeof PlayerStats !== "undefined") {
      PlayerStats.recordGame(this.gameId, this.score, duration);
    }

    var overlay = document.getElementById("game-overlay");
    var title = document.getElementById("game-overlay-title");
    var text = document.getElementById("game-overlay-text");
    var btn = document.getElementById("game-start-btn");

    // Check if in tournament mode
    if (typeof TournamentMode !== "undefined" && TournamentMode.active) {
      var result = TournamentMode.recordScore(this.score);

      if (result && result.finished) {
        // Tournament finished
        if (title) title.textContent = TournamentMode.getWinnerMessage();
        if (text)
          text.textContent =
            "P1: " +
            TournamentMode.player1Score +
            " vs P2: " +
            TournamentMode.player2Score;
        if (btn) btn.textContent = "New Tournament";
        TournamentMode.end();
      } else if (result) {
        // Next player's turn
        if (title)
          title.textContent = "PLAYER " + result.nextPlayer + " - YOUR TURN!";
        if (text)
          text.textContent = "Player 1 scored: " + TournamentMode.player1Score;
        if (btn) btn.textContent = "Start";
      }
    } else {
      if (title) title.textContent = "Game Over!";
      if (text) text.textContent = "Final Score: " + this.score;
      if (btn) btn.textContent = "Play Again";
    }

    if (overlay) {
      overlay.className = "game-overlay";
      overlay.style.display = "flex";
      overlay.style.display = "-webkit-flex";
    }

    // Show stats
    if (typeof PlayerStats !== "undefined") {
      PlayerStats.renderStats(this.gameId);
    }

    if (LeaderboardManager.isHighScore(this.gameId, this.score)) {
      NameInputHandler.show(this.gameId, this.score);
    } else {
      LeaderboardManager.renderLeaderboard(this.gameId);
      if (btn) btn.focus();
    }
  }

  init() {}
  update() {}
  draw() {}

  gameLoop() {
    var self = this;
    // Check session is still valid before continuing
    if (!this.running || this.sessionId !== globalGameSession) return;

    this.update();
    // Double-check after update in case gameOver was called
    if (!this.running || this.sessionId !== globalGameSession) return;
    this.draw();

    this.animationId = requestAnimationFrame(function () {
      self.gameLoop();
    });
  }

  // Helper methods - sound only, particles disabled for TV performance
  playSound(type) {
    if (typeof SoundSystem === "undefined") return;
    switch (type) {
      case "move":
        SoundSystem.playMove();
        break;
      case "score":
        SoundSystem.playScore();
        break;
      case "hit":
        SoundSystem.playHit();
        break;
      case "powerup":
        SoundSystem.playPowerUp();
        break;
      case "levelup":
        SoundSystem.playLevelUp();
        break;
      case "shoot":
        SoundSystem.playShoot();
        break;
      case "explosion":
        SoundSystem.playExplosion();
        break;
      case "jump":
        SoundSystem.playJump();
        break;
      case "eat":
        SoundSystem.playEat();
        break;
    }
  }

  // Particles disabled for TV performance - these are now no-ops
  createExplosion(x, y, color, count) {}
  createSparkle(x, y, color) {}
  createTrail(x, y, color) {}
  showScorePopup(x, y, text) {}
  shake() {}
}

// Snake Game
class SnakeGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "snake";
  }

  init() {
    this.gridSize = 20;
    this.snake = [{ x: 10, y: 10 }];
    this.direction = { x: 1, y: 0 };
    this.nextDirection = { x: 1, y: 0 };
    this.food = this.spawnFood();
    this.lastMove = 0;
    this.moveInterval = 100;
  }

  spawnFood() {
    let food;
    do {
      food = {
        x: Math.floor(Math.random() * (this.canvas.width / this.gridSize)),
        y: Math.floor(Math.random() * (this.canvas.height / this.gridSize)),
      };
    } while (this.snake.some((s) => s.x === food.x && s.y === food.y));

    // Sparkle effect at food location
    this.createSparkle(
      food.x * this.gridSize + this.gridSize / 2,
      food.y * this.gridSize + this.gridSize / 2,
      "#f97316"
    );

    return food;
  }

  update() {
    const now = Date.now();

    // Handle input
    if (this.keys["ArrowUp"] && this.direction.y !== 1)
      this.nextDirection = { x: 0, y: -1 };
    if (this.keys["ArrowDown"] && this.direction.y !== -1)
      this.nextDirection = { x: 0, y: 1 };
    if (this.keys["ArrowLeft"] && this.direction.x !== 1)
      this.nextDirection = { x: -1, y: 0 };
    if (this.keys["ArrowRight"] && this.direction.x !== -1)
      this.nextDirection = { x: 1, y: 0 };

    if (now - this.lastMove < this.moveInterval) return;
    this.lastMove = now;
    this.direction = { ...this.nextDirection };

    const head = {
      x: this.snake[0].x + this.direction.x,
      y: this.snake[0].y + this.direction.y,
    };

    // Wall collision
    const maxX = this.canvas.width / this.gridSize;
    const maxY = this.canvas.height / this.gridSize;
    if (head.x < 0 || head.x >= maxX || head.y < 0 || head.y >= maxY) {
      this.gameOver();
      return;
    }

    // Self collision
    if (this.snake.some((s) => s.x === head.x && s.y === head.y)) {
      this.gameOver();
      return;
    }

    this.snake.unshift(head);

    if (head.x === this.food.x && head.y === this.food.y) {
      this.score += 10;
      this.updateScore();

      // Sound and particles when eating
      this.playSound("eat");
      this.createSparkle(
        head.x * this.gridSize + this.gridSize / 2,
        head.y * this.gridSize + this.gridSize / 2,
        "#22c55e"
      );
      this.showScorePopup(
        head.x * this.gridSize + this.gridSize / 2,
        head.y * this.gridSize,
        "10"
      );

      this.food = this.spawnFood();
      this.moveInterval = Math.max(50, this.moveInterval - 2);
    } else {
      this.snake.pop();
    }
  }

  draw() {
    const { ctx, canvas, gridSize } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid
    ctx.strokeStyle = "#1a1025";
    for (let i = 0; i <= canvas.width; i += gridSize) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvas.height);
      ctx.stroke();
    }
    for (let i = 0; i <= canvas.height; i += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(canvas.width, i);
      ctx.stroke();
    }

    // Draw food
    ctx.fillStyle = "#f97316";
    ctx.beginPath();
    ctx.arc(
      this.food.x * gridSize + gridSize / 2,
      this.food.y * gridSize + gridSize / 2,
      gridSize / 2 - 2,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // Draw snake
    this.snake.forEach((segment, i) => {
      const gradient = ctx.createLinearGradient(
        segment.x * gridSize,
        segment.y * gridSize,
        segment.x * gridSize + gridSize,
        segment.y * gridSize + gridSize
      );
      gradient.addColorStop(0, "#7c3aed");
      gradient.addColorStop(1, "#a78bfa");
      ctx.fillStyle = i === 0 ? "#7c3aed" : gradient;
      ctx.fillRect(
        segment.x * gridSize + 1,
        segment.y * gridSize + 1,
        gridSize - 2,
        gridSize - 2
      );
    });
  }
}

// Pong Game
class PongGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "pong";
  }

  init() {
    this.paddleHeight = 80;
    this.paddleWidth = 10;
    this.ballSize = 10;
    this.leftPaddleX = 10; // Fixed position for left paddle
    this.rightPaddleX = this.canvas.width - 20; // Fixed position for right paddle

    this.leftPaddle = { y: this.canvas.height / 2 - this.paddleHeight / 2 };
    this.rightPaddle = { y: this.canvas.height / 2 - this.paddleHeight / 2 };
    this.ball = {
      x: this.canvas.width / 2,
      y: this.canvas.height / 2,
      vx: 5,
      vy: 3,
    };
    this.aiSpeed = 3;
  }

  update() {
    // Player paddle
    if (this.keys["ArrowUp"]) this.leftPaddle.y -= 8;
    if (this.keys["ArrowDown"]) this.leftPaddle.y += 8;
    this.leftPaddle.y = Math.max(
      0,
      Math.min(this.canvas.height - this.paddleHeight, this.leftPaddle.y)
    );

    // AI paddle
    const paddleCenter = this.rightPaddle.y + this.paddleHeight / 2;
    if (this.ball.y < paddleCenter - 10) this.rightPaddle.y -= this.aiSpeed;
    if (this.ball.y > paddleCenter + 10) this.rightPaddle.y += this.aiSpeed;
    this.rightPaddle.y = Math.max(
      0,
      Math.min(this.canvas.height - this.paddleHeight, this.rightPaddle.y)
    );

    // Ball movement
    this.ball.x += this.ball.vx;
    this.ball.y += this.ball.vy;

    // Top/bottom collision - clamp ball
    if (this.ball.y <= this.ballSize) {
      this.ball.y = this.ballSize;
      this.ball.vy = Math.abs(this.ball.vy);
    }
    if (this.ball.y >= this.canvas.height - this.ballSize) {
      this.ball.y = this.canvas.height - this.ballSize;
      this.ball.vy = -Math.abs(this.ball.vy);
    }

    // Left paddle collision - check if ball overlaps with paddle
    const leftPaddleRight = this.leftPaddleX + this.paddleWidth;
    if (
      this.ball.x - this.ballSize <= leftPaddleRight &&
      this.ball.x + this.ballSize >= this.leftPaddleX &&
      this.ball.y >= this.leftPaddle.y &&
      this.ball.y <= this.leftPaddle.y + this.paddleHeight &&
      this.ball.vx < 0
    ) {
      // Only if moving left
      this.ball.x = leftPaddleRight + this.ballSize; // Push ball out
      this.ball.vx = Math.abs(this.ball.vx) * 1.02; // Slight speed increase
      // Add some angle based on where ball hits paddle
      const hitPos = (this.ball.y - this.leftPaddle.y) / this.paddleHeight;
      this.ball.vy += (hitPos - 0.5) * 2;
      this.score += 1;
      this.updateScore();
    }

    // Right paddle collision
    const rightPaddleLeft = this.rightPaddleX;
    if (
      this.ball.x + this.ballSize >= rightPaddleLeft &&
      this.ball.x - this.ballSize <= rightPaddleLeft + this.paddleWidth &&
      this.ball.y >= this.rightPaddle.y &&
      this.ball.y <= this.rightPaddle.y + this.paddleHeight &&
      this.ball.vx > 0
    ) {
      // Only if moving right
      this.ball.x = rightPaddleLeft - this.ballSize; // Push ball out
      this.ball.vx = -Math.abs(this.ball.vx);
    }

    // Game over - ball passes left edge completely
    if (this.ball.x + this.ballSize < 0) {
      this.gameOver();
      return;
    }

    // Player scores - ball passes right edge completely
    if (this.ball.x - this.ballSize > this.canvas.width) {
      this.score += 5;
      this.updateScore();
      this.ball = {
        x: this.canvas.width / 2,
        y: this.canvas.height / 2,
        vx: -5,
        vy: (Math.random() - 0.5) * 6,
      };
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Center line
    ctx.strokeStyle = "#2d1f42";
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Paddles
    ctx.fillStyle = "#7c3aed";
    ctx.fillRect(10, this.leftPaddle.y, this.paddleWidth, this.paddleHeight);
    ctx.fillStyle = "#f97316";
    ctx.fillRect(
      canvas.width - 20,
      this.rightPaddle.y,
      this.paddleWidth,
      this.paddleHeight
    );

    // Ball
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, this.ballSize, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Breakout Game
class BreakoutGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "breakout";
    this.brickColors = [
      "#7c3aed",
      "#a855f7",
      "#c084fc",
      "#e879f9",
      "#f97316",
      "#fb923c",
      "#fbbf24",
      "#facc15",
    ];
  }

  start() {
    // Reset level on new game
    this.level = 1;
    this.ballSpeed = 4;
    super.start();
  }

  init() {
    // Initialize level if not set
    if (typeof this.level === "undefined") this.level = 1;
    if (typeof this.ballSpeed === "undefined") this.ballSpeed = 4;

    // Paddle gets smaller at higher levels
    this.basePaddleWidth = 100;
    this.paddleWidth = Math.max(
      50,
      this.basePaddleWidth - (this.level - 1) * 10
    );
    this.paddleHeight = 12;
    this.paddle = { x: this.canvas.width / 2 - this.paddleWidth / 2 };

    this.ballRadius = 8;
    this.ball = {
      x: this.canvas.width / 2,
      y: this.canvas.height - 60,
      vx: this.ballSpeed * (Math.random() > 0.5 ? 1 : -1),
      vy: -this.ballSpeed,
    };

    // More brick rows at higher levels (5 base + 1 per level, max 8)
    this.brickRows = Math.min(8, 4 + this.level);
    this.brickCols = 10;
    this.brickWidth = 55;
    this.brickHeight = 20;
    this.brickPadding = 3;
    this.brickOffsetTop = 40;
    this.brickOffsetLeft =
      (this.canvas.width -
        this.brickCols * (this.brickWidth + this.brickPadding)) /
      2;

    this.bricks = [];
    for (let r = 0; r < this.brickRows; r++) {
      this.bricks[r] = [];
      for (let c = 0; c < this.brickCols; c++) {
        this.bricks[r][c] = { status: 1 };
      }
    }

    this.bricksRemaining = this.brickRows * this.brickCols;
  }

  nextLevel() {
    this.level++;
    // Increase ball speed by 15% each level
    this.ballSpeed = Math.min(10, this.ballSpeed * 1.15);
    this.init();
  }

  update() {
    // Paddle movement
    if (this.keys["ArrowLeft"]) this.paddle.x -= 8;
    if (this.keys["ArrowRight"]) this.paddle.x += 8;
    this.paddle.x = Math.max(
      0,
      Math.min(this.canvas.width - this.paddleWidth, this.paddle.x)
    );

    // Ball movement
    this.ball.x += this.ball.vx;
    this.ball.y += this.ball.vy;

    // Wall collisions - clamp ball inside bounds
    if (this.ball.x <= this.ballRadius) {
      this.ball.x = this.ballRadius;
      this.ball.vx = Math.abs(this.ball.vx);
    }
    if (this.ball.x >= this.canvas.width - this.ballRadius) {
      this.ball.x = this.canvas.width - this.ballRadius;
      this.ball.vx = -Math.abs(this.ball.vx);
    }
    if (this.ball.y <= this.ballRadius) {
      this.ball.y = this.ballRadius;
      this.ball.vy = Math.abs(this.ball.vy);
    }

    // Paddle collision - improved detection
    const paddleTop = this.canvas.height - 30;
    const paddleBottom = paddleTop + this.paddleHeight;

    if (
      this.ball.y + this.ballRadius >= paddleTop &&
      this.ball.y - this.ballRadius <= paddleBottom &&
      this.ball.x >= this.paddle.x &&
      this.ball.x <= this.paddle.x + this.paddleWidth &&
      this.ball.vy > 0
    ) {
      // Only bounce if moving down

      this.ball.y = paddleTop - this.ballRadius; // Place ball above paddle
      this.ball.vy = -Math.abs(this.ball.vy);

      // Adjust angle based on where ball hits paddle
      const hitPos = (this.ball.x - this.paddle.x) / this.paddleWidth;
      const angle = (hitPos - 0.5) * Math.PI * 0.6; // Max 54 degree angle
      const speed = Math.sqrt(
        this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy
      );
      this.ball.vx = Math.sin(angle) * speed;
      this.ball.vy = -Math.cos(angle) * speed;
    }

    // Bottom - game over (only if ball is completely below screen)
    if (this.ball.y - this.ballRadius > this.canvas.height) {
      this.gameOver();
      return;
    }

    // Brick collisions
    var hitBrick = false;
    for (let r = 0; r < this.brickRows; r++) {
      for (let c = 0; c < this.brickCols; c++) {
        const brick = this.bricks[r][c];
        if (brick.status === 1) {
          const brickX =
            c * (this.brickWidth + this.brickPadding) + this.brickOffsetLeft;
          const brickY =
            r * (this.brickHeight + this.brickPadding) + this.brickOffsetTop;

          if (
            this.ball.x + this.ballRadius >= brickX &&
            this.ball.x - this.ballRadius <= brickX + this.brickWidth &&
            this.ball.y + this.ballRadius >= brickY &&
            this.ball.y - this.ballRadius <= brickY + this.brickHeight
          ) {
            if (!hitBrick) {
              // Only bounce once per frame
              // Determine which side was hit
              const overlapLeft = this.ball.x + this.ballRadius - brickX;
              const overlapRight =
                brickX + this.brickWidth - (this.ball.x - this.ballRadius);
              const overlapTop = this.ball.y + this.ballRadius - brickY;
              const overlapBottom =
                brickY + this.brickHeight - (this.ball.y - this.ballRadius);

              const minOverlapX = Math.min(overlapLeft, overlapRight);
              const minOverlapY = Math.min(overlapTop, overlapBottom);

              if (minOverlapX < minOverlapY) {
                this.ball.vx *= -1;
              } else {
                this.ball.vy *= -1;
              }
              hitBrick = true;
            }

            brick.status = 0;
            this.bricksRemaining--;
            this.score += 10;
            this.updateScore();

            // Sound and particles for brick hit
            this.playSound("hit");
            const brickCenterX =
              c * (this.brickWidth + this.brickPadding) +
              this.brickOffsetLeft +
              this.brickWidth / 2;
            const brickCenterY =
              r * (this.brickHeight + this.brickPadding) +
              this.brickOffsetTop +
              this.brickHeight / 2;
            this.createExplosion(
              brickCenterX,
              brickCenterY,
              this.brickColors[r % this.brickColors.length],
              8
            );
            this.showScorePopup(brickCenterX, brickCenterY - 10, "10");
          }
        }
      }
    }

    // Check for level complete
    if (this.bricksRemaining <= 0) {
      this.score += 100; // Bonus for completing level
      this.updateScore();
      this.playSound("levelup");
      this.nextLevel();
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw level indicator
    ctx.fillStyle = "#a78bfa";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText("Level " + this.level, 10, 25);

    // Draw bricks
    for (let r = 0; r < this.brickRows; r++) {
      for (let c = 0; c < this.brickCols; c++) {
        if (this.bricks[r][c].status === 1) {
          const brickX =
            c * (this.brickWidth + this.brickPadding) + this.brickOffsetLeft;
          const brickY =
            r * (this.brickHeight + this.brickPadding) + this.brickOffsetTop;
          ctx.fillStyle = this.brickColors[r % this.brickColors.length];
          ctx.fillRect(brickX, brickY, this.brickWidth, this.brickHeight);
        }
      }
    }

    // Draw paddle
    ctx.fillStyle = "#f97316";
    ctx.fillRect(
      this.paddle.x,
      this.canvas.height - 30,
      this.paddleWidth,
      this.paddleHeight
    );

    // Draw ball
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, this.ballRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Space Invaders Game
class SpaceInvadersGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "spaceinvaders";
  }

  init() {
    this.player = {
      x: this.canvas.width / 2 - 20,
      y: this.canvas.height - 50,
      width: 40,
      height: 20,
    };
    this.bullets = [];
    this.enemyBullets = [];
    this.lastShot = 0;
    this.shotCooldown = 300;
    this.enemyDirection = 1;
    this.lastEnemyMove = 0;

    // Keep difficulty settings if they exist, otherwise set defaults
    if (typeof this.enemyMoveInterval === "undefined") {
      this.enemyMoveInterval = 500;
    }
    if (typeof this.level === "undefined") {
      this.level = 1;
    }

    // Create enemies
    this.enemies = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 8; col++) {
        this.enemies.push({
          x: col * 60 + 50,
          y: row * 40 + 40,
          width: 30,
          height: 20,
          alive: true,
        });
      }
    }
  }

  // Reset for new game (called from start())
  start() {
    this.enemyMoveInterval = 500;
    this.level = 1;
    super.start();
  }

  update() {
    const now = Date.now();

    // Player movement
    if (this.keys["ArrowLeft"]) this.player.x -= 6;
    if (this.keys["ArrowRight"]) this.player.x += 6;
    this.player.x = Math.max(
      0,
      Math.min(this.canvas.width - this.player.width, this.player.x)
    );

    // Shooting
    if (
      (this.keys["action"] || this.keys["ArrowUp"]) &&
      now - this.lastShot > this.shotCooldown
    ) {
      this.bullets.push({
        x: this.player.x + this.player.width / 2,
        y: this.player.y,
        width: 4,
        height: 10,
      });
      this.lastShot = now;
      this.playSound("shoot");
    }

    // Update player bullets (moving up)
    this.bullets = this.bullets.filter((b) => {
      b.y -= 8;
      return b.y > 0;
    });

    // Enemy shooting (reduced frequency)
    const aliveEnemies = this.enemies.filter((e) => e.alive);
    if (aliveEnemies.length > 0 && Math.random() < 0.015) {
      const shooter =
        aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
      this.enemyBullets.push({
        x: shooter.x + shooter.width / 2,
        y: shooter.y + shooter.height,
        width: 4,
        height: 10,
      });
    }

    // Update enemy bullets (moving down)
    var hitByBullet = false;
    this.enemyBullets = this.enemyBullets.filter((b) => {
      if (hitByBullet) return false;
      b.y += 5;

      // Check player collision - use bullet's BOTTOM edge (b.y + b.height) for visual accuracy
      // Bullet hits when its bottom edge reaches player's top edge
      var bulletBottom = b.y + b.height;
      var bulletLeft = b.x - b.width / 2;
      var bulletRight = b.x + b.width / 2;

      if (
        bulletRight >= this.player.x &&
        bulletLeft <= this.player.x + this.player.width &&
        bulletBottom >= this.player.y &&
        b.y <= this.player.y + this.player.height
      ) {
        hitByBullet = true;
        return false;
      }
      return b.y < this.canvas.height;
    });

    if (hitByBullet) {
      this.gameOver();
      return;
    }

    // Move enemies
    if (now - this.lastEnemyMove > this.enemyMoveInterval) {
      let shouldReverse = false;

      // First check if any alive enemy would go out of bounds
      for (let i = 0; i < this.enemies.length; i++) {
        const enemy = this.enemies[i];
        if (!enemy.alive) continue;
        const nextX = enemy.x + this.enemyDirection * 15;
        if (nextX <= 0 || nextX + enemy.width >= this.canvas.width) {
          shouldReverse = true;
          break;
        }
      }

      if (shouldReverse) {
        // Reverse direction and move down
        this.enemyDirection *= -1;
        var enemyReachedPlayer = false;
        for (let i = 0; i < this.enemies.length; i++) {
          const enemy = this.enemies[i];
          if (enemy.alive) {
            enemy.y += 15; // Move down less aggressively
            if (enemy.y + enemy.height >= this.player.y) {
              enemyReachedPlayer = true;
            }
          }
        }
        if (enemyReachedPlayer) {
          this.gameOver();
          return;
        }
      } else {
        // Move horizontally
        for (let i = 0; i < this.enemies.length; i++) {
          const enemy = this.enemies[i];
          if (enemy.alive) {
            enemy.x += this.enemyDirection * 15;
          }
        }
      }

      this.lastEnemyMove = now;
    }

    // Bullet-enemy collisions - use a safer approach without splice during iteration
    var bulletsToRemove = [];
    for (let bi = 0; bi < this.bullets.length; bi++) {
      const bullet = this.bullets[bi];
      for (let ei = 0; ei < this.enemies.length; ei++) {
        const enemy = this.enemies[ei];
        if (!enemy.alive) continue;

        // Check if bullet hits enemy
        if (
          bullet.x >= enemy.x &&
          bullet.x <= enemy.x + enemy.width &&
          bullet.y >= enemy.y &&
          bullet.y <= enemy.y + enemy.height
        ) {
          enemy.alive = false;
          bulletsToRemove.push(bi);
          this.score += 10;
          this.updateScore();

          // Sound and particles for enemy hit
          this.playSound("explosion");
          this.createExplosion(
            enemy.x + enemy.width / 2,
            enemy.y + enemy.height / 2,
            "#22c55e",
            10
          );
          this.showScorePopup(enemy.x + enemy.width / 2, enemy.y, "10");

          break; // Bullet can only hit one enemy
        }
      }
    }

    // Remove bullets that hit enemies (in reverse order to preserve indices)
    for (let i = bulletsToRemove.length - 1; i >= 0; i--) {
      this.bullets.splice(bulletsToRemove[i], 1);
    }

    // Win condition - next level
    if (this.enemies.every((e) => !e.alive)) {
      this.score += 100;
      this.level++;
      // Make game faster for next level
      this.enemyMoveInterval = Math.max(150, this.enemyMoveInterval - 50);
      this.updateScore();
      this.playSound("levelup");
      this.init(); // Spawn new enemies
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw player
    ctx.fillStyle = "#7c3aed";
    ctx.fillRect(
      this.player.x,
      this.player.y,
      this.player.width,
      this.player.height
    );

    // Draw player bullets
    ctx.fillStyle = "#a78bfa";
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      ctx.fillRect(b.x - b.width / 2, b.y, b.width, b.height);
    }

    // Draw enemy bullets
    ctx.fillStyle = "#f97316";
    for (let i = 0; i < this.enemyBullets.length; i++) {
      const b = this.enemyBullets[i];
      ctx.fillRect(b.x - b.width / 2, b.y, b.width, b.height);
    }

    // Draw enemies
    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (!enemy.alive) continue;
      ctx.fillStyle = "#f97316";
      ctx.fillRect(enemy.x, enemy.y, enemy.width, enemy.height);
      // Eyes
      ctx.fillStyle = "#fff";
      ctx.fillRect(enemy.x + 5, enemy.y + 5, 5, 5);
      ctx.fillRect(enemy.x + 20, enemy.y + 5, 5, 5);
    }

    // Draw level indicator
    ctx.fillStyle = "#a78bfa";
    ctx.font = "14px sans-serif";
    ctx.fillText("Level: " + this.level, 10, 20);
  }
}

// Pacman Game
class PacmanGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "pacman";
  }

  start() {
    this.level = 1;
    super.start();
  }

  init() {
    this.gridSize = 20;

    // Pac-Man with queued direction
    this.pacman = {
      x: 14,
      y: 23,
      direction: { x: 0, y: 0 },
      nextDirection: { x: 0, y: 0 }, // Queued direction
      mouthOpen: true,
    };

    // Ghost house position
    this.ghostHouse = { x: 14, y: 11 };

    // Power pellet state
    this.frightened = false;
    this.frightenedTimer = 0;
    this.frightenedDuration = 8000; // 8 seconds
    this.ghostsEaten = 0;

    // Create ghosts with unique AI behaviors
    // More ghosts at higher levels
    this.initGhosts();

    this.lastMove = 0;
    this.moveInterval = 120;
    this.ghostMoveInterval = 150;
    this.lastGhostMove = 0;
    this.dotsRemaining = 0;

    // Create maze (0 = wall, 1 = dot, 2 = empty, 3 = power pellet)
    this.originalMaze = [
      [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 0,
      ],
      [
        0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0,
        0, 0, 1, 0,
      ],
      [
        0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0,
        0, 0, 3, 0,
      ],
      [
        0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0,
        0, 0, 1, 0,
      ],
      [
        0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 0,
      ],
      [
        0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0,
        0, 0, 1, 0,
      ],
      [
        0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0,
        0, 0, 1, 0,
      ],
      [
        0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1,
        1, 1, 1, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 2, 2, 0, 0, 0, 2, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 2, 2, 2, 2, 2, 2, 0, 2, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2,
        2, 2, 2, 2,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0,
        0, 0, 0, 0,
      ],
      [
        0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 0,
      ],
      [
        0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0,
        0, 0, 1, 0,
      ],
      [
        0, 3, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0,
        1, 1, 3, 0,
      ],
      [
        0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0,
        1, 0, 0, 0,
      ],
      [
        0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0,
        1, 0, 0, 0,
      ],
      [
        0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1,
        1, 1, 1, 0,
      ],
      [
        0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 1, 0,
      ],
      [
        0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 0,
      ],
      [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0,
      ],
    ];

    // Deep copy maze and count dots
    this.maze = [];
    this.dotsRemaining = 0;
    for (let y = 0; y < this.originalMaze.length; y++) {
      this.maze[y] = [];
      for (let x = 0; x < this.originalMaze[y].length; x++) {
        this.maze[y][x] = this.originalMaze[y][x];
        if (this.maze[y][x] === 1 || this.maze[y][x] === 3) {
          this.dotsRemaining++;
        }
      }
    }
  }

  initGhosts() {
    // Ghost colors and names from original Pac-Man
    // Blinky starts OUTSIDE the house, others inside
    const ghostDefs = [
      { name: "blinky", color: "#ff0000", x: 13, y: 10, inHouse: false }, // Red - starts outside
      { name: "pinky", color: "#ffb8ff", x: 13, y: 12, inHouse: true }, // Pink - in house
      { name: "inky", color: "#00ffff", x: 14, y: 12, inHouse: true }, // Cyan - in house
      { name: "clyde", color: "#ffb852", x: 15, y: 12, inHouse: true }, // Orange - in house
    ];

    // Number of ghosts based on level (2 at level 1, up to 4 at level 3+)
    const numGhosts = Math.min(4, 1 + this.level);

    this.ghosts = [];
    this.gameStartTime = Date.now();

    for (let i = 0; i < numGhosts; i++) {
      const def = ghostDefs[i];
      this.ghosts.push({
        name: def.name,
        color: def.color,
        x: def.x,
        y: def.y,
        startX: def.x,
        startY: def.y,
        direction: { x: -1, y: 0 },
        frightened: false,
        eaten: false,
        inHouse: def.inHouse,
        releaseTime: this.gameStartTime + i * 3000, // Release times: 0s, 3s, 6s, 9s
      });
    }
  }

  // Check if position is inside the ghost house (Pac-Man can't enter)
  isGhostHouse(x, y) {
    // Ghost house area is roughly: x from 10-17, y from 11-14
    return x >= 10 && x <= 17 && y >= 11 && y <= 14;
  }

  // Ghost house gate position (ghosts exit through here)
  isGhostGate(x, y) {
    return (x === 13 || x === 14) && y === 11;
  }

  // Check if a position is valid (not a wall)
  canMove(x, y, isGhost, isEaten) {
    // Handle tunnel wrapping
    if (y === 13 && (x < 0 || x >= this.maze[0].length)) {
      return true;
    }
    if (y < 0 || y >= this.maze.length || x < 0 || x >= this.maze[0].length) {
      return false;
    }

    // Pac-Man cannot enter ghost house
    if (!isGhost && this.isGhostHouse(x, y)) {
      return false;
    }

    return this.maze[y][x] !== 0;
  }

  // Get valid directions from a position (excluding reverse) - for ghosts
  getValidDirs(x, y, currentDir) {
    const dirs = [
      { x: 0, y: -1 }, // up
      { x: 0, y: 1 }, // down
      { x: -1, y: 0 }, // left
      { x: 1, y: 0 }, // right
    ];

    return dirs.filter((d) => {
      // Don't reverse direction (ghosts can't turn around)
      if (d.x === -currentDir.x && d.y === -currentDir.y) return false;
      // Ghosts can move through the maze (isGhost = true)
      return this.canMove(x + d.x, y + d.y, true, false);
    });
  }

  // Calculate distance between two points
  distance(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
  }

  // Ghost AI - get target tile based on ghost personality
  getGhostTarget(ghost) {
    if (ghost.eaten) {
      // Return to ghost house
      return { x: this.ghostHouse.x, y: this.ghostHouse.y };
    }

    if (ghost.frightened) {
      // Random movement when frightened
      return {
        x: Math.floor(Math.random() * this.maze[0].length),
        y: Math.floor(Math.random() * this.maze.length),
      };
    }

    const px = this.pacman.x;
    const py = this.pacman.y;
    const pd = this.pacman.direction;

    switch (ghost.name) {
      case "blinky":
        // Red ghost: directly targets Pac-Man
        return { x: px, y: py };

      case "pinky":
        // Pink ghost: targets 4 tiles ahead of Pac-Man
        return { x: px + pd.x * 4, y: py + pd.y * 4 };

      case "inky":
        // Cyan ghost: complex targeting using Blinky's position
        const blinky = this.ghosts.find((g) => g.name === "blinky");
        if (blinky) {
          const ax = px + pd.x * 2;
          const ay = py + pd.y * 2;
          return { x: ax + (ax - blinky.x), y: ay + (ay - blinky.y) };
        }
        return { x: px, y: py };

      case "clyde":
        // Orange ghost: chases when far, scatters when close
        const dist = this.distance(ghost.x, ghost.y, px, py);
        if (dist > 8) {
          return { x: px, y: py };
        } else {
          // Scatter to bottom-left corner
          return { x: 0, y: this.maze.length - 1 };
        }

      default:
        return { x: px, y: py };
    }
  }

  // Move ghost using its AI
  moveGhost(ghost, now) {
    // Handle ghosts in the house - they need to exit
    if (ghost.inHouse) {
      // Check if it's time to release this ghost
      if (now >= ghost.releaseTime) {
        // Move ghost up to exit the house
        if (ghost.y > 10) {
          ghost.y--;
        } else if (ghost.x !== 13) {
          // Move to center then up
          ghost.x += ghost.x < 13 ? 1 : -1;
        } else {
          // Ghost is out!
          ghost.inHouse = false;
          ghost.y = 10;
          ghost.direction = { x: -1, y: 0 };
        }
      }
      return;
    }

    // Handle eaten ghosts returning home
    if (ghost.eaten) {
      // Target the ghost house entrance
      const homeX = 13;
      const homeY = 10;

      // Move towards home using simple pathfinding
      let bestDir = ghost.direction;
      let bestDist = Infinity;

      const dirs = [
        { x: 0, y: -1 },
        { x: 0, y: 1 },
        { x: -1, y: 0 },
        { x: 1, y: 0 },
      ];

      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        const nx = ghost.x + d.x;
        const ny = ghost.y + d.y;

        // Allow moving into ghost house when eaten
        if (this.canMove(nx, ny, true, true) || this.isGhostHouse(nx, ny)) {
          const dist = this.distance(nx, ny, homeX, homeY);
          if (dist < bestDist) {
            bestDist = dist;
            bestDir = d;
          }
        }
      }

      ghost.direction = bestDir;
      ghost.x += ghost.direction.x;
      ghost.y += ghost.direction.y;

      // Check if ghost reached home - respawn inside house
      if (ghost.x >= 12 && ghost.x <= 15 && ghost.y >= 11 && ghost.y <= 13) {
        ghost.eaten = false;
        ghost.frightened = false;
        ghost.inHouse = true;
        ghost.x = 13;
        ghost.y = 12;
        ghost.releaseTime = now + 2000; // Wait 2 seconds before leaving again
      }
      return;
    }

    // Get target based on ghost AI
    const target = this.getGhostTarget(ghost);

    // Get valid directions
    const validDirs = this.getValidDirs(ghost.x, ghost.y, ghost.direction);

    if (validDirs.length === 0) {
      // Force reverse if stuck
      ghost.direction = { x: -ghost.direction.x, y: -ghost.direction.y };
      return;
    }

    if (validDirs.length === 1) {
      // Only one choice
      ghost.direction = validDirs[0];
    } else {
      // Choose direction that gets closest to target
      let bestDir = validDirs[0];
      let bestDist = Infinity;

      for (let i = 0; i < validDirs.length; i++) {
        const d = validDirs[i];
        const nx = ghost.x + d.x;
        const ny = ghost.y + d.y;
        const dist = this.distance(nx, ny, target.x, target.y);

        // When frightened, choose FARTHEST from target (run away)
        if (ghost.frightened) {
          if (dist > bestDist) {
            bestDist = dist;
            bestDir = d;
          }
        } else {
          if (dist < bestDist) {
            bestDist = dist;
            bestDir = d;
          }
        }
      }

      ghost.direction = bestDir;
    }

    // Move ghost
    ghost.x += ghost.direction.x;
    ghost.y += ghost.direction.y;

    // Tunnel wrapping
    if (ghost.y === 13) {
      if (ghost.x < 0) ghost.x = this.maze[0].length - 1;
      if (ghost.x >= this.maze[0].length) ghost.x = 0;
    }
  }

  update() {
    const now = Date.now();

    // Handle input - queue the next direction
    if (this.keys["ArrowUp"]) this.pacman.nextDirection = { x: 0, y: -1 };
    if (this.keys["ArrowDown"]) this.pacman.nextDirection = { x: 0, y: 1 };
    if (this.keys["ArrowLeft"]) this.pacman.nextDirection = { x: -1, y: 0 };
    if (this.keys["ArrowRight"]) this.pacman.nextDirection = { x: 1, y: 0 };

    // Update frightened timer
    if (this.frightened) {
      if (now - this.frightenedTimer > this.frightenedDuration) {
        this.frightened = false;
        for (let i = 0; i < this.ghosts.length; i++) {
          if (!this.ghosts[i].eaten) {
            this.ghosts[i].frightened = false;
          }
        }
      }
    }

    // Move Pac-Man
    if (now - this.lastMove >= this.moveInterval) {
      this.lastMove = now;
      this.pacman.mouthOpen = !this.pacman.mouthOpen;

      // Try to move in queued direction first
      const nextX = this.pacman.x + this.pacman.nextDirection.x;
      const nextY = this.pacman.y + this.pacman.nextDirection.y;

      if (this.canMove(nextX, nextY, false, false)) {
        // Accept the queued direction
        this.pacman.direction = {
          x: this.pacman.nextDirection.x,
          y: this.pacman.nextDirection.y,
        };
        this.pacman.x = nextX;
        this.pacman.y = nextY;
      } else {
        // Try to continue in current direction
        const contX = this.pacman.x + this.pacman.direction.x;
        const contY = this.pacman.y + this.pacman.direction.y;
        if (this.canMove(contX, contY, false, false)) {
          this.pacman.x = contX;
          this.pacman.y = contY;
        }
      }

      // Tunnel wrapping for Pac-Man
      if (this.pacman.y === 13) {
        if (this.pacman.x < 0) this.pacman.x = this.maze[0].length - 1;
        if (this.pacman.x >= this.maze[0].length) this.pacman.x = 0;
      }

      // Eat dots
      const cell = this.maze[this.pacman.y]
        ? this.maze[this.pacman.y][this.pacman.x]
        : 0;
      if (cell === 1) {
        this.maze[this.pacman.y][this.pacman.x] = 2;
        this.score += 10;
        this.dotsRemaining--;
        this.updateScore();
        this.playSound("eat");
      } else if (cell === 3) {
        // Power pellet - make ghosts frightened!
        this.maze[this.pacman.y][this.pacman.x] = 2;
        this.score += 50;
        this.dotsRemaining--;
        this.updateScore();
        this.playSound("powerup");
        this.createSparkle(
          this.pacman.x * this.gridSize + this.gridSize / 2,
          this.pacman.y * this.gridSize + this.gridSize / 2,
          "#fbbf24"
        );

        this.frightened = true;
        this.frightenedTimer = now;
        this.ghostsEaten = 0;

        for (let i = 0; i < this.ghosts.length; i++) {
          if (!this.ghosts[i].eaten && !this.ghosts[i].inHouse) {
            this.ghosts[i].frightened = true;
            // Reverse direction when frightened
            this.ghosts[i].direction = {
              x: -this.ghosts[i].direction.x,
              y: -this.ghosts[i].direction.y,
            };
          }
        }
      }

      // Check win condition
      if (this.dotsRemaining <= 0) {
        this.level++;
        this.score += 500;
        this.updateScore();
        this.init();
        return;
      }
    }

    // Move ghosts
    if (now - this.lastGhostMove >= this.ghostMoveInterval) {
      this.lastGhostMove = now;

      for (let i = 0; i < this.ghosts.length; i++) {
        this.moveGhost(this.ghosts[i], now);
      }
    }

    // Check collisions with ghosts
    for (let i = 0; i < this.ghosts.length; i++) {
      const ghost = this.ghosts[i];
      if (
        ghost.x === this.pacman.x &&
        ghost.y === this.pacman.y &&
        !ghost.inHouse
      ) {
        if (ghost.frightened && !ghost.eaten) {
          // Eat the ghost!
          ghost.eaten = true;
          this.ghostsEaten++;
          const points = 200 * Math.pow(2, this.ghostsEaten - 1); // 200, 400, 800, 1600
          this.score += points;
          this.updateScore();

          // Sound and particles for eating ghost
          this.playSound("powerup");
          this.createExplosion(
            ghost.x * this.gridSize + this.gridSize / 2,
            ghost.y * this.gridSize + this.gridSize / 2,
            ghost.color,
            15
          );
          this.showScorePopup(
            ghost.x * this.gridSize + this.gridSize / 2,
            ghost.y * this.gridSize,
            points
          );
        } else if (!ghost.eaten) {
          // Pac-Man dies
          this.shake(); // Screen shake on death
          this.gameOver();
          return;
        }
      }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    const cellSize = Math.min(
      canvas.width / this.maze[0].length,
      canvas.height / this.maze.length
    );

    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw level indicator
    ctx.fillStyle = "#a78bfa";
    ctx.font = "12px sans-serif";
    ctx.fillText("Level " + this.level, 5, 12);

    // Draw maze
    for (let y = 0; y < this.maze.length; y++) {
      for (let x = 0; x < this.maze[0].length; x++) {
        const cell = this.maze[y][x];
        const px = x * cellSize;
        const py = y * cellSize;

        if (cell === 0) {
          ctx.fillStyle = "#1a1025";
          ctx.fillRect(px, py, cellSize, cellSize);
        } else if (cell === 1) {
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(px + cellSize / 2, py + cellSize / 2, 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (cell === 3) {
          // Power pellet - blink effect
          const blink = Math.floor(Date.now() / 200) % 2;
          if (blink) {
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(px + cellSize / 2, py + cellSize / 2, 5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // Draw Pac-Man
    const pacX = this.pacman.x * cellSize + cellSize / 2;
    const pacY = this.pacman.y * cellSize + cellSize / 2;
    ctx.fillStyle = "#ffff00";
    ctx.beginPath();
    const mouthAngle = this.pacman.mouthOpen ? 0.3 : 0.05;
    let startAngle = mouthAngle;
    let endAngle = Math.PI * 2 - mouthAngle;

    if (this.pacman.direction.x === -1) {
      startAngle += Math.PI;
      endAngle += Math.PI;
    }
    if (this.pacman.direction.y === -1) {
      startAngle -= Math.PI / 2;
      endAngle -= Math.PI / 2;
    }
    if (this.pacman.direction.y === 1) {
      startAngle += Math.PI / 2;
      endAngle += Math.PI / 2;
    }

    ctx.arc(pacX, pacY, cellSize / 2 - 2, startAngle, endAngle);
    ctx.lineTo(pacX, pacY);
    ctx.fill();

    // Draw ghosts
    for (let i = 0; i < this.ghosts.length; i++) {
      const ghost = this.ghosts[i];
      if (ghost.inHouse) continue; // Don't draw ghosts still in house

      const gx = ghost.x * cellSize + cellSize / 2;
      const gy = ghost.y * cellSize + cellSize / 2;

      // Frightened ghosts are blue, eaten ghosts are just eyes
      if (ghost.eaten) {
        // Just draw eyes returning home
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(gx - 3, gy - 2, 3, 0, Math.PI * 2);
        ctx.arc(gx + 3, gy - 2, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#00f";
        ctx.beginPath();
        ctx.arc(
          gx - 3 + ghost.direction.x,
          gy - 2 + ghost.direction.y,
          1.5,
          0,
          Math.PI * 2
        );
        ctx.arc(
          gx + 3 + ghost.direction.x,
          gy - 2 + ghost.direction.y,
          1.5,
          0,
          Math.PI * 2
        );
        ctx.fill();
      } else {
        // Ghost body
        if (ghost.frightened) {
          // Blink white when frightened timer is running out
          const timeLeft =
            this.frightenedDuration - (Date.now() - this.frightenedTimer);
          if (timeLeft < 2000 && Math.floor(Date.now() / 200) % 2) {
            ctx.fillStyle = "#fff";
          } else {
            ctx.fillStyle = "#2222ff";
          }
        } else {
          ctx.fillStyle = ghost.color;
        }

        ctx.beginPath();
        ctx.arc(gx, gy - 2, cellSize / 2 - 2, Math.PI, 0);
        ctx.lineTo(gx + cellSize / 2 - 2, gy + cellSize / 2 - 2);
        ctx.lineTo(gx + cellSize / 4, gy + cellSize / 3);
        ctx.lineTo(gx, gy + cellSize / 2 - 2);
        ctx.lineTo(gx - cellSize / 4, gy + cellSize / 3);
        ctx.lineTo(gx - cellSize / 2 + 2, gy + cellSize / 2 - 2);
        ctx.fill();

        // Eyes
        if (ghost.frightened) {
          // Frightened face
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(gx - 3, gy - 3, 2, 0, Math.PI * 2);
          ctx.arc(gx + 3, gy - 3, 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Normal eyes that look in direction of movement
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(gx - 3, gy - 2, 3, 0, Math.PI * 2);
          ctx.arc(gx + 3, gy - 2, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#00f";
          ctx.beginPath();
          ctx.arc(
            gx - 3 + ghost.direction.x * 1.5,
            gy - 2 + ghost.direction.y * 1.5,
            1.5,
            0,
            Math.PI * 2
          );
          ctx.arc(
            gx + 3 + ghost.direction.x * 1.5,
            gy - 2 + ghost.direction.y * 1.5,
            1.5,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
      }
    }

    // Draw frightened indicator
    if (this.frightened) {
      const timeLeft = Math.ceil(
        (this.frightenedDuration - (Date.now() - this.frightenedTimer)) / 1000
      );
      ctx.fillStyle = "#2222ff";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText("POWER: " + timeLeft + "s", canvas.width - 80, 12);
    }
  }
}

// Tetris Game
class TetrisGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "tetris";
  }

  init() {
    this.cols = 10;
    this.rows = 20;
    this.cellSize = 18;
    this.board = Array(this.rows)
      .fill(null)
      .map(() => Array(this.cols).fill(0));
    this.lastDrop = 0;
    this.dropInterval = 500;
    this.lastMove = 0;
    this.moveInterval = 100;

    this.pieces = [
      { shape: [[1, 1, 1, 1]], color: "#00ffff" },
      {
        shape: [
          [1, 1],
          [1, 1],
        ],
        color: "#ffff00",
      },
      {
        shape: [
          [0, 1, 0],
          [1, 1, 1],
        ],
        color: "#a855f7",
      },
      {
        shape: [
          [1, 0],
          [1, 0],
          [1, 1],
        ],
        color: "#f97316",
      },
      {
        shape: [
          [0, 1],
          [0, 1],
          [1, 1],
        ],
        color: "#3b82f6",
      },
      {
        shape: [
          [1, 1, 0],
          [0, 1, 1],
        ],
        color: "#22c55e",
      },
      {
        shape: [
          [0, 1, 1],
          [1, 1, 0],
        ],
        color: "#ef4444",
      },
    ];

    this.spawnPiece();
  }

  spawnPiece() {
    const piece = this.pieces[Math.floor(Math.random() * this.pieces.length)];
    this.current = {
      shape: piece.shape.map((row) => [...row]),
      color: piece.color,
      x: Math.floor(this.cols / 2) - Math.floor(piece.shape[0].length / 2),
      y: 0,
    };

    if (this.collides(this.current.x, this.current.y, this.current.shape)) {
      this.gameOver();
    }
  }

  collides(x, y, shape) {
    for (let row = 0; row < shape.length; row++) {
      for (let col = 0; col < shape[row].length; col++) {
        if (shape[row][col]) {
          const newX = x + col;
          const newY = y + row;
          if (newX < 0 || newX >= this.cols || newY >= this.rows) return true;
          if (newY >= 0 && this.board[newY][newX]) return true;
        }
      }
    }
    return false;
  }

  rotate(shape) {
    const rows = shape.length;
    const cols = shape[0].length;
    const rotated = [];
    for (let c = 0; c < cols; c++) {
      rotated.push([]);
      for (let r = rows - 1; r >= 0; r--) {
        rotated[c].push(shape[r][c]);
      }
    }
    return rotated;
  }

  lock() {
    for (let row = 0; row < this.current.shape.length; row++) {
      for (let col = 0; col < this.current.shape[row].length; col++) {
        if (this.current.shape[row][col]) {
          const y = this.current.y + row;
          const x = this.current.x + col;
          if (y >= 0) this.board[y][x] = this.current.color;
        }
      }
    }
    this.clearLines();
    this.spawnPiece();
  }

  clearLines() {
    let linesCleared = 0;
    for (let row = this.rows - 1; row >= 0; row--) {
      if (this.board[row].every((cell) => cell)) {
        this.board.splice(row, 1);
        this.board.unshift(Array(this.cols).fill(0));
        linesCleared++;
        row++;
      }
    }
    if (linesCleared > 0) {
      this.score += linesCleared * linesCleared * 100;
      this.updateScore();
      this.dropInterval = Math.max(100, this.dropInterval - 10);
    }
  }

  update() {
    const now = Date.now();

    // Handle input
    if (now - this.lastMove > this.moveInterval) {
      if (
        this.keys["ArrowLeft"] &&
        !this.collides(this.current.x - 1, this.current.y, this.current.shape)
      ) {
        this.current.x--;
        this.lastMove = now;
      }
      if (
        this.keys["ArrowRight"] &&
        !this.collides(this.current.x + 1, this.current.y, this.current.shape)
      ) {
        this.current.x++;
        this.lastMove = now;
      }
      if (this.keys["ArrowUp"]) {
        const rotated = this.rotate(this.current.shape);
        if (!this.collides(this.current.x, this.current.y, rotated)) {
          this.current.shape = rotated;
        }
        this.lastMove = now;
      }
      if (this.keys["ArrowDown"]) {
        if (
          !this.collides(this.current.x, this.current.y + 1, this.current.shape)
        ) {
          this.current.y++;
          this.score += 1;
          this.updateScore();
        }
        this.lastMove = now;
      }
    }

    // Auto drop
    if (now - this.lastDrop > this.dropInterval) {
      if (
        !this.collides(this.current.x, this.current.y + 1, this.current.shape)
      ) {
        this.current.y++;
      } else {
        this.lock();
      }
      this.lastDrop = now;
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const offsetX = (canvas.width - this.cols * this.cellSize) / 2;
    const offsetY = (canvas.height - this.rows * this.cellSize) / 2;

    // Draw board border
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      offsetX - 2,
      offsetY - 2,
      this.cols * this.cellSize + 4,
      this.rows * this.cellSize + 4
    );

    // Draw board
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = offsetX + col * this.cellSize;
        const y = offsetY + row * this.cellSize;

        if (this.board[row][col]) {
          ctx.fillStyle = this.board[row][col];
          ctx.fillRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
        } else {
          ctx.fillStyle = "#1a1025";
          ctx.fillRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
        }
      }
    }

    // Draw current piece
    if (this.current) {
      ctx.fillStyle = this.current.color;
      for (let row = 0; row < this.current.shape.length; row++) {
        for (let col = 0; col < this.current.shape[row].length; col++) {
          if (this.current.shape[row][col]) {
            const x = offsetX + (this.current.x + col) * this.cellSize;
            const y = offsetY + (this.current.y + row) * this.cellSize;
            ctx.fillRect(x + 1, y + 1, this.cellSize - 2, this.cellSize - 2);
          }
        }
      }
    }
  }
}

// Flappy Bird Game
class FlappyGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "flappy";
  }

  init() {
    this.bird = { x: 100, y: this.canvas.height / 2, velocity: 0, radius: 12 };
    this.gravity = 0.4;
    this.jumpForce = -7;
    this.pipes = [];
    this.pipeWidth = 50;
    this.pipeGap = 160;
    this.pipeSpeed = 3;
    this.lastPipe = 0;
    this.pipeInterval = 1800;
    this.jumped = false;
  }

  update() {
    // Jump
    if ((this.keys["action"] || this.keys["ArrowUp"]) && !this.jumped) {
      this.bird.velocity = this.jumpForce;
      this.jumped = true;
      this.playSound("jump");
      this.createTrail(this.bird.x, this.bird.y, "#fbbf24");
    }
    if (!this.keys["action"] && !this.keys["ArrowUp"]) {
      this.jumped = false;
    }

    // Physics
    this.bird.velocity += this.gravity;
    this.bird.velocity = Math.max(-10, Math.min(10, this.bird.velocity)); // Cap velocity
    this.bird.y += this.bird.velocity;

    // Boundaries - clamp bird, only game over if completely off screen
    if (this.bird.y < this.bird.radius) {
      this.bird.y = this.bird.radius;
      this.bird.velocity = 0;
    }
    if (this.bird.y > this.canvas.height - this.bird.radius) {
      this.gameOver();
      return;
    }

    // Spawn pipes
    const now = Date.now();
    if (now - this.lastPipe > this.pipeInterval) {
      const gapY =
        Math.random() * (this.canvas.height - this.pipeGap - 120) + 60;
      this.pipes.push({ x: this.canvas.width, gapY, passed: false });
      this.lastPipe = now;
    }

    // Update pipes
    var hitPipe = false;
    this.pipes = this.pipes.filter((pipe) => {
      if (hitPipe) return true;

      pipe.x -= this.pipeSpeed;

      // Collision detection - circle vs rectangle
      const birdCenterX = this.bird.x;
      const birdCenterY = this.bird.y;
      const r = this.bird.radius;

      // Check if bird overlaps with pipe horizontally
      if (
        birdCenterX + r > pipe.x &&
        birdCenterX - r < pipe.x + this.pipeWidth
      ) {
        // Check if bird is in the gap
        if (
          birdCenterY - r < pipe.gapY ||
          birdCenterY + r > pipe.gapY + this.pipeGap
        ) {
          hitPipe = true;
          return true;
        }
      }

      // Score
      if (!pipe.passed && pipe.x + this.pipeWidth < birdCenterX - r) {
        pipe.passed = true;
        this.score += 1;
        this.updateScore();
        this.playSound("score");
        this.createSparkle(this.bird.x, this.bird.y, "#22c55e");
        this.showScorePopup(this.bird.x, this.bird.y - 20, "1");
      }

      return pipe.x > -this.pipeWidth;
    });

    if (hitPipe) {
      this.gameOver();
    }
  }

  draw() {
    const { ctx, canvas } = this;

    // Sky gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#1a1025");
    gradient.addColorStop(1, "#0a0612");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw pipes
    ctx.fillStyle = "#7c3aed";
    this.pipes.forEach((pipe) => {
      // Top pipe
      ctx.fillRect(pipe.x, 0, this.pipeWidth, pipe.gapY);
      // Bottom pipe
      ctx.fillRect(
        pipe.x,
        pipe.gapY + this.pipeGap,
        this.pipeWidth,
        canvas.height
      );
    });

    // Draw bird
    ctx.fillStyle = "#f97316";
    ctx.beginPath();
    ctx.arc(this.bird.x, this.bird.y, this.bird.radius, 0, Math.PI * 2);
    ctx.fill();

    // Eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.bird.x + 4, this.bird.y - 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(this.bird.x + 5, this.bird.y - 2, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Crossy Road Game
class CrossyGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "crossy";
  }

  init() {
    this.player = {
      x: this.canvas.width / 2,
      y: this.canvas.height - 40,
      size: 30,
    };
    this.lanes = [];
    this.laneHeight = 40;
    this.moveDelay = 0;

    // Create lanes
    for (
      let i = 0;
      i < Math.ceil(this.canvas.height / this.laneHeight) + 2;
      i++
    ) {
      this.lanes.push(this.createLane(i));
    }
  }

  createLane(index) {
    const types = ["grass", "road", "road", "water", "road", "grass"];
    const type = types[index % types.length];
    const lane = {
      y: this.canvas.height - index * this.laneHeight - this.laneHeight,
      type,
      obstacles: [],
      direction: Math.random() > 0.5 ? 1 : -1,
      speed: 1 + Math.random() * 2,
    };

    if (type === "road" || type === "water") {
      const count = Math.floor(Math.random() * 3) + 2;
      for (let i = 0; i < count; i++) {
        lane.obstacles.push({
          x: Math.random() * this.canvas.width,
          width: 40 + Math.random() * 40,
        });
      }
    }

    return lane;
  }

  update() {
    const now = Date.now();

    // Player movement
    if (now - this.moveDelay > 150) {
      if (this.keys["ArrowUp"]) {
        this.player.y -= this.laneHeight;
        this.score += 1;
        this.updateScore();
        this.moveDelay = now;
      }
      if (this.keys["ArrowDown"]) {
        this.player.y += this.laneHeight;
        this.moveDelay = now;
      }
      if (this.keys["ArrowLeft"]) {
        this.player.x -= this.player.size;
        this.moveDelay = now;
      }
      if (this.keys["ArrowRight"]) {
        this.player.x += this.player.size;
        this.moveDelay = now;
      }
    }

    // Keep player in bounds
    this.player.x = Math.max(
      0,
      Math.min(this.canvas.width - this.player.size, this.player.x)
    );
    this.player.y = Math.max(
      0,
      Math.min(this.canvas.height - this.player.size, this.player.y)
    );

    // Update obstacles
    this.lanes.forEach((lane) => {
      lane.obstacles.forEach((obs) => {
        obs.x += lane.direction * lane.speed;
        if (obs.x > this.canvas.width) obs.x = -obs.width;
        if (obs.x < -obs.width) obs.x = this.canvas.width;
      });
    });

    // Collision detection
    const playerLane = this.lanes.find(
      (lane) =>
        this.player.y >= lane.y && this.player.y < lane.y + this.laneHeight
    );

    if (playerLane) {
      if (playerLane.type === "road") {
        for (const obs of playerLane.obstacles) {
          if (
            this.player.x < obs.x + obs.width &&
            this.player.x + this.player.size > obs.x
          ) {
            this.gameOver();
            return;
          }
        }
      }
      if (playerLane.type === "water") {
        let onLog = false;
        for (const obs of playerLane.obstacles) {
          if (
            this.player.x >= obs.x &&
            this.player.x + this.player.size <= obs.x + obs.width
          ) {
            onLog = true;
            this.player.x += playerLane.direction * playerLane.speed;
          }
        }
        if (!onLog) {
          this.gameOver();
          return;
        }
      }
    }

    // Scroll world when player reaches top third
    if (this.player.y < this.canvas.height / 3) {
      const scroll = this.laneHeight / 4;
      this.player.y += scroll;
      this.lanes.forEach((lane) => (lane.y += scroll));

      // Remove lanes that are off screen and add new ones
      this.lanes = this.lanes.filter(
        (lane) => lane.y < this.canvas.height + this.laneHeight
      );
      while (
        this.lanes.length <
        Math.ceil(this.canvas.height / this.laneHeight) + 2
      ) {
        const topY = Math.min(...this.lanes.map((l) => l.y));
        const newLane = this.createLane(
          Math.floor(Math.abs(topY - this.canvas.height) / this.laneHeight)
        );
        newLane.y = topY - this.laneHeight;
        this.lanes.push(newLane);
      }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw lanes
    this.lanes.forEach((lane) => {
      if (lane.type === "grass") {
        ctx.fillStyle = "#166534";
      } else if (lane.type === "road") {
        ctx.fillStyle = "#374151";
      } else if (lane.type === "water") {
        ctx.fillStyle = "#1e40af";
      }
      ctx.fillRect(0, lane.y, canvas.width, this.laneHeight);

      // Draw lane markings for road
      if (lane.type === "road") {
        ctx.strokeStyle = "#fbbf24";
        ctx.setLineDash([20, 20]);
        ctx.beginPath();
        ctx.moveTo(0, lane.y + this.laneHeight / 2);
        ctx.lineTo(canvas.width, lane.y + this.laneHeight / 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw obstacles
      lane.obstacles.forEach((obs) => {
        if (lane.type === "road") {
          ctx.fillStyle = "#ef4444";
          ctx.fillRect(obs.x, lane.y + 5, obs.width, this.laneHeight - 10);
          // Wheels
          ctx.fillStyle = "#000";
          ctx.beginPath();
          ctx.arc(obs.x + 8, lane.y + this.laneHeight - 5, 5, 0, Math.PI * 2);
          ctx.arc(
            obs.x + obs.width - 8,
            lane.y + this.laneHeight - 5,
            5,
            0,
            Math.PI * 2
          );
          ctx.fill();
        } else if (lane.type === "water") {
          ctx.fillStyle = "#854d0e";
          ctx.fillRect(obs.x, lane.y + 8, obs.width, this.laneHeight - 16);
        }
      });
    });

    // Draw player (chicken)
    ctx.fillStyle = "#f97316";
    ctx.beginPath();
    ctx.arc(
      this.player.x + this.player.size / 2,
      this.player.y + this.player.size / 2,
      this.player.size / 2,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // Beak
    ctx.fillStyle = "#fbbf24";
    ctx.beginPath();
    ctx.moveTo(
      this.player.x + this.player.size / 2 + 8,
      this.player.y + this.player.size / 2
    );
    ctx.lineTo(
      this.player.x + this.player.size / 2 + 18,
      this.player.y + this.player.size / 2 - 3
    );
    ctx.lineTo(
      this.player.x + this.player.size / 2 + 18,
      this.player.y + this.player.size / 2 + 3
    );
    ctx.fill();

    // Eyes
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(
      this.player.x + this.player.size / 2 + 3,
      this.player.y + this.player.size / 2 - 5,
      4,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(
      this.player.x + this.player.size / 2 + 4,
      this.player.y + this.player.size / 2 - 5,
      2,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}

// Doodle Jump Game
class DoodleJumpGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "doodlejump";
  }

  init() {
    this.player = {
      x: this.canvas.width / 2 - 20,
      y: this.canvas.height - 100,
      width: 40,
      height: 40,
      vy: -12,
      vx: 0,
    };

    this.platforms = [];
    this.scrollOffset = 0;
    this.lastScoreHeight = 0; // Track height for scoring

    // Create initial platforms
    for (let i = 0; i < 8; i++) {
      this.platforms.push({
        x: Math.random() * (this.canvas.width - 70),
        y: this.canvas.height - i * 70 - 50,
        width: 70,
        height: 15,
        type: i === 0 ? "normal" : Math.random() > 0.85 ? "moving" : "normal",
        direction: Math.random() > 0.5 ? 1 : -1,
      });
    }
  }

  update() {
    // Horizontal movement
    if (this.keys["ArrowLeft"]) this.player.vx = -6;
    else if (this.keys["ArrowRight"]) this.player.vx = 6;
    else this.player.vx *= 0.9;

    this.player.x += this.player.vx;

    // Wrap around screen
    if (this.player.x < -this.player.width) this.player.x = this.canvas.width;
    if (this.player.x > this.canvas.width) this.player.x = -this.player.width;

    // Gravity
    this.player.vy += 0.4;
    this.player.y += this.player.vy;

    // Move moving platforms
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      if (p.type === "moving") {
        p.x += p.direction * 2;
        if (p.x <= 0 || p.x >= this.canvas.width - p.width) {
          p.direction *= -1;
        }
      }
    }

    // Platform collision (only when falling)
    if (this.player.vy > 0) {
      for (let i = 0; i < this.platforms.length; i++) {
        const p = this.platforms[i];
        if (
          this.player.x + this.player.width > p.x &&
          this.player.x < p.x + p.width &&
          this.player.y + this.player.height >= p.y &&
          this.player.y + this.player.height <= p.y + p.height + 10
        ) {
          this.player.vy = -14;
        }
      }
    }

    // Scroll screen when player is in upper half
    if (this.player.y < this.canvas.height / 2) {
      const scroll = this.canvas.height / 2 - this.player.y;
      this.player.y = this.canvas.height / 2;
      this.scrollOffset += scroll;

      // Score based on height: every 100 height = 10 points
      const newScoreHeight = Math.floor(this.scrollOffset / 100);
      if (newScoreHeight > this.lastScoreHeight) {
        this.score += (newScoreHeight - this.lastScoreHeight) * 10;
        this.lastScoreHeight = newScoreHeight;
        this.updateScore();
      }

      // Move platforms down
      for (let i = 0; i < this.platforms.length; i++) {
        this.platforms[i].y += scroll;
      }

      // Remove platforms below screen and add new ones above
      this.platforms = this.platforms.filter(
        (p) => p.y < this.canvas.height + 50
      );

      while (this.platforms.length < 8) {
        const topY = Math.min.apply(
          null,
          this.platforms.map(function (p) {
            return p.y;
          })
        );
        this.platforms.push({
          x: Math.random() * (this.canvas.width - 70),
          y: topY - 70 - Math.random() * 30,
          width: 70,
          height: 15,
          type: Math.random() > 0.8 ? "moving" : "normal",
          direction: Math.random() > 0.5 ? 1 : -1,
        });
      }
    }

    // Game over if player falls below screen
    if (this.player.y > this.canvas.height + 50) {
      this.gameOver();
    }
  }

  draw() {
    const { ctx, canvas } = this;

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#1a1025");
    gradient.addColorStop(1, "#0a0612");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw platforms
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      ctx.fillStyle = p.type === "moving" ? "#f97316" : "#7c3aed";
      ctx.fillRect(p.x, p.y, p.width, p.height);
      // Platform highlight
      ctx.fillStyle = p.type === "moving" ? "#fb923c" : "#a78bfa";
      ctx.fillRect(p.x, p.y, p.width, 4);
    }

    // Draw player (doodle character)
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(
      this.player.x,
      this.player.y,
      this.player.width,
      this.player.height
    );

    // Eyes
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.player.x + 12, this.player.y + 12, 6, 0, Math.PI * 2);
    ctx.arc(this.player.x + 28, this.player.y + 12, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(this.player.x + 13, this.player.y + 12, 3, 0, Math.PI * 2);
    ctx.arc(this.player.x + 29, this.player.y + 12, 3, 0, Math.PI * 2);
    ctx.fill();

    // Feet
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(this.player.x + 5, this.player.y + this.player.height, 10, 5);
    ctx.fillRect(this.player.x + 25, this.player.y + this.player.height, 10, 5);

    // Height indicator
    ctx.fillStyle = "#a78bfa";
    ctx.font = "14px sans-serif";
    ctx.fillText("Height: " + Math.floor(this.scrollOffset), 10, 25);
  }
}

// Asteroids Game
class AsteroidsGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "asteroids";
  }

  init() {
    this.ship = {
      x: this.canvas.width / 2,
      y: this.canvas.height / 2,
      angle: -Math.PI / 2,
      vx: 0,
      vy: 0,
      radius: 15,
    };

    this.bullets = [];
    this.asteroids = [];
    this.lastShot = 0;
    this.shotCooldown = 200;

    // Spawn initial asteroids
    for (let i = 0; i < 5; i++) {
      this.spawnAsteroid(3);
    }
  }

  spawnAsteroid(size, x, y) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 2;
    this.asteroids.push({
      x: x !== undefined ? x : Math.random() * this.canvas.width,
      y: y !== undefined ? y : Math.random() * this.canvas.height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: size * 12,
      size: size,
    });
  }

  update() {
    const now = Date.now();

    // Ship rotation
    if (this.keys["ArrowLeft"]) this.ship.angle -= 0.08;
    if (this.keys["ArrowRight"]) this.ship.angle += 0.08;

    // Thrust
    if (this.keys["ArrowUp"]) {
      this.ship.vx += Math.cos(this.ship.angle) * 0.15;
      this.ship.vy += Math.sin(this.ship.angle) * 0.15;
    }

    // Friction
    this.ship.vx *= 0.99;
    this.ship.vy *= 0.99;

    // Move ship
    this.ship.x += this.ship.vx;
    this.ship.y += this.ship.vy;

    // Wrap around
    if (this.ship.x < 0) this.ship.x = this.canvas.width;
    if (this.ship.x > this.canvas.width) this.ship.x = 0;
    if (this.ship.y < 0) this.ship.y = this.canvas.height;
    if (this.ship.y > this.canvas.height) this.ship.y = 0;

    // Shooting
    if (
      (this.keys["action"] || this.keys["ArrowDown"]) &&
      now - this.lastShot > this.shotCooldown
    ) {
      this.bullets.push({
        x: this.ship.x + Math.cos(this.ship.angle) * 20,
        y: this.ship.y + Math.sin(this.ship.angle) * 20,
        vx: Math.cos(this.ship.angle) * 8,
        vy: Math.sin(this.ship.angle) * 8,
        life: 60,
      });
      this.lastShot = now;
    }

    // Update bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx;
      b.y += b.vy;
      b.life--;

      // Wrap around
      if (b.x < 0) b.x = this.canvas.width;
      if (b.x > this.canvas.width) b.x = 0;
      if (b.y < 0) b.y = this.canvas.height;
      if (b.y > this.canvas.height) b.y = 0;

      if (b.life <= 0) {
        this.bullets.splice(i, 1);
      }
    }

    // Update asteroids
    for (let i = 0; i < this.asteroids.length; i++) {
      const a = this.asteroids[i];
      a.x += a.vx;
      a.y += a.vy;

      // Wrap around
      if (a.x < -a.radius) a.x = this.canvas.width + a.radius;
      if (a.x > this.canvas.width + a.radius) a.x = -a.radius;
      if (a.y < -a.radius) a.y = this.canvas.height + a.radius;
      if (a.y > this.canvas.height + a.radius) a.y = -a.radius;
    }

    // Bullet-asteroid collision
    for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
      const b = this.bullets[bi];
      for (let ai = this.asteroids.length - 1; ai >= 0; ai--) {
        const a = this.asteroids[ai];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < a.radius) {
          this.bullets.splice(bi, 1);

          // Split asteroid
          if (a.size > 1) {
            this.spawnAsteroid(a.size - 1, a.x, a.y);
            this.spawnAsteroid(a.size - 1, a.x, a.y);
          }
          this.asteroids.splice(ai, 1);

          this.score += (4 - a.size) * 20;
          this.updateScore();
          break;
        }
      }
    }

    // Ship-asteroid collision
    for (let i = 0; i < this.asteroids.length; i++) {
      const a = this.asteroids[i];
      const dx = this.ship.x - a.x;
      const dy = this.ship.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < a.radius + this.ship.radius) {
        this.gameOver();
        return;
      }
    }

    // Spawn more asteroids if all destroyed
    if (this.asteroids.length === 0) {
      this.score += 100;
      this.updateScore();
      for (let i = 0; i < 5 + Math.floor(this.score / 500); i++) {
        this.spawnAsteroid(3);
      }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw stars
    ctx.fillStyle = "#2d1f42";
    for (let i = 0; i < 50; i++) {
      const x = (i * 127) % canvas.width;
      const y = (i * 311) % canvas.height;
      ctx.fillRect(x, y, 2, 2);
    }

    // Draw ship
    ctx.save();
    ctx.translate(this.ship.x, this.ship.y);
    ctx.rotate(this.ship.angle);

    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-15, -12);
    ctx.lineTo(-10, 0);
    ctx.lineTo(-15, 12);
    ctx.closePath();
    ctx.fill();

    // Thrust flame
    if (this.keys["ArrowUp"]) {
      ctx.fillStyle = "#f97316";
      ctx.beginPath();
      ctx.moveTo(-10, -5);
      ctx.lineTo(-25, 0);
      ctx.lineTo(-10, 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Draw bullets
    ctx.fillStyle = "#a78bfa";
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw asteroids
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    for (let i = 0; i < this.asteroids.length; i++) {
      const a = this.asteroids[i];
      ctx.beginPath();
      for (let j = 0; j < 8; j++) {
        const angle = (j / 8) * Math.PI * 2;
        const r = a.radius * (0.8 + 0.2 * Math.sin(j * 3));
        const x = a.x + Math.cos(angle) * r;
        const y = a.y + Math.sin(angle) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
}

// Galaga Game
class GalagaGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "galaga";
  }

  init() {
    this.player = {
      x: this.canvas.width / 2 - 20,
      y: this.canvas.height - 60,
      width: 40,
      height: 30,
    };

    this.bullets = [];
    this.enemies = [];
    this.enemyBullets = [];
    this.lastShot = 0;
    this.shotCooldown = 250;
    this.wave = 1;
    this.enemyFormationTimer = 0;

    this.spawnWave();
  }

  spawnWave() {
    this.enemies = [];
    const rows = Math.min(4, 2 + Math.floor(this.wave / 2));
    const cols = Math.min(8, 5 + Math.floor(this.wave / 3));

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.enemies.push({
          x: c * 50 + 80,
          y: r * 40 + 50,
          width: 35,
          height: 25,
          type: r === 0 ? "boss" : "grunt",
          hp: r === 0 ? 2 : 1,
          offsetX: 0,
          attacking: false,
          attackY: 0,
        });
      }
    }
  }

  update() {
    const now = Date.now();

    // Player movement
    if (this.keys["ArrowLeft"]) this.player.x -= 6;
    if (this.keys["ArrowRight"]) this.player.x += 6;
    this.player.x = Math.max(
      0,
      Math.min(this.canvas.width - this.player.width, this.player.x)
    );

    // Shooting
    if (
      (this.keys["action"] || this.keys["ArrowUp"]) &&
      now - this.lastShot > this.shotCooldown
    ) {
      this.bullets.push({
        x: this.player.x + this.player.width / 2,
        y: this.player.y,
        width: 4,
        height: 12,
      });
      this.lastShot = now;
    }

    // Update bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      this.bullets[i].y -= 10;
      if (this.bullets[i].y < 0) {
        this.bullets.splice(i, 1);
      }
    }

    // Enemy formation movement
    this.enemyFormationTimer++;
    const formationOffset = Math.sin(this.enemyFormationTimer * 0.02) * 30;

    // Update enemies
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.attacking) {
        e.offsetX = formationOffset;
      } else {
        // Attacking enemy swoops down
        e.attackY += 4;
        e.x += Math.sin(e.attackY * 0.1) * 3;
        if (e.attackY > this.canvas.height + 50) {
          e.attacking = false;
          e.attackY = 0;
          e.y = 50;
        }
      }

      // Random attack
      if (!e.attacking && Math.random() < 0.001 * this.wave) {
        e.attacking = true;
        e.attackY = e.y;
      }

      // Enemy shooting
      if (Math.random() < 0.002 * this.wave) {
        this.enemyBullets.push({
          x: e.x + e.offsetX + e.width / 2,
          y: e.attacking ? e.attackY + e.height : e.y + e.height,
        });
      }
    }

    // Update enemy bullets
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      this.enemyBullets[i].y += 6;
      if (this.enemyBullets[i].y > this.canvas.height) {
        this.enemyBullets.splice(i, 1);
      }
    }

    // Bullet-enemy collision
    for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
      const b = this.bullets[bi];
      for (let ei = this.enemies.length - 1; ei >= 0; ei--) {
        const e = this.enemies[ei];
        const ex = e.x + e.offsetX;
        const ey = e.attacking ? e.attackY : e.y;

        if (b.x > ex && b.x < ex + e.width && b.y > ey && b.y < ey + e.height) {
          this.bullets.splice(bi, 1);
          e.hp--;

          if (e.hp <= 0) {
            this.score += e.type === "boss" ? 50 : 20;
            this.updateScore();
            this.enemies.splice(ei, 1);
          }
          break;
        }
      }
    }

    // Enemy bullet-player collision
    for (let i = 0; i < this.enemyBullets.length; i++) {
      const b = this.enemyBullets[i];
      if (
        b.x > this.player.x &&
        b.x < this.player.x + this.player.width &&
        b.y > this.player.y &&
        b.y < this.player.y + this.player.height
      ) {
        this.gameOver();
        return;
      }
    }

    // Enemy-player collision
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.attacking) {
        const ex = e.x + e.offsetX;
        if (
          ex + e.width > this.player.x &&
          ex < this.player.x + this.player.width &&
          e.attackY + e.height > this.player.y &&
          e.attackY < this.player.y + this.player.height
        ) {
          this.gameOver();
          return;
        }
      }
    }

    // Next wave
    if (this.enemies.length === 0) {
      this.wave++;
      this.score += 100;
      this.updateScore();
      this.spawnWave();
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw stars
    ctx.fillStyle = "#2d1f42";
    for (let i = 0; i < 30; i++) {
      const x = (i * 127 + this.enemyFormationTimer * 0.5) % canvas.width;
      const y = (i * 311 + this.enemyFormationTimer * 0.3) % canvas.height;
      ctx.fillRect(x, y, 2, 2);
    }

    // Wave indicator
    ctx.fillStyle = "#a78bfa";
    ctx.font = "14px sans-serif";
    ctx.fillText("Wave: " + this.wave, 10, 25);

    // Draw player ship
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(this.player.x + this.player.width / 2, this.player.y);
    ctx.lineTo(this.player.x, this.player.y + this.player.height);
    ctx.lineTo(
      this.player.x + this.player.width,
      this.player.y + this.player.height
    );
    ctx.closePath();
    ctx.fill();

    // Ship detail
    ctx.fillStyle = "#a78bfa";
    ctx.fillRect(
      this.player.x + this.player.width / 2 - 3,
      this.player.y + 5,
      6,
      15
    );

    // Draw bullets
    ctx.fillStyle = "#a78bfa";
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      ctx.fillRect(b.x - b.width / 2, b.y, b.width, b.height);
    }

    // Draw enemies
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const ex = e.x + e.offsetX;
      const ey = e.attacking ? e.attackY : e.y;

      ctx.fillStyle = e.type === "boss" ? "#f97316" : "#ef4444";

      // Bug-like enemy shape
      ctx.beginPath();
      ctx.ellipse(
        ex + e.width / 2,
        ey + e.height / 2,
        e.width / 2,
        e.height / 2,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();

      // Eyes
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(ex + e.width / 3, ey + e.height / 3, 4, 0, Math.PI * 2);
      ctx.arc(ex + (e.width * 2) / 3, ey + e.height / 3, 4, 0, Math.PI * 2);
      ctx.fill();

      // Wings for boss
      if (e.type === "boss") {
        ctx.fillStyle = "#fb923c";
        ctx.beginPath();
        ctx.ellipse(ex - 5, ey + e.height / 2, 8, 12, 0, 0, Math.PI * 2);
        ctx.ellipse(
          ex + e.width + 5,
          ey + e.height / 2,
          8,
          12,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    // Draw enemy bullets
    ctx.fillStyle = "#f97316";
    for (let i = 0; i < this.enemyBullets.length; i++) {
      const b = this.enemyBullets[i];
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Centipede Game
class CentipedeGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "centipede";
  }

  init() {
    this.player = {
      x: this.canvas.width / 2 - 15,
      y: this.canvas.height - 40,
      width: 30,
      height: 20,
    };

    this.bullets = [];
    this.mushrooms = [];
    this.centipede = [];
    this.lastShot = 0;
    this.shotCooldown = 150;

    // Create mushrooms
    for (let i = 0; i < 30; i++) {
      this.mushrooms.push({
        x: Math.floor(Math.random() * 20) * 30,
        y: Math.floor(Math.random() * 12) * 30 + 60,
        hp: 4,
      });
    }

    // Create centipede
    for (let i = 0; i < 10; i++) {
      this.centipede.push({
        x: this.canvas.width - i * 25,
        y: 30,
        direction: -1,
        isHead: i === 0,
      });
    }
  }

  update() {
    const now = Date.now();

    // Player movement (confined to bottom area)
    if (this.keys["ArrowLeft"]) this.player.x -= 5;
    if (this.keys["ArrowRight"]) this.player.x += 5;
    if (this.keys["ArrowUp"]) this.player.y -= 5;
    if (this.keys["ArrowDown"]) this.player.y += 5;

    this.player.x = Math.max(
      0,
      Math.min(this.canvas.width - this.player.width, this.player.x)
    );
    this.player.y = Math.max(
      this.canvas.height - 120,
      Math.min(this.canvas.height - this.player.height, this.player.y)
    );

    // Shooting
    if (this.keys["action"] && now - this.lastShot > this.shotCooldown) {
      this.bullets.push({
        x: this.player.x + this.player.width / 2,
        y: this.player.y,
      });
      this.lastShot = now;
    }

    // Update bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      this.bullets[i].y -= 12;
      if (this.bullets[i].y < 0) {
        this.bullets.splice(i, 1);
        continue;
      }

      // Check mushroom collision
      for (let j = this.mushrooms.length - 1; j >= 0; j--) {
        const m = this.mushrooms[j];
        if (
          this.bullets[i] &&
          this.bullets[i].x > m.x &&
          this.bullets[i].x < m.x + 25 &&
          this.bullets[i].y > m.y &&
          this.bullets[i].y < m.y + 25
        ) {
          m.hp--;
          this.bullets.splice(i, 1);
          if (m.hp <= 0) {
            this.mushrooms.splice(j, 1);
            this.score += 5;
            this.updateScore();
          }
          break;
        }
      }
    }

    // Update centipede
    for (let i = 0; i < this.centipede.length; i++) {
      const seg = this.centipede[i];
      seg.x += seg.direction * 2;

      // Check wall or mushroom collision
      let shouldTurn = seg.x <= 0 || seg.x >= this.canvas.width - 20;

      if (!shouldTurn) {
        for (let j = 0; j < this.mushrooms.length; j++) {
          const m = this.mushrooms[j];
          if (
            Math.abs(seg.y - m.y) < 20 &&
            seg.x + 20 > m.x &&
            seg.x < m.x + 25
          ) {
            shouldTurn = true;
            break;
          }
        }
      }

      if (shouldTurn) {
        seg.direction *= -1;
        seg.y += 25;

        if (seg.y >= this.canvas.height - 30) {
          seg.y = 30;
        }
      }

      // Check bullet collision
      for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
        const b = this.bullets[bi];
        if (
          b.x > seg.x &&
          b.x < seg.x + 20 &&
          b.y > seg.y &&
          b.y < seg.y + 20
        ) {
          this.bullets.splice(bi, 1);

          // Create mushroom where segment died
          this.mushrooms.push({
            x: Math.floor(seg.x / 30) * 30,
            y: Math.floor(seg.y / 30) * 30,
            hp: 4,
          });

          this.centipede.splice(i, 1);
          this.score += seg.isHead ? 100 : 10;
          this.updateScore();
          break;
        }
      }

      // Check player collision
      if (
        seg.x + 20 > this.player.x &&
        seg.x < this.player.x + this.player.width &&
        seg.y + 20 > this.player.y &&
        seg.y < this.player.y + this.player.height
      ) {
        this.gameOver();
        return;
      }
    }

    // Spawn new centipede if all dead
    if (this.centipede.length === 0) {
      this.score += 200;
      this.updateScore();
      for (let i = 0; i < 10; i++) {
        this.centipede.push({
          x: this.canvas.width - i * 25,
          y: 30,
          direction: -1,
          isHead: i === 0,
        });
      }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw mushrooms
    for (let i = 0; i < this.mushrooms.length; i++) {
      const m = this.mushrooms[i];
      const shade = 0.25 + (m.hp / 4) * 0.75;
      ctx.fillStyle = "rgba(249, 115, 22, " + shade + ")";

      // Mushroom cap
      ctx.beginPath();
      ctx.arc(m.x + 12, m.y + 10, 12, Math.PI, 0);
      ctx.fill();

      // Stem
      ctx.fillRect(m.x + 7, m.y + 10, 10, 12);
    }

    // Draw centipede
    for (let i = 0; i < this.centipede.length; i++) {
      const seg = this.centipede[i];
      ctx.fillStyle = seg.isHead ? "#22c55e" : "#16a34a";
      ctx.beginPath();
      ctx.arc(seg.x + 10, seg.y + 10, 10, 0, Math.PI * 2);
      ctx.fill();

      if (seg.isHead) {
        // Antennae
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(seg.x + 5, seg.y + 5);
        ctx.lineTo(seg.x, seg.y - 5);
        ctx.moveTo(seg.x + 15, seg.y + 5);
        ctx.lineTo(seg.x + 20, seg.y - 5);
        ctx.stroke();

        // Eyes
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(seg.x + 6, seg.y + 8, 3, 0, Math.PI * 2);
        ctx.arc(seg.x + 14, seg.y + 8, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw player
    ctx.fillStyle = "#7c3aed";
    ctx.fillRect(
      this.player.x,
      this.player.y,
      this.player.width,
      this.player.height
    );
    ctx.fillStyle = "#a78bfa";
    ctx.fillRect(
      this.player.x + this.player.width / 2 - 3,
      this.player.y - 8,
      6,
      8
    );

    // Draw bullets
    ctx.fillStyle = "#a78bfa";
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      ctx.fillRect(b.x - 2, b.y, 4, 10);
    }
  }
}

// Frogger Game
class FroggerGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "frogger";
  }

  init() {
    this.player = {
      x: this.canvas.width / 2 - 15,
      y: this.canvas.height - 45,
      size: 30,
    };

    this.lives = 3;
    this.lanes = [];
    this.moveDelay = 0;
    this.goals = [];
    this.goalsReached = 0;

    // Create goal slots at top
    for (let i = 0; i < 5; i++) {
      this.goals.push({
        x: i * (this.canvas.width / 5) + this.canvas.width / 10 - 20,
        occupied: false,
      });
    }

    // Create lanes (from bottom to top)
    // Safe zone at bottom
    this.lanes.push({
      y: this.canvas.height - 60,
      type: "safe",
      obstacles: [],
    });

    // Road lanes
    for (let i = 0; i < 4; i++) {
      this.lanes.push({
        y: this.canvas.height - 100 - i * 40,
        type: "road",
        direction: i % 2 === 0 ? 1 : -1,
        speed: 2 + i * 0.5,
        obstacles: this.createCars(3 + i),
      });
    }

    // Middle safe zone
    this.lanes.push({
      y: this.canvas.height - 260,
      type: "safe",
      obstacles: [],
    });

    // Water lanes
    for (let i = 0; i < 4; i++) {
      this.lanes.push({
        y: this.canvas.height - 300 - i * 40,
        type: "water",
        direction: i % 2 === 0 ? -1 : 1,
        speed: 1.5 + i * 0.3,
        obstacles: this.createLogs(3),
      });
    }
  }

  createCars(count) {
    const cars = [];
    for (let i = 0; i < count; i++) {
      cars.push({
        x: i * (this.canvas.width / count),
        width: 50 + Math.random() * 30,
      });
    }
    return cars;
  }

  createLogs(count) {
    const logs = [];
    for (let i = 0; i < count; i++) {
      logs.push({
        x: i * (this.canvas.width / count),
        width: 80 + Math.random() * 40,
      });
    }
    return logs;
  }

  resetPlayer() {
    this.player.x = this.canvas.width / 2 - 15;
    this.player.y = this.canvas.height - 45;
  }

  update() {
    const now = Date.now();

    // Player movement
    if (now - this.moveDelay > 150) {
      let moved = false;
      if (this.keys["ArrowUp"]) {
        this.player.y -= 40;
        moved = true;
      }
      if (this.keys["ArrowDown"] && this.player.y < this.canvas.height - 45) {
        this.player.y += 40;
        moved = true;
      }
      if (this.keys["ArrowLeft"]) {
        this.player.x -= 35;
        moved = true;
      }
      if (this.keys["ArrowRight"]) {
        this.player.x += 35;
        moved = true;
      }

      if (moved) {
        this.moveDelay = now;
        // Clamp X position
        this.player.x = Math.max(
          0,
          Math.min(this.canvas.width - this.player.size, this.player.x)
        );
      }
    }

    // Check goal reached
    if (this.player.y < 40) {
      for (let i = 0; i < this.goals.length; i++) {
        const g = this.goals[i];
        if (!g.occupied && Math.abs(this.player.x - g.x) < 30) {
          g.occupied = true;
          this.goalsReached++;
          this.score += 100;
          this.updateScore();
          this.resetPlayer();

          if (this.goalsReached >= 5) {
            // Reset for next level
            this.score += 500;
            this.updateScore();
            this.goalsReached = 0;
            for (let j = 0; j < this.goals.length; j++) {
              this.goals[j].occupied = false;
            }
          }
          return;
        }
      }
      // Missed goal slot
      this.loseLife();
      return;
    }

    // Update lanes and check collisions
    let onLog = false;
    let logSpeed = 0;
    let logDir = 0;

    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];

      // Move obstacles
      for (let j = 0; j < lane.obstacles.length; j++) {
        const obs = lane.obstacles[j];
        obs.x += lane.direction * lane.speed;

        // Wrap around
        if (lane.direction > 0 && obs.x > this.canvas.width) {
          obs.x = -obs.width;
        }
        if (lane.direction < 0 && obs.x + obs.width < 0) {
          obs.x = this.canvas.width;
        }
      }

      // Check if player is in this lane
      if (this.player.y >= lane.y && this.player.y < lane.y + 40) {
        if (lane.type === "road") {
          // Check car collision
          for (let j = 0; j < lane.obstacles.length; j++) {
            const obs = lane.obstacles[j];
            if (
              this.player.x + this.player.size > obs.x &&
              this.player.x < obs.x + obs.width
            ) {
              this.loseLife();
              return;
            }
          }
        } else if (lane.type === "water") {
          // Must be on a log
          for (let j = 0; j < lane.obstacles.length; j++) {
            const obs = lane.obstacles[j];
            if (
              this.player.x + this.player.size / 2 > obs.x &&
              this.player.x + this.player.size / 2 < obs.x + obs.width
            ) {
              onLog = true;
              logSpeed = lane.speed;
              logDir = lane.direction;
            }
          }
        }
      }
    }

    // Check if player is in water but not on log
    if (
      this.player.y >= this.canvas.height - 420 &&
      this.player.y < this.canvas.height - 260
    ) {
      if (onLog) {
        // Move with log
        this.player.x += logDir * logSpeed;
        if (
          this.player.x < 0 ||
          this.player.x > this.canvas.width - this.player.size
        ) {
          this.loseLife();
          return;
        }
      } else {
        this.loseLife();
        return;
      }
    }
  }

  loseLife() {
    this.lives--;
    if (this.lives <= 0) {
      this.gameOver();
    } else {
      this.resetPlayer();
    }
  }

  draw() {
    const { ctx, canvas } = this;

    // Goal area
    ctx.fillStyle = "#1e3a5f";
    ctx.fillRect(0, 0, canvas.width, 40);

    // Draw goals
    for (let i = 0; i < this.goals.length; i++) {
      const g = this.goals[i];
      ctx.fillStyle = g.occupied ? "#22c55e" : "#166534";
      ctx.fillRect(g.x, 5, 40, 30);
    }

    // Draw lanes
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];

      if (lane.type === "safe") {
        ctx.fillStyle = "#7c3aed";
      } else if (lane.type === "road") {
        ctx.fillStyle = "#374151";
      } else if (lane.type === "water") {
        ctx.fillStyle = "#1e40af";
      }
      ctx.fillRect(0, lane.y, canvas.width, 40);

      // Draw obstacles
      for (let j = 0; j < lane.obstacles.length; j++) {
        const obs = lane.obstacles[j];
        if (lane.type === "road") {
          // Draw car
          ctx.fillStyle = ["#ef4444", "#f59e0b", "#3b82f6"][j % 3];
          ctx.fillRect(obs.x, lane.y + 5, obs.width, 30);
          // Windows
          ctx.fillStyle = "#94a3b8";
          ctx.fillRect(obs.x + 10, lane.y + 10, 15, 15);
        } else if (lane.type === "water") {
          // Draw log
          ctx.fillStyle = "#854d0e";
          ctx.fillRect(obs.x, lane.y + 8, obs.width, 24);
          ctx.fillStyle = "#a16207";
          ctx.fillRect(obs.x + 5, lane.y + 12, obs.width - 10, 16);
        }
      }
    }

    // Draw frog
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.ellipse(
      this.player.x + this.player.size / 2,
      this.player.y + this.player.size / 2,
      this.player.size / 2,
      this.player.size / 2.5,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // Frog eyes
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(this.player.x + 8, this.player.y + 8, 5, 0, Math.PI * 2);
    ctx.arc(this.player.x + 22, this.player.y + 8, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(this.player.x + 8, this.player.y + 8, 2, 0, Math.PI * 2);
    ctx.arc(this.player.x + 22, this.player.y + 8, 2, 0, Math.PI * 2);
    ctx.fill();

    // Draw lives
    ctx.fillStyle = "#22c55e";
    ctx.font = "14px sans-serif";
    ctx.fillText("Lives: " + this.lives, canvas.width - 70, 25);
  }
}

// Stack Game (Mobile Classic)
class StackGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "stack";
  }

  init() {
    this.blockHeight = 25;
    this.blocks = [];
    this.currentBlock = null;
    this.direction = 1;
    this.speed = 3;
    this.perfectCount = 0;
    this.actionPressed = false;

    // Start with base block
    this.blocks.push({
      x: this.canvas.width / 2 - 100,
      width: 200,
      y: this.canvas.height - this.blockHeight,
    });

    this.spawnBlock();
  }

  spawnBlock() {
    const lastBlock = this.blocks[this.blocks.length - 1];
    this.currentBlock = {
      x: this.direction > 0 ? -lastBlock.width : this.canvas.width,
      width: lastBlock.width,
      y: lastBlock.y - this.blockHeight,
      moving: true,
    };
  }

  update() {
    if (!this.currentBlock) return;

    // Check for action (Enter or any key press)
    const actionNow =
      this.keys["action"] || this.keys["ArrowUp"] || this.keys["ArrowDown"];

    if (actionNow && !this.actionPressed && this.currentBlock.moving) {
      this.actionPressed = true;
      this.placeBlock();
    }
    if (!actionNow) {
      this.actionPressed = false;
    }

    // Move current block
    if (this.currentBlock.moving) {
      this.currentBlock.x += this.direction * this.speed;

      // Reverse at edges
      if (
        this.currentBlock.x <= -50 ||
        this.currentBlock.x >= this.canvas.width - this.currentBlock.width + 50
      ) {
        this.direction *= -1;
      }
    }
  }

  placeBlock() {
    const lastBlock = this.blocks[this.blocks.length - 1];
    const current = this.currentBlock;

    // Calculate overlap
    const overlapStart = Math.max(current.x, lastBlock.x);
    const overlapEnd = Math.min(
      current.x + current.width,
      lastBlock.x + lastBlock.width
    );
    const overlapWidth = overlapEnd - overlapStart;

    if (overlapWidth <= 0) {
      // Missed completely
      this.gameOver();
      return;
    }

    // Check for perfect placement (within 5 pixels)
    if (
      Math.abs(current.x - lastBlock.x) < 5 &&
      current.width === lastBlock.width
    ) {
      this.perfectCount++;
      this.score += 20 + this.perfectCount * 5; // Bonus for consecutive perfects
      current.x = lastBlock.x; // Snap to perfect
    } else {
      this.perfectCount = 0;
      this.score += 10;
      // Trim the block
      current.x = overlapStart;
      current.width = overlapWidth;
    }

    current.moving = false;
    this.blocks.push({
      x: current.x,
      width: current.width,
      y: current.y,
    });

    this.updateScore();

    // Scroll down if needed
    if (current.y < this.canvas.height / 2) {
      const scroll = this.blockHeight;
      for (let i = 0; i < this.blocks.length; i++) {
        this.blocks[i].y += scroll;
      }
      // Remove blocks that are off screen
      this.blocks = this.blocks.filter(
        (b) => b.y < this.canvas.height + this.blockHeight
      );
    }

    // Increase speed slightly
    this.speed = Math.min(8, this.speed + 0.1);

    // Spawn next block
    this.spawnBlock();
  }

  draw() {
    const { ctx, canvas } = this;

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#1a1025");
    gradient.addColorStop(1, "#0a0612");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw placed blocks with gradient colors
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      const hue = (i * 15) % 360;
      ctx.fillStyle = "hsl(" + hue + ", 70%, 50%)";
      ctx.fillRect(block.x, block.y, block.width, this.blockHeight - 2);

      // Highlight
      ctx.fillStyle = "hsl(" + hue + ", 70%, 60%)";
      ctx.fillRect(block.x, block.y, block.width, 4);
    }

    // Draw current moving block
    if (this.currentBlock) {
      const hue = (this.blocks.length * 15) % 360;
      ctx.fillStyle = "hsl(" + hue + ", 70%, 50%)";
      ctx.fillRect(
        this.currentBlock.x,
        this.currentBlock.y,
        this.currentBlock.width,
        this.blockHeight - 2
      );
      ctx.fillStyle = "hsl(" + hue + ", 70%, 60%)";
      ctx.fillRect(
        this.currentBlock.x,
        this.currentBlock.y,
        this.currentBlock.width,
        4
      );
    }

    // Perfect streak indicator
    if (this.perfectCount > 0) {
      ctx.fillStyle = "#f97316";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("PERFECT x" + this.perfectCount + "!", canvas.width / 2, 30);
      ctx.textAlign = "left";
    }
  }
}

// 2048 Game
class Game2048 extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "game2048";
  }

  init() {
    this.gridSize = 4;
    this.tileSize = 80;
    this.padding = 10;
    this.grid = [];
    this.moved = false;
    this.moveDelay = 0;

    // Initialize empty grid
    for (let i = 0; i < this.gridSize; i++) {
      this.grid[i] = [];
      for (let j = 0; j < this.gridSize; j++) {
        this.grid[i][j] = 0;
      }
    }

    // Add two starting tiles
    this.addRandomTile();
    this.addRandomTile();
  }

  addRandomTile() {
    const empty = [];
    for (let i = 0; i < this.gridSize; i++) {
      for (let j = 0; j < this.gridSize; j++) {
        if (this.grid[i][j] === 0) {
          empty.push({ r: i, c: j });
        }
      }
    }

    if (empty.length > 0) {
      const cell = empty[Math.floor(Math.random() * empty.length)];
      this.grid[cell.r][cell.c] = Math.random() < 0.9 ? 2 : 4;
    }
  }

  slide(row) {
    // Remove zeros
    let arr = row.filter((x) => x !== 0);

    // Merge adjacent equal values
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i] === arr[i + 1]) {
        arr[i] *= 2;
        this.score += arr[i];
        arr.splice(i + 1, 1);
      }
    }

    // Pad with zeros
    while (arr.length < this.gridSize) {
      arr.push(0);
    }

    return arr;
  }

  moveLeft() {
    let moved = false;
    for (let i = 0; i < this.gridSize; i++) {
      const original = this.grid[i].slice();
      this.grid[i] = this.slide(this.grid[i]);
      if (original.join(",") !== this.grid[i].join(",")) moved = true;
    }
    return moved;
  }

  moveRight() {
    let moved = false;
    for (let i = 0; i < this.gridSize; i++) {
      const original = this.grid[i].slice();
      this.grid[i] = this.slide(this.grid[i].reverse()).reverse();
      if (original.join(",") !== this.grid[i].join(",")) moved = true;
    }
    return moved;
  }

  moveUp() {
    let moved = false;
    for (let j = 0; j < this.gridSize; j++) {
      let col = [];
      for (let i = 0; i < this.gridSize; i++) col.push(this.grid[i][j]);
      const original = col.slice();
      col = this.slide(col);
      for (let i = 0; i < this.gridSize; i++) this.grid[i][j] = col[i];
      if (original.join(",") !== col.join(",")) moved = true;
    }
    return moved;
  }

  moveDown() {
    let moved = false;
    for (let j = 0; j < this.gridSize; j++) {
      let col = [];
      for (let i = 0; i < this.gridSize; i++) col.push(this.grid[i][j]);
      const original = col.slice();
      col = this.slide(col.reverse()).reverse();
      for (let i = 0; i < this.gridSize; i++) this.grid[i][j] = col[i];
      if (original.join(",") !== col.join(",")) moved = true;
    }
    return moved;
  }

  canMove() {
    // Check for empty cells
    for (let i = 0; i < this.gridSize; i++) {
      for (let j = 0; j < this.gridSize; j++) {
        if (this.grid[i][j] === 0) return true;
      }
    }
    // Check for possible merges
    for (let i = 0; i < this.gridSize; i++) {
      for (let j = 0; j < this.gridSize; j++) {
        const val = this.grid[i][j];
        if (i < this.gridSize - 1 && this.grid[i + 1][j] === val) return true;
        if (j < this.gridSize - 1 && this.grid[i][j + 1] === val) return true;
      }
    }
    return false;
  }

  update() {
    const now = Date.now();
    if (now - this.moveDelay < 150) return;

    let moved = false;

    if (this.keys["ArrowLeft"]) {
      moved = this.moveLeft();
      this.moveDelay = now;
    } else if (this.keys["ArrowRight"]) {
      moved = this.moveRight();
      this.moveDelay = now;
    } else if (this.keys["ArrowUp"]) {
      moved = this.moveUp();
      this.moveDelay = now;
    } else if (this.keys["ArrowDown"]) {
      moved = this.moveDown();
      this.moveDelay = now;
    }

    if (moved) {
      this.addRandomTile();
      this.updateScore();

      if (!this.canMove()) {
        this.gameOver();
      }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const offsetX =
      (canvas.width -
        (this.gridSize * (this.tileSize + this.padding) + this.padding)) /
      2;
    const offsetY =
      (canvas.height -
        (this.gridSize * (this.tileSize + this.padding) + this.padding)) /
      2;

    // Draw grid background
    ctx.fillStyle = "#1a1025";
    ctx.fillRect(
      offsetX,
      offsetY,
      this.gridSize * (this.tileSize + this.padding) + this.padding,
      this.gridSize * (this.tileSize + this.padding) + this.padding
    );

    // Color map for tiles
    const colors = {
      0: "#2d1f42",
      2: "#7c3aed",
      4: "#8b5cf6",
      8: "#a78bfa",
      16: "#c4b5fd",
      32: "#f97316",
      64: "#fb923c",
      128: "#fbbf24",
      256: "#facc15",
      512: "#a3e635",
      1024: "#22c55e",
      2048: "#14b8a6",
    };

    // Draw tiles
    for (let i = 0; i < this.gridSize; i++) {
      for (let j = 0; j < this.gridSize; j++) {
        const val = this.grid[i][j];
        const x = offsetX + this.padding + j * (this.tileSize + this.padding);
        const y = offsetY + this.padding + i * (this.tileSize + this.padding);

        ctx.fillStyle = colors[val] || "#14b8a6";
        ctx.fillRect(x, y, this.tileSize, this.tileSize);

        if (val !== 0) {
          ctx.fillStyle = val <= 4 ? "#fff" : "#1a1025";
          ctx.font =
            val >= 1000 ? "bold 24px sans-serif" : "bold 32px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            val.toString(),
            x + this.tileSize / 2,
            y + this.tileSize / 2
          );
        }
      }
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}

// Color Switch Game
class ColorSwitchGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "colorswitch";
  }

  init() {
    this.ball = {
      x: this.canvas.width / 2,
      y: this.canvas.height - 100,
      radius: 15,
      vy: 0,
      colorIndex: 0,
    };

    this.colors = ["#f97316", "#7c3aed", "#22c55e", "#3b82f6"];
    this.gravity = 0.3;
    this.jumpForce = -10;
    this.obstacles = [];
    this.stars = [];
    this.scrollOffset = 0;
    this.actionPressed = false;

    // Create initial obstacles
    this.spawnObstacle(this.canvas.height - 250);
    this.spawnObstacle(this.canvas.height - 450);
  }

  spawnObstacle(y) {
    const types = ["circle", "bar", "square"];
    const type = types[Math.floor(Math.random() * types.length)];

    this.obstacles.push({
      y: y,
      type: type,
      rotation: 0,
      rotationSpeed: 0.02 + Math.random() * 0.02,
    });

    // Add color switcher and star
    this.stars.push({
      x: this.canvas.width / 2,
      y: y - 80,
      collected: false,
    });
  }

  update() {
    // Jump on action
    const actionNow = this.keys["action"] || this.keys["ArrowUp"];
    if (actionNow && !this.actionPressed) {
      this.ball.vy = this.jumpForce;
      this.actionPressed = true;
    }
    if (!actionNow) {
      this.actionPressed = false;
    }

    // Physics
    this.ball.vy += this.gravity;
    this.ball.vy = Math.min(this.ball.vy, 12); // Terminal velocity
    this.ball.y += this.ball.vy;

    // Scroll when ball is in upper half
    if (this.ball.y < this.canvas.height / 2) {
      const scroll = this.canvas.height / 2 - this.ball.y;
      this.ball.y = this.canvas.height / 2;
      this.scrollOffset += scroll;

      for (let i = 0; i < this.obstacles.length; i++) {
        this.obstacles[i].y += scroll;
      }
      for (let i = 0; i < this.stars.length; i++) {
        this.stars[i].y += scroll;
      }

      // Remove off-screen obstacles and spawn new ones
      this.obstacles = this.obstacles.filter(
        (o) => o.y < this.canvas.height + 100
      );
      this.stars = this.stars.filter((s) => s.y < this.canvas.height + 100);

      while (this.obstacles.length < 3) {
        const topY = Math.min.apply(
          null,
          this.obstacles.map(function (o) {
            return o.y;
          })
        );
        this.spawnObstacle(topY - 200);
      }
    }

    // Bottom boundary
    if (this.ball.y > this.canvas.height + 50) {
      this.gameOver();
      return;
    }

    // Update obstacles rotation
    for (let i = 0; i < this.obstacles.length; i++) {
      this.obstacles[i].rotation += this.obstacles[i].rotationSpeed;
    }

    // Check star collection
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      if (!star.collected) {
        const dx = this.ball.x - star.x;
        const dy = this.ball.y - star.y;
        if (Math.sqrt(dx * dx + dy * dy) < 25) {
          star.collected = true;
          this.score += 10;
          this.updateScore();
          // Change ball color
          this.ball.colorIndex = Math.floor(Math.random() * 4);
        }
      }
    }

    // Check obstacle collision
    for (let i = 0; i < this.obstacles.length; i++) {
      if (this.checkObstacleCollision(this.obstacles[i])) {
        this.gameOver();
        return;
      }
    }
  }

  checkObstacleCollision(obstacle) {
    const ballColor = this.ball.colorIndex;
    const obs = obstacle;

    if (obs.type === "circle") {
      // Rotating circle obstacle
      const centerX = this.canvas.width / 2;
      const centerY = obs.y;
      const radius = 60;
      const dx = this.ball.x - centerX;
      const dy = this.ball.y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Check if ball is passing through the ring
      if (dist > radius - 20 && dist < radius + 20) {
        // Determine which color segment
        const angle = Math.atan2(dy, dx) - obs.rotation;
        const normalizedAngle =
          ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const segment = Math.floor(normalizedAngle / (Math.PI / 2));

        if (segment !== ballColor) {
          return true; // Wrong color = collision
        }
      }
    } else if (obs.type === "bar") {
      // Horizontal bar
      if (Math.abs(this.ball.y - obs.y) < 25) {
        const barWidth = 150;
        const segmentWidth = barWidth / 4;
        const barX =
          this.canvas.width / 2 -
          barWidth / 2 +
          Math.sin(obs.rotation * 3) * 50;

        if (this.ball.x > barX && this.ball.x < barX + barWidth) {
          const segment = Math.floor((this.ball.x - barX) / segmentWidth);
          if (segment !== ballColor && segment >= 0 && segment < 4) {
            return true;
          }
        }
      }
    }

    return false;
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw obstacles
    for (let i = 0; i < this.obstacles.length; i++) {
      this.drawObstacle(this.obstacles[i]);
    }

    // Draw stars
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      if (!star.collected) {
        ctx.fillStyle = "#fbbf24";
        ctx.beginPath();
        ctx.arc(star.x, star.y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0a0612";
        ctx.beginPath();
        ctx.arc(star.x, star.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw ball
    ctx.fillStyle = this.colors[this.ball.colorIndex];
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, this.ball.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  drawObstacle(obs) {
    const { ctx } = this;
    const centerX = this.canvas.width / 2;

    if (obs.type === "circle") {
      const radius = 60;
      const thickness = 12;

      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(
          centerX,
          obs.y,
          radius,
          obs.rotation + (i * Math.PI) / 2,
          obs.rotation + ((i + 1) * Math.PI) / 2
        );
        ctx.strokeStyle = this.colors[i];
        ctx.lineWidth = thickness;
        ctx.stroke();
      }
    } else if (obs.type === "bar") {
      const barWidth = 150;
      const segmentWidth = barWidth / 4;
      const barX = centerX - barWidth / 2 + Math.sin(obs.rotation * 3) * 50;

      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = this.colors[i];
        ctx.fillRect(barX + i * segmentWidth, obs.y - 10, segmentWidth, 20);
      }
    } else if (obs.type === "square") {
      ctx.save();
      ctx.translate(centerX, obs.y);
      ctx.rotate(obs.rotation);

      const size = 80;
      const thickness = 12;

      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = this.colors[i];
        ctx.lineWidth = thickness;
        ctx.beginPath();
        const angle = (i * Math.PI) / 2;
        const x1 = Math.cos(angle) * size - Math.sin(angle) * size;
        const y1 = Math.sin(angle) * size + Math.cos(angle) * size;
        const x2 =
          Math.cos(angle + Math.PI / 2) * size -
          Math.sin(angle + Math.PI / 2) * size;
        const y2 =
          Math.sin(angle + Math.PI / 2) * size +
          Math.cos(angle + Math.PI / 2) * size;
        ctx.moveTo(x1 / 1.4, y1 / 1.4);
        ctx.lineTo(x2 / 1.4, y2 / 1.4);
        ctx.stroke();
      }

      ctx.restore();
    }
  }
}

// Piano Tiles Game
class PianoTilesGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "pianotiles";
  }

  init() {
    this.lanes = 4;
    this.tileWidth = this.canvas.width / this.lanes;
    this.tileHeight = 100;
    this.tiles = [];
    this.speed = 4;
    this.lastTile = 0;
    this.combo = 0;

    // Spawn initial tiles
    for (let i = 0; i < 5; i++) {
      this.spawnTile(-i * this.tileHeight - 50);
    }
  }

  spawnTile(y) {
    this.tiles.push({
      lane: Math.floor(Math.random() * this.lanes),
      y: y,
      hit: false,
    });
  }

  update() {
    // Move tiles down
    for (let i = 0; i < this.tiles.length; i++) {
      this.tiles[i].y += this.speed;
    }

    // Check for key presses (1-4 or arrow keys)
    const laneKeys = [
      this.keys["1"] || this.keys["ArrowLeft"],
      this.keys["2"] ||
        (this.keys["ArrowDown"] &&
          !this.keys["ArrowLeft"] &&
          !this.keys["ArrowRight"]),
      this.keys["3"] ||
        (this.keys["ArrowUp"] &&
          !this.keys["ArrowLeft"] &&
          !this.keys["ArrowRight"]),
      this.keys["4"] || this.keys["ArrowRight"],
    ];

    // Alternative: left, down, up, right for 4 lanes
    const altKeys = [
      this.keys["ArrowLeft"],
      this.keys["ArrowDown"],
      this.keys["ArrowUp"],
      this.keys["ArrowRight"],
    ];

    // Find the lowest unhit tile
    let lowestTile = null;
    let lowestY = -Infinity;
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (!tile.hit && tile.y > lowestY && tile.y < this.canvas.height) {
        lowestY = tile.y;
        lowestTile = tile;
      }
    }

    // Check if correct lane is pressed
    if (
      lowestTile &&
      lowestTile.y > 0 &&
      lowestTile.y < this.canvas.height - 50
    ) {
      if (altKeys[lowestTile.lane] && !lowestTile.hit) {
        lowestTile.hit = true;
        this.combo++;
        this.score += 10 + Math.floor(this.combo / 5);
        this.updateScore();
        this.speed = Math.min(12, 4 + this.score / 100);
      }
    }

    // Check for missed tiles
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (!tile.hit && tile.y > this.canvas.height) {
        this.gameOver();
        return;
      }
    }

    // Remove old tiles and spawn new ones
    this.tiles = this.tiles.filter((t) => t.y < this.canvas.height + 50);

    while (this.tiles.length < 8) {
      const topY = Math.min.apply(
        null,
        this.tiles.map(function (t) {
          return t.y;
        })
      );
      this.spawnTile(topY - this.tileHeight - 20);
    }
  }

  draw() {
    const { ctx, canvas } = this;

    // Draw lanes
    for (let i = 0; i < this.lanes; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#1a1025" : "#0a0612";
      ctx.fillRect(i * this.tileWidth, 0, this.tileWidth, canvas.height);
    }

    // Draw lane dividers
    ctx.strokeStyle = "#2d1f42";
    ctx.lineWidth = 2;
    for (let i = 1; i < this.lanes; i++) {
      ctx.beginPath();
      ctx.moveTo(i * this.tileWidth, 0);
      ctx.lineTo(i * this.tileWidth, canvas.height);
      ctx.stroke();
    }

    // Draw hit zone
    ctx.fillStyle = "rgba(124, 58, 237, 0.3)";
    ctx.fillRect(0, canvas.height - 100, canvas.width, 100);

    // Draw tiles
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (tile.hit) {
        ctx.fillStyle = "#22c55e";
      } else {
        ctx.fillStyle = "#7c3aed";
      }
      ctx.fillRect(
        tile.lane * this.tileWidth + 4,
        tile.y,
        this.tileWidth - 8,
        this.tileHeight - 4
      );
    }

    // Draw lane indicators at bottom
    const labels = ["←", "↓", "↑", "→"];
    ctx.fillStyle = "#a78bfa";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < this.lanes; i++) {
      ctx.fillText(
        labels[i],
        i * this.tileWidth + this.tileWidth / 2,
        canvas.height - 20
      );
    }
    ctx.textAlign = "left";

    // Draw combo
    if (this.combo > 0) {
      ctx.fillStyle = "#f97316";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText("Combo: " + this.combo, 10, 30);
    }
  }
}

// Simon Says Game (Memory)
class SimonGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "simon";
  }

  init() {
    this.sequence = [];
    this.playerSequence = [];
    this.isShowingSequence = false;
    this.showIndex = 0;
    this.showTimer = 0;
    this.activeButton = -1;
    this.inputDelay = 0;
    this.gamePhase = "watch"; // 'watch' or 'play'
    this.round = 0;

    // Speed settings - get faster each round
    this.baseShowTime = 600; // Time to show each button
    this.basePauseTime = 400; // Time between buttons
    this.minShowTime = 200; // Minimum time (fastest)
    this.minPauseTime = 150;

    this.buttons = [
      { x: 150, y: 100, color: "#22c55e", key: "ArrowUp" },
      { x: 300, y: 175, color: "#ef4444", key: "ArrowRight" },
      { x: 150, y: 250, color: "#3b82f6", key: "ArrowDown" },
      { x: 0, y: 175, color: "#f97316", key: "ArrowLeft" },
    ];

    // Start first round
    this.addToSequence();
    this.startShowSequence();
  }

  // Calculate timing based on round (gets faster)
  getShowTime() {
    return Math.max(
      this.minShowTime,
      this.baseShowTime - (this.round - 1) * 40
    );
  }

  getPauseTime() {
    return Math.max(
      this.minPauseTime,
      this.basePauseTime - (this.round - 1) * 25
    );
  }

  addToSequence() {
    this.sequence.push(Math.floor(Math.random() * 4));
    this.round = this.sequence.length;
  }

  startShowSequence() {
    this.isShowingSequence = true;
    this.showIndex = 0;
    this.showTimer = Date.now() + 500; // Initial delay before starting
    this.gamePhase = "watch";
    this.activeButton = -1;
  }

  update() {
    const now = Date.now();

    if (this.isShowingSequence) {
      if (now > this.showTimer) {
        if (this.activeButton >= 0) {
          // Turn off current button
          this.activeButton = -1;
          this.showTimer = now + this.getPauseTime();
        } else if (this.showIndex < this.sequence.length) {
          // Show next button
          this.activeButton = this.sequence[this.showIndex];
          this.showIndex++;
          this.showTimer = now + this.getShowTime();
        } else {
          // Done showing, player's turn
          this.isShowingSequence = false;
          this.playerSequence = [];
          this.gamePhase = "play";
        }
      }
    } else {
      // Player input phase
      if (now - this.inputDelay > 200) {
        for (let i = 0; i < 4; i++) {
          if (this.keys[this.buttons[i].key]) {
            this.inputDelay = now;
            this.activeButton = i;
            this.playerSequence.push(i);

            // Check if correct
            const idx = this.playerSequence.length - 1;
            if (this.playerSequence[idx] !== this.sequence[idx]) {
              this.gameOver();
              return;
            }

            // Check if sequence complete
            if (this.playerSequence.length === this.sequence.length) {
              this.score += this.sequence.length * 10;
              this.updateScore();
              this.addToSequence();

              // Short delay then show new sequence
              setTimeout(() => {
                if (this.running) {
                  this.startShowSequence();
                }
              }, 1000);
            }

            break;
          }
        }
      } else if (now - this.inputDelay > 100) {
        this.activeButton = -1;
      }
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // Draw buttons
    for (let i = 0; i < 4; i++) {
      const btn = this.buttons[i];
      const isActive = this.activeButton === i;

      ctx.fillStyle = isActive ? "#fff" : btn.color;
      ctx.globalAlpha = isActive ? 1 : 0.6;

      ctx.beginPath();
      ctx.arc(centerX + btn.x - 150, centerY + btn.y - 175, 60, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
    }

    // Draw center circle
    ctx.fillStyle = "#1a1025";
    ctx.beginPath();
    ctx.arc(centerX, centerY, 40, 0, Math.PI * 2);
    ctx.fill();

    // Draw round number
    ctx.fillStyle = "#fff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(this.round.toString(), centerX, centerY + 8);

    // Draw phase indicator
    ctx.font = "16px sans-serif";
    ctx.fillStyle = this.gamePhase === "watch" ? "#f97316" : "#22c55e";
    ctx.fillText(
      this.gamePhase === "watch" ? "WATCH" : "YOUR TURN",
      centerX,
      40
    );

    // Draw arrow hints
    ctx.fillStyle = "#a78bfa";
    ctx.font = "14px sans-serif";
    ctx.fillText("↑", centerX, centerY - 100);
    ctx.fillText("→", centerX + 100, centerY);
    ctx.fillText("↓", centerX, centerY + 110);
    ctx.fillText("←", centerX - 100, centerY);

    ctx.textAlign = "left";
  }
}

// Trivia Game - Uses Open Trivia Database API
class TriviaGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "trivia";
  }

  init() {
    this.questions = [];
    this.currentQuestion = 0;
    this.selectedAnswer = 0;
    this.totalQuestions = 10;
    this.correctAnswers = 0;
    this.answered = false;
    this.showResult = false;
    this.resultTimer = 0;
    this.loading = true;
    this.error = null;
    this.lastKeyTime = 0;
    this.keyDelay = 200; // Prevent key repeat

    // Fetch questions from API
    this.fetchQuestions();
  }

  fetchQuestions() {
    var self = this;
    var xhr = new XMLHttpRequest();
    xhr.open(
      "GET",
      "https://opentdb.com/api.php?amount=10&type=multiple&encode=url3986",
      true
    );
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.response_code === 0 && data.results) {
              self.questions = self.processQuestions(data.results);
              self.loading = false;
            } else {
              self.error = "Failed to load questions";
              self.loading = false;
            }
          } catch (e) {
            self.error = "Failed to parse questions";
            self.loading = false;
          }
        } else {
          self.error = "Network error";
          self.loading = false;
        }
      }
    };
    xhr.onerror = function () {
      self.error = "Network error";
      self.loading = false;
    };
    xhr.send();
  }

  processQuestions(results) {
    var questions = [];
    for (var i = 0; i < results.length; i++) {
      var q = results[i];
      // Decode URL encoding
      var question = decodeURIComponent(q.question);
      var correct = decodeURIComponent(q.correct_answer);
      var incorrect = [];
      for (var j = 0; j < q.incorrect_answers.length; j++) {
        incorrect.push(decodeURIComponent(q.incorrect_answers[j]));
      }

      // Shuffle answers
      var answers = incorrect.slice();
      var correctIndex = Math.floor(Math.random() * 4);
      answers.splice(correctIndex, 0, correct);

      questions.push({
        question: question,
        answers: answers,
        correctIndex: correctIndex,
        category: decodeURIComponent(q.category),
        difficulty: q.difficulty,
      });
    }
    return questions;
  }

  update() {
    var now = Date.now();

    if (this.loading || this.error) return;

    // Check if game is complete
    if (this.currentQuestion >= this.questions.length) {
      this.score = this.correctAnswers * 10;
      this.updateScore();
      this.gameOver();
      return;
    }

    // Show result briefly before moving to next question
    if (this.showResult) {
      if (now - this.resultTimer > 1500) {
        this.showResult = false;
        this.answered = false;
        this.currentQuestion++;
        this.selectedAnswer = 0;
      }
      return;
    }

    // Handle input with debounce
    if (now - this.lastKeyTime < this.keyDelay) return;

    if (this.keys["ArrowUp"] || this.keys[38]) {
      this.selectedAnswer = (this.selectedAnswer - 1 + 4) % 4;
      this.lastKeyTime = now;
      this.playSound("move");
    }

    if (this.keys["ArrowDown"] || this.keys[40]) {
      this.selectedAnswer = (this.selectedAnswer + 1) % 4;
      this.lastKeyTime = now;
      this.playSound("move");
    }

    if (
      (this.keys["Enter"] || this.keys[13] || this.keys["action"]) &&
      !this.answered
    ) {
      this.answered = true;
      this.showResult = true;
      this.resultTimer = now;

      var q = this.questions[this.currentQuestion];
      if (this.selectedAnswer === q.correctIndex) {
        this.correctAnswers++;
        this.score = this.correctAnswers * 10;
        this.updateScore();
        this.playSound("score");
      } else {
        this.playSound("hit");
      }

      this.lastKeyTime = now;
    }
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Background
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Loading state
    if (this.loading) {
      ctx.fillStyle = "#a78bfa";
      ctx.font = "bold 24px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading questions...", canvas.width / 2, canvas.height / 2);
      ctx.textAlign = "left";
      return;
    }

    // Error state
    if (this.error) {
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(this.error, canvas.width / 2, canvas.height / 2 - 20);
      ctx.fillStyle = "#a78bfa";
      ctx.font = "16px sans-serif";
      ctx.fillText(
        "Press ESC and try again",
        canvas.width / 2,
        canvas.height / 2 + 20
      );
      ctx.textAlign = "left";
      return;
    }

    if (this.currentQuestion >= this.questions.length) return;

    var q = this.questions[this.currentQuestion];

    // Draw progress
    ctx.fillStyle = "#2d1f42";
    ctx.fillRect(20, 15, canvas.width - 40, 8);
    ctx.fillStyle = "#7c3aed";
    var progress =
      (this.currentQuestion / this.questions.length) * (canvas.width - 40);
    ctx.fillRect(20, 15, progress, 8);

    // Question number and category
    ctx.fillStyle = "#a78bfa";
    ctx.font = "14px sans-serif";
    ctx.fillText(
      "Question " +
        (this.currentQuestion + 1) +
        "/" +
        this.questions.length +
        " | " +
        q.category,
      20,
      45
    );

    // Difficulty badge
    var diffColors = { easy: "#22c55e", medium: "#f97316", hard: "#ef4444" };
    ctx.fillStyle = diffColors[q.difficulty] || "#a78bfa";
    ctx.fillText(q.difficulty.toUpperCase(), canvas.width - 70, 45);

    // Question text (word wrap)
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 18px sans-serif";
    this.wrapText(q.question, 20, 80, canvas.width - 40, 24);

    // Answer options
    var answerY = 170;
    var answerHeight = 50;

    for (var i = 0; i < q.answers.length; i++) {
      var y = answerY + i * (answerHeight + 10);
      var isSelected = i === this.selectedAnswer;
      var isCorrect = i === q.correctIndex;

      // Answer box
      if (this.showResult) {
        if (isCorrect) {
          ctx.fillStyle = "#22c55e";
        } else if (isSelected && !isCorrect) {
          ctx.fillStyle = "#ef4444";
        } else {
          ctx.fillStyle = "#1a1025";
        }
      } else {
        ctx.fillStyle = isSelected ? "#7c3aed" : "#1a1025";
      }

      ctx.fillRect(20, y, canvas.width - 40, answerHeight);

      // Border
      ctx.strokeStyle = isSelected ? "#f97316" : "#2d1f42";
      ctx.lineWidth = isSelected ? 3 : 1;
      ctx.strokeRect(20, y, canvas.width - 40, answerHeight);

      // Answer letter
      ctx.fillStyle = isSelected ? "#fbbf24" : "#a78bfa";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText(String.fromCharCode(65 + i) + ".", 35, y + 32);

      // Answer text
      ctx.fillStyle = "#f4f4f5";
      ctx.font = "16px sans-serif";
      ctx.fillText(
        this.truncateText(q.answers[i], canvas.width - 100),
        60,
        y + 32
      );
    }

    // Instructions
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "Use ↑↓ to select, ENTER to confirm",
      canvas.width / 2,
      canvas.height - 15
    );
    ctx.textAlign = "left";
  }

  wrapText(text, x, y, maxWidth, lineHeight) {
    var words = text.split(" ");
    var line = "";
    var lines = [];

    for (var i = 0; i < words.length; i++) {
      var testLine = line + words[i] + " ";
      var metrics = this.ctx.measureText(testLine);

      if (metrics.width > maxWidth && i > 0) {
        lines.push(line);
        line = words[i] + " ";
      } else {
        line = testLine;
      }
    }
    lines.push(line);

    // Only show first 3 lines
    for (var j = 0; j < Math.min(lines.length, 3); j++) {
      this.ctx.fillText(lines[j], x, y + j * lineHeight);
    }
  }

  truncateText(text, maxWidth) {
    var metrics = this.ctx.measureText(text);
    if (metrics.width <= maxWidth) return text;

    while (metrics.width > maxWidth && text.length > 0) {
      text = text.substring(0, text.length - 1);
      metrics = this.ctx.measureText(text + "...");
    }
    return text + "...";
  }
}

// Word list for Wordle and Hangman (common 5-letter words)
const WORD_LIST = [
  "about",
  "above",
  "abuse",
  "actor",
  "acute",
  "admit",
  "adopt",
  "adult",
  "after",
  "again",
  "agent",
  "agree",
  "ahead",
  "alarm",
  "album",
  "alert",
  "alien",
  "align",
  "alike",
  "alive",
  "allow",
  "alone",
  "along",
  "alter",
  "among",
  "angel",
  "anger",
  "angle",
  "angry",
  "apart",
  "apple",
  "apply",
  "arena",
  "argue",
  "arise",
  "array",
  "aside",
  "asset",
  "audio",
  "audit",
  "avoid",
  "award",
  "aware",
  "badly",
  "baker",
  "basic",
  "basis",
  "beach",
  "began",
  "begin",
  "begun",
  "being",
  "below",
  "bench",
  "bible",
  "birth",
  "black",
  "blame",
  "blank",
  "blast",
  "blaze",
  "blend",
  "bless",
  "blind",
  "block",
  "blood",
  "blown",
  "board",
  "boost",
  "booth",
  "bound",
  "brain",
  "brand",
  "brave",
  "bread",
  "break",
  "breed",
  "bride",
  "brief",
  "bring",
  "broad",
  "broke",
  "brown",
  "brush",
  "build",
  "built",
  "bunch",
  "burst",
  "buyer",
  "cable",
  "calif",
  "carry",
  "catch",
  "cause",
  "chain",
  "chair",
  "chaos",
  "charm",
  "chart",
  "chase",
  "cheap",
  "check",
  "chest",
  "chief",
  "child",
  "china",
  "chose",
  "chunk",
  "claim",
  "class",
  "clean",
  "clear",
  "click",
  "climb",
  "clock",
  "close",
  "cloud",
  "coach",
  "coast",
  "color",
  "couch",
  "could",
  "count",
  "court",
  "cover",
  "crack",
  "craft",
  "crash",
  "crazy",
  "cream",
  "crime",
  "cross",
  "crowd",
  "crown",
  "cycle",
  "dairy",
  "dance",
  "dated",
  "dealt",
  "death",
  "debut",
  "delay",
  "depth",
  "dirty",
  "doubt",
  "dozen",
  "draft",
  "drain",
  "drama",
  "drank",
  "drawn",
  "dream",
  "dress",
  "drink",
  "drive",
  "drove",
  "drunk",
  "dying",
  "eager",
  "early",
  "earth",
  "eight",
  "elect",
  "elite",
  "empty",
  "enemy",
  "enjoy",
  "enter",
  "entry",
  "equal",
  "error",
  "essay",
  "event",
  "every",
  "exact",
  "exist",
  "extra",
  "faith",
  "falls",
  "false",
  "fault",
  "favor",
  "feast",
  "fever",
  "fiber",
  "field",
  "fifth",
  "fifty",
  "fight",
  "final",
  "first",
  "fixed",
  "flame",
  "flash",
  "fleet",
  "flesh",
  "float",
  "flood",
  "floor",
  "fluid",
  "focus",
  "force",
  "forth",
  "forum",
  "found",
  "frame",
  "frank",
  "fraud",
  "fresh",
  "front",
  "fruit",
  "fully",
  "funny",
  "ghost",
  "giant",
  "given",
  "glass",
  "globe",
  "glory",
  "going",
  "grace",
  "grade",
  "grain",
  "grand",
  "grant",
  "grass",
  "grave",
  "great",
  "green",
  "grief",
  "gross",
  "group",
  "grove",
  "grown",
  "guard",
  "guess",
  "guest",
  "guide",
  "guilt",
  "happy",
  "harsh",
  "haven",
  "heart",
  "heavy",
  "hence",
  "henry",
  "horse",
  "hotel",
  "house",
  "human",
  "ideal",
  "image",
  "index",
  "inner",
  "input",
  "issue",
  "joint",
  "jones",
  "judge",
  "juice",
  "known",
  "label",
  "labor",
  "large",
  "laser",
  "later",
  "laugh",
  "layer",
  "learn",
  "lease",
  "least",
  "leave",
  "legal",
  "level",
  "light",
  "limit",
  "local",
  "loose",
  "logic",
  "looks",
  "lower",
  "lucky",
  "lunch",
  "lying",
  "magic",
  "major",
  "maker",
  "march",
  "match",
  "maybe",
  "mayor",
  "meant",
  "media",
  "metal",
  "might",
  "minor",
  "mixed",
  "model",
  "money",
  "month",
  "moral",
  "motor",
  "mount",
  "mouse",
  "mouth",
  "movie",
  "music",
  "naval",
  "needs",
  "nerve",
  "never",
  "night",
  "noise",
  "north",
  "noted",
  "novel",
  "nurse",
  "occur",
  "ocean",
  "offer",
  "often",
  "oil",
  "order",
  "other",
  "ought",
  "outer",
  "owner",
  "paint",
  "panel",
  "paper",
  "party",
  "patch",
  "peace",
  "phase",
  "phone",
  "photo",
  "piano",
  "piece",
  "pilot",
  "pitch",
  "place",
  "plain",
  "plane",
  "plant",
  "plate",
  "plaza",
  "point",
  "pound",
  "power",
  "press",
  "price",
  "pride",
  "prime",
  "print",
  "prior",
  "prize",
  "proof",
  "proud",
  "prove",
  "queen",
  "quest",
  "quick",
  "quiet",
  "quite",
  "quote",
  "radio",
  "raise",
  "range",
  "rapid",
  "ratio",
  "reach",
  "ready",
  "realm",
  "rebel",
  "refer",
  "reign",
  "relax",
  "reply",
  "rider",
  "ridge",
  "rifle",
  "right",
  "river",
  "robot",
  "rocky",
  "roman",
  "rough",
  "round",
  "route",
  "royal",
  "rugby",
  "rural",
  "saint",
  "salad",
  "sales",
  "sandy",
  "sauce",
  "saved",
  "scale",
  "scene",
  "scope",
  "score",
  "sense",
  "serve",
  "seven",
  "shade",
  "shake",
  "shall",
  "shame",
  "shape",
  "share",
  "sharp",
  "sheet",
  "shelf",
  "shell",
  "shift",
  "shine",
  "shirt",
  "shock",
  "shoot",
  "shore",
  "short",
  "shown",
  "sight",
  "since",
  "skill",
  "sleep",
  "slice",
  "slide",
  "slope",
  "small",
  "smart",
  "smell",
  "smile",
  "smoke",
  "snake",
  "solar",
  "solid",
  "solve",
  "sorry",
  "sound",
  "south",
  "space",
  "spare",
  "speak",
  "speed",
  "spend",
  "spent",
  "spike",
  "spine",
  "spite",
  "split",
  "spoke",
  "sport",
  "spray",
  "squad",
  "stack",
  "staff",
  "stage",
  "stair",
  "stake",
  "stand",
  "stare",
  "stark",
  "start",
  "state",
  "steam",
  "steel",
  "steep",
  "stick",
  "still",
  "stock",
  "stone",
  "stood",
  "store",
  "storm",
  "story",
  "strip",
  "stuck",
  "study",
  "stuff",
  "style",
  "sugar",
  "suite",
  "super",
  "surge",
  "swear",
  "sweep",
  "sweet",
  "swift",
  "swing",
  "sword",
  "table",
  "taken",
  "taste",
  "taxes",
  "teach",
  "teeth",
  "tenor",
  "terms",
  "texas",
  "thank",
  "theft",
  "their",
  "theme",
  "there",
  "these",
  "thick",
  "thing",
  "think",
  "third",
  "those",
  "three",
  "threw",
  "throw",
  "thumb",
  "tiger",
  "tight",
  "timer",
  "tired",
  "title",
  "today",
  "token",
  "topic",
  "total",
  "touch",
  "tough",
  "tower",
  "track",
  "trade",
  "trail",
  "train",
  "trash",
  "treat",
  "trend",
  "trial",
  "tribe",
  "trick",
  "tried",
  "truck",
  "truly",
  "trump",
  "trust",
  "truth",
  "twice",
  "twist",
  "uncle",
  "under",
  "union",
  "unity",
  "until",
  "upper",
  "upset",
  "urban",
  "usage",
  "usual",
  "valid",
  "value",
  "video",
  "vinyl",
  "virus",
  "visit",
  "vital",
  "vocal",
  "voice",
  "waste",
  "watch",
  "water",
  "wheel",
  "where",
  "which",
  "while",
  "white",
  "whole",
  "whose",
  "widow",
  "width",
  "woman",
  "world",
  "worry",
  "worse",
  "worst",
  "worth",
  "would",
  "wound",
  "write",
  "wrong",
  "wrote",
  "yield",
  "young",
  "youth",
  "zebra",
  "zones",
];

// Wordle Game
class WordleGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "wordle";
    this.maxGuesses = 6;
    this.wordLength = 5;
    this.guesses = [];
    this.currentGuess = ["", "", "", "", ""];
    this.currentPos = 0; // Current letter position (0-4)
    this.currentLetter = 0; // Current letter index (0=A, 25=Z)
    this.targetWord = "";
    this.gameWon = false;
    this.usedLetters = {}; // Track letter states: 'correct', 'present', 'absent'
  }

  init() {
    // Pick a random word
    this.targetWord =
      WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)].toUpperCase();
    this.guesses = [];
    this.currentGuess = ["", "", "", "", ""];
    this.currentPos = 0;
    this.currentLetter = 0;
    this.gameWon = false;
    this.usedLetters = {};
    this.score = 0;
    this.lastKeyTime = 0;
    this.keyDelay = 150;
  }

  submitGuess() {
    // Check if guess is complete
    var complete = true;
    for (var i = 0; i < this.wordLength; i++) {
      if (!this.currentGuess[i]) {
        complete = false;
        break;
      }
    }
    if (!complete) return;

    var guess = this.currentGuess.join("");

    // Evaluate guess
    var result = [];
    var targetCopy = this.targetWord.split("");

    // First pass: find correct letters
    for (var i = 0; i < this.wordLength; i++) {
      if (this.currentGuess[i] === this.targetWord[i]) {
        result[i] = "correct";
        targetCopy[i] = null;
        this.usedLetters[this.currentGuess[i]] = "correct";
      }
    }

    // Second pass: find present letters
    for (var i = 0; i < this.wordLength; i++) {
      if (result[i]) continue;

      var idx = targetCopy.indexOf(this.currentGuess[i]);
      if (idx !== -1) {
        result[i] = "present";
        targetCopy[idx] = null;
        if (this.usedLetters[this.currentGuess[i]] !== "correct") {
          this.usedLetters[this.currentGuess[i]] = "present";
        }
      } else {
        result[i] = "absent";
        if (!this.usedLetters[this.currentGuess[i]]) {
          this.usedLetters[this.currentGuess[i]] = "absent";
        }
      }
    }

    this.guesses.push({
      letters: this.currentGuess.slice(),
      result: result,
    });

    // Check for win
    if (guess === this.targetWord) {
      this.gameWon = true;
      // Score based on attempts: 6 for first try, 5 for second, etc.
      this.score = (this.maxGuesses - this.guesses.length + 1) * 100;
      this.playSound("levelUp");
      this.gameOver();
      return;
    }

    // Check for loss
    if (this.guesses.length >= this.maxGuesses) {
      this.score = 0;
      this.playSound("gameOver");
      this.gameOver();
      return;
    }

    // Reset for next guess
    this.currentGuess = ["", "", "", "", ""];
    this.currentPos = 0;
    this.currentLetter = 0;
    this.playSound("move");
  }

  update() {
    if (this.isGameOver) return;

    var now = Date.now();
    if (now - this.lastKeyTime < this.keyDelay) return;

    // Navigation
    if (this.keys["ArrowLeft"] || this.keys[37]) {
      this.currentPos = Math.max(0, this.currentPos - 1);
      this.currentLetter = this.currentGuess[this.currentPos]
        ? this.currentGuess[this.currentPos].charCodeAt(0) - 65
        : 0;
      this.lastKeyTime = now;
      this.keys["ArrowLeft"] = false;
      this.keys[37] = false;
    } else if (this.keys["ArrowRight"] || this.keys[39]) {
      this.currentPos = Math.min(this.wordLength - 1, this.currentPos + 1);
      this.currentLetter = this.currentGuess[this.currentPos]
        ? this.currentGuess[this.currentPos].charCodeAt(0) - 65
        : 0;
      this.lastKeyTime = now;
      this.keys["ArrowRight"] = false;
      this.keys[39] = false;
    } else if (this.keys["ArrowUp"] || this.keys[38]) {
      this.currentLetter = (this.currentLetter + 1) % 26;
      this.currentGuess[this.currentPos] = String.fromCharCode(
        65 + this.currentLetter
      );
      this.lastKeyTime = now;
      this.keys["ArrowUp"] = false;
      this.keys[38] = false;
    } else if (this.keys["ArrowDown"] || this.keys[40]) {
      this.currentLetter = (this.currentLetter - 1 + 26) % 26;
      this.currentGuess[this.currentPos] = String.fromCharCode(
        65 + this.currentLetter
      );
      this.lastKeyTime = now;
      this.keys["ArrowDown"] = false;
      this.keys[40] = false;
    } else if (this.keys["Enter"] || this.keys[13] || this.keys["action"]) {
      this.submitGuess();
      this.lastKeyTime = now;
      this.keys["Enter"] = false;
      this.keys[13] = false;
      this.keys["action"] = false;
    }
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Background
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("WORDLE", canvas.width / 2, 22);

    // Draw grid - smaller tiles to fit
    var tileSize = 40;
    var gap = 4;
    var startX =
      (canvas.width -
        (this.wordLength * tileSize + (this.wordLength - 1) * gap)) /
      2;
    var startY = 35;

    // Draw previous guesses
    for (var row = 0; row < this.guesses.length; row++) {
      var guess = this.guesses[row];
      for (var col = 0; col < this.wordLength; col++) {
        var x = startX + col * (tileSize + gap);
        var y = startY + row * (tileSize + gap);

        // Tile background based on result
        if (guess.result[col] === "correct") {
          ctx.fillStyle = "#22c55e";
        } else if (guess.result[col] === "present") {
          ctx.fillStyle = "#eab308";
        } else {
          ctx.fillStyle = "#3f3f46";
        }
        ctx.fillRect(x, y, tileSize, tileSize);

        // Letter
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 22px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          guess.letters[col],
          x + tileSize / 2,
          y + tileSize / 2 + 8
        );
      }
    }

    // Draw current guess row (if game not over)
    if (!this.isGameOver && this.guesses.length < this.maxGuesses) {
      var row = this.guesses.length;
      for (var col = 0; col < this.wordLength; col++) {
        var x = startX + col * (tileSize + gap);
        var y = startY + row * (tileSize + gap);

        // Tile background
        var isActive = col === this.currentPos;
        ctx.fillStyle = isActive ? "#7c3aed" : "#27272a";
        ctx.fillRect(x, y, tileSize, tileSize);

        // Border for active
        if (isActive) {
          ctx.strokeStyle = "#f97316";
          ctx.lineWidth = 3;
          ctx.strokeRect(x, y, tileSize, tileSize);
        }

        // Letter
        if (this.currentGuess[col]) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 22px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(
            this.currentGuess[col],
            x + tileSize / 2,
            y + tileSize / 2 + 8
          );
        }
      }

      // Draw remaining empty rows
      for (var r = row + 1; r < this.maxGuesses; r++) {
        for (var col = 0; col < this.wordLength; col++) {
          var x = startX + col * (tileSize + gap);
          var y = startY + r * (tileSize + gap);
          ctx.fillStyle = "#18181b";
          ctx.fillRect(x, y, tileSize, tileSize);
          ctx.strokeStyle = "#27272a";
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, tileSize, tileSize);
        }
      }
    }

    // Draw keyboard hint
    var kbY = startY + this.maxGuesses * (tileSize + gap) + 10;
    ctx.fillStyle = "#71717a";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Arrows to select, ENTER to submit", canvas.width / 2, kbY);

    // Draw mini keyboard showing used letters
    var kbStartY = kbY + 12;
    var keySize = 18;
    var keyGap = 2;
    var rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

    for (var r = 0; r < rows.length; r++) {
      var rowLetters = rows[r];
      var rowStartX =
        (canvas.width -
          (rowLetters.length * keySize + (rowLetters.length - 1) * keyGap)) /
        2;

      for (var k = 0; k < rowLetters.length; k++) {
        var letter = rowLetters[k];
        var kx = rowStartX + k * (keySize + keyGap);
        var ky = kbStartY + r * (keySize + keyGap);

        // Key background based on state
        var state = this.usedLetters[letter];
        if (state === "correct") {
          ctx.fillStyle = "#22c55e";
        } else if (state === "present") {
          ctx.fillStyle = "#eab308";
        } else if (state === "absent") {
          ctx.fillStyle = "#3f3f46";
        } else {
          ctx.fillStyle = "#52525b";
        }
        ctx.fillRect(kx, ky, keySize, keySize);

        // Letter
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(letter, kx + keySize / 2, ky + keySize / 2 + 4);
      }
    }

    // Game over message
    if (this.isGameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = this.gameWon ? "#22c55e" : "#ef4444";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        this.gameWon ? "YOU WIN!" : "GAME OVER",
        canvas.width / 2,
        canvas.height / 2 - 20
      );

      ctx.fillStyle = "#f4f4f5";
      ctx.font = "20px sans-serif";
      ctx.fillText(
        "The word was: " + this.targetWord,
        canvas.width / 2,
        canvas.height / 2 + 20
      );
      ctx.fillText(
        "Score: " + this.score,
        canvas.width / 2,
        canvas.height / 2 + 50
      );
    }
  }
}

// Hangman Game
class HangmanGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "hangman";
    this.maxWrong = 6;
    this.wrongGuesses = 0;
    this.targetWord = "";
    this.guessedLetters = [];
    this.keyboardRow = 0;
    this.keyboardCol = 0;
    this.keyboard = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
    this.revealed = [];
  }

  init() {
    // Pick a random word (use longer words from list for hangman)
    var longerWords = [];
    for (var i = 0; i < WORD_LIST.length; i++) {
      if (WORD_LIST[i].length >= 5) {
        longerWords.push(WORD_LIST[i]);
      }
    }
    this.targetWord =
      longerWords[Math.floor(Math.random() * longerWords.length)].toUpperCase();
    this.wrongGuesses = 0;
    this.guessedLetters = [];
    this.keyboardRow = 0;
    this.keyboardCol = 0;
    this.revealed = [];
    for (var i = 0; i < this.targetWord.length; i++) {
      this.revealed.push(false);
    }
    this.score = 0;
    this.lastKeyTime = 0;
    this.keyDelay = 150;
  }

  update() {
    if (this.isGameOver) return;

    var now = Date.now();
    if (now - this.lastKeyTime < this.keyDelay) return;

    // Keyboard navigation
    if (this.keys["ArrowLeft"] || this.keys[37]) {
      this.keyboardCol = Math.max(0, this.keyboardCol - 1);
      this.lastKeyTime = now;
      this.keys["ArrowLeft"] = false;
      this.keys[37] = false;
    } else if (this.keys["ArrowRight"] || this.keys[39]) {
      this.keyboardCol = Math.min(
        this.keyboard[this.keyboardRow].length - 1,
        this.keyboardCol + 1
      );
      this.lastKeyTime = now;
      this.keys["ArrowRight"] = false;
      this.keys[39] = false;
    } else if (this.keys["ArrowUp"] || this.keys[38]) {
      this.keyboardRow = Math.max(0, this.keyboardRow - 1);
      this.keyboardCol = Math.min(
        this.keyboardCol,
        this.keyboard[this.keyboardRow].length - 1
      );
      this.lastKeyTime = now;
      this.keys["ArrowUp"] = false;
      this.keys[38] = false;
    } else if (this.keys["ArrowDown"] || this.keys[40]) {
      this.keyboardRow = Math.min(
        this.keyboard.length - 1,
        this.keyboardRow + 1
      );
      this.keyboardCol = Math.min(
        this.keyboardCol,
        this.keyboard[this.keyboardRow].length - 1
      );
      this.lastKeyTime = now;
      this.keys["ArrowDown"] = false;
      this.keys[40] = false;
    } else if (this.keys["Enter"] || this.keys[13] || this.keys["action"]) {
      this.guessLetter();
      this.lastKeyTime = now;
      this.keys["Enter"] = false;
      this.keys[13] = false;
      this.keys["action"] = false;
    }
  }

  guessLetter() {
    var letter = this.keyboard[this.keyboardRow][this.keyboardCol];

    // Check if already guessed
    if (this.guessedLetters.indexOf(letter) !== -1) return;

    this.guessedLetters.push(letter);

    // Check if letter is in word
    var found = false;
    for (var i = 0; i < this.targetWord.length; i++) {
      if (this.targetWord[i] === letter) {
        this.revealed[i] = true;
        found = true;
      }
    }

    if (found) {
      this.playSound("score");
      // Check for win
      var allRevealed = true;
      for (var i = 0; i < this.revealed.length; i++) {
        if (!this.revealed[i]) {
          allRevealed = false;
          break;
        }
      }
      if (allRevealed) {
        // Score based on remaining wrong guesses
        this.score =
          (this.maxWrong - this.wrongGuesses) * 100 +
          this.targetWord.length * 10;
        this.playSound("levelUp");
        this.gameOver();
      }
    } else {
      this.wrongGuesses++;
      this.playSound("hit");
      if (this.wrongGuesses >= this.maxWrong) {
        this.score = 0;
        this.playSound("gameOver");
        this.gameOver();
      }
    }
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Background
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("HANGMAN", canvas.width / 2, 30);

    // Draw gallows and hangman
    var gallowsX = 100;
    var gallowsY = 60;
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";

    // Base
    ctx.beginPath();
    ctx.moveTo(gallowsX - 40, gallowsY + 150);
    ctx.lineTo(gallowsX + 60, gallowsY + 150);
    ctx.stroke();

    // Pole
    ctx.beginPath();
    ctx.moveTo(gallowsX, gallowsY + 150);
    ctx.lineTo(gallowsX, gallowsY);
    ctx.lineTo(gallowsX + 60, gallowsY);
    ctx.lineTo(gallowsX + 60, gallowsY + 20);
    ctx.stroke();

    // Draw hangman parts based on wrong guesses
    ctx.strokeStyle = "#f97316";
    ctx.fillStyle = "#f97316";

    if (this.wrongGuesses >= 1) {
      // Head
      ctx.beginPath();
      ctx.arc(gallowsX + 60, gallowsY + 35, 15, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.wrongGuesses >= 2) {
      // Body
      ctx.beginPath();
      ctx.moveTo(gallowsX + 60, gallowsY + 50);
      ctx.lineTo(gallowsX + 60, gallowsY + 100);
      ctx.stroke();
    }
    if (this.wrongGuesses >= 3) {
      // Left arm
      ctx.beginPath();
      ctx.moveTo(gallowsX + 60, gallowsY + 60);
      ctx.lineTo(gallowsX + 40, gallowsY + 80);
      ctx.stroke();
    }
    if (this.wrongGuesses >= 4) {
      // Right arm
      ctx.beginPath();
      ctx.moveTo(gallowsX + 60, gallowsY + 60);
      ctx.lineTo(gallowsX + 80, gallowsY + 80);
      ctx.stroke();
    }
    if (this.wrongGuesses >= 5) {
      // Left leg
      ctx.beginPath();
      ctx.moveTo(gallowsX + 60, gallowsY + 100);
      ctx.lineTo(gallowsX + 40, gallowsY + 130);
      ctx.stroke();
    }
    if (this.wrongGuesses >= 6) {
      // Right leg
      ctx.beginPath();
      ctx.moveTo(gallowsX + 60, gallowsY + 100);
      ctx.lineTo(gallowsX + 80, gallowsY + 130);
      ctx.stroke();
    }

    // Draw word blanks
    var wordY = 240;
    var letterWidth = 30;
    var letterGap = 8;
    var wordWidth =
      this.targetWord.length * letterWidth +
      (this.targetWord.length - 1) * letterGap;
    var wordStartX = (canvas.width - wordWidth) / 2;

    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";

    for (var i = 0; i < this.targetWord.length; i++) {
      var x = wordStartX + i * (letterWidth + letterGap);

      // Underline
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, wordY);
      ctx.lineTo(x + letterWidth, wordY);
      ctx.stroke();

      // Letter (if revealed or game over)
      if (this.revealed[i] || this.isGameOver) {
        ctx.fillStyle = this.revealed[i] ? "#22c55e" : "#ef4444";
        ctx.fillText(this.targetWord[i], x + letterWidth / 2, wordY - 8);
      }
    }

    // Draw keyboard
    var kbStartY = 270;
    var keySize = 32;
    var keyGap = 4;

    for (var r = 0; r < this.keyboard.length; r++) {
      var rowLetters = this.keyboard[r];
      var rowStartX =
        (canvas.width -
          (rowLetters.length * keySize + (rowLetters.length - 1) * keyGap)) /
        2;

      for (var k = 0; k < rowLetters.length; k++) {
        var letter = rowLetters[k];
        var kx = rowStartX + k * (keySize + keyGap);
        var ky = kbStartY + r * (keySize + keyGap);

        var isSelected = r === this.keyboardRow && k === this.keyboardCol;
        var isGuessed = this.guessedLetters.indexOf(letter) !== -1;
        var isCorrect = isGuessed && this.targetWord.indexOf(letter) !== -1;

        // Key background
        if (isGuessed) {
          ctx.fillStyle = isCorrect ? "#22c55e" : "#3f3f46";
        } else if (isSelected) {
          ctx.fillStyle = "#7c3aed";
        } else {
          ctx.fillStyle = "#52525b";
        }
        ctx.fillRect(kx, ky, keySize, keySize);

        // Selection border
        if (isSelected && !this.isGameOver) {
          ctx.strokeStyle = "#f97316";
          ctx.lineWidth = 3;
          ctx.strokeRect(kx, ky, keySize, keySize);
        }

        // Letter
        ctx.fillStyle = isGuessed ? "#a1a1aa" : "#ffffff";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(letter, kx + keySize / 2, ky + keySize / 2 + 6);
      }
    }

    // Instructions
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "Use arrows to select, ENTER to guess",
      canvas.width / 2,
      canvas.height - 15
    );

    // Wrong guesses counter
    ctx.fillStyle = "#ef4444";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      "Wrong: " + this.wrongGuesses + "/" + this.maxWrong,
      10,
      canvas.height - 15
    );

    // Game over overlay
    if (this.isGameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      var won = this.wrongGuesses < this.maxWrong;
      ctx.fillStyle = won ? "#22c55e" : "#ef4444";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        won ? "YOU WIN!" : "GAME OVER",
        canvas.width / 2,
        canvas.height / 2 - 20
      );

      ctx.fillStyle = "#f4f4f5";
      ctx.font = "20px sans-serif";
      ctx.fillText(
        "The word was: " + this.targetWord,
        canvas.width / 2,
        canvas.height / 2 + 20
      );
      ctx.fillText(
        "Score: " + this.score,
        canvas.width / 2,
        canvas.height / 2 + 50
      );
    }
  }
}

// Tower Builder Game - Stack blocks as high as possible
class TowerBuilderGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "tower";
    this.blockWidth = 100;
    this.blockHeight = 25;
    this.blocks = [];
    this.currentBlock = null;
    this.direction = 1;
    this.speed = 3;
    this.groundY = 0;
  }

  init() {
    this.groundY = this.canvas.height - 30;
    this.blocks = [];
    this.score = 0;
    this.blockWidth = 100;
    this.speed = 3;

    // First block is placed at center
    this.blocks.push({
      x: (this.canvas.width - this.blockWidth) / 2,
      y: this.groundY - this.blockHeight,
      width: this.blockWidth,
    });

    this.spawnNewBlock();
  }

  spawnNewBlock() {
    var topBlock = this.blocks[this.blocks.length - 1];
    this.currentBlock = {
      x: 0,
      y: topBlock.y - this.blockHeight,
      width: topBlock.width,
    };
    this.direction = 1;

    // Increase speed slightly each level
    this.speed = 3 + Math.floor(this.blocks.length / 3);
    if (this.speed > 12) this.speed = 12;
  }

  dropBlock() {
    if (!this.currentBlock) return;

    var topBlock = this.blocks[this.blocks.length - 1];
    var curr = this.currentBlock;

    // Calculate overlap
    var overlapLeft = Math.max(curr.x, topBlock.x);
    var overlapRight = Math.min(
      curr.x + curr.width,
      topBlock.x + topBlock.width
    );
    var overlapWidth = overlapRight - overlapLeft;

    if (overlapWidth <= 0) {
      // Missed completely - game over
      this.playSound("gameOver");
      this.gameOver();
      return;
    }

    // Perfect placement bonus
    if (Math.abs(curr.x - topBlock.x) < 5) {
      overlapWidth = topBlock.width; // Perfect - keep full width
      overlapLeft = topBlock.x;
      this.score += 50; // Bonus for perfect
      this.playSound("levelUp");
    } else {
      this.score += 10;
      this.playSound("score");
    }

    // Add the placed block
    this.blocks.push({
      x: overlapLeft,
      y: curr.y,
      width: overlapWidth,
    });

    // Check if block is too small
    if (overlapWidth < 10) {
      this.playSound("gameOver");
      this.gameOver();
      return;
    }

    // Scroll down if getting too high
    if (curr.y < 100) {
      for (var i = 0; i < this.blocks.length; i++) {
        this.blocks[i].y += this.blockHeight;
      }
    }

    this.spawnNewBlock();
  }

  update() {
    if (this.isGameOver || !this.currentBlock) return;

    // Check for drop input
    if (
      this.keys["Enter"] ||
      this.keys[13] ||
      this.keys["action"] ||
      this.keys["ArrowDown"] ||
      this.keys[40]
    ) {
      this.dropBlock();
      this.keys["Enter"] = false;
      this.keys[13] = false;
      this.keys["action"] = false;
      this.keys["ArrowDown"] = false;
      this.keys[40] = false;
    }

    // Move current block
    this.currentBlock.x += this.speed * this.direction;

    // Bounce off walls
    if (this.currentBlock.x + this.currentBlock.width > this.canvas.width) {
      this.currentBlock.x = this.canvas.width - this.currentBlock.width;
      this.direction = -1;
    } else if (this.currentBlock.x < 0) {
      this.currentBlock.x = 0;
      this.direction = 1;
    }
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Sky gradient background
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Ground
    ctx.fillStyle = "#3f3f46";
    ctx.fillRect(0, this.groundY, canvas.width, canvas.height - this.groundY);

    // Draw placed blocks
    var colors = [
      "#f97316",
      "#a78bfa",
      "#22c55e",
      "#3b82f6",
      "#eab308",
      "#ec4899",
    ];
    for (var i = 0; i < this.blocks.length; i++) {
      var block = this.blocks[i];
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(block.x, block.y, block.width, this.blockHeight - 2);

      // Block border
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(block.x, block.y, block.width, this.blockHeight - 2);
    }

    // Draw current block
    if (this.currentBlock && !this.isGameOver) {
      ctx.fillStyle = colors[this.blocks.length % colors.length];
      ctx.fillRect(
        this.currentBlock.x,
        this.currentBlock.y,
        this.currentBlock.width,
        this.blockHeight - 2
      );
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        this.currentBlock.x,
        this.currentBlock.y,
        this.currentBlock.width,
        this.blockHeight - 2
      );
    }

    // UI
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Score: " + this.score, 10, 30);
    ctx.fillText("Height: " + this.blocks.length, 10, 55);

    // Instructions
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "Press ENTER or DOWN to drop block",
      canvas.width / 2,
      canvas.height - 8
    );
  }
}

// Endless Runner Game
class EndlessRunnerGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "runner";
    this.player = { x: 80, y: 0, vy: 0, jumping: false, ducking: false };
    this.groundY = 0;
    this.obstacles = [];
    this.clouds = [];
    this.gameSpeed = 5;
    this.distance = 0;
    this.jumpForce = -12;
    this.gravity = 0.6;
  }

  init() {
    this.groundY = this.canvas.height - 60;
    this.player = {
      x: 80,
      y: this.groundY - 40,
      vy: 0,
      jumping: false,
      ducking: false,
      width: 30,
      height: 40,
    };
    this.obstacles = [];
    this.clouds = [];
    this.gameSpeed = 5;
    this.distance = 0;
    this.score = 0;
    this.lastObstacle = 0;

    // Initial clouds
    for (var i = 0; i < 5; i++) {
      this.clouds.push({
        x: Math.random() * this.canvas.width,
        y: 30 + Math.random() * 80,
        size: 20 + Math.random() * 30,
      });
    }
  }

  update() {
    if (this.isGameOver) return;

    // Handle jump input
    if (
      (this.keys["ArrowUp"] ||
        this.keys[38] ||
        this.keys["Enter"] ||
        this.keys[13] ||
        this.keys["action"]) &&
      !this.player.jumping
    ) {
      this.player.jumping = true;
      this.player.vy = this.jumpForce;
      this.playSound("jump");
    }

    // Handle duck input
    if (this.keys["ArrowDown"] || this.keys[40]) {
      if (!this.player.ducking) {
        this.player.ducking = true;
        this.player.height = 20;
        this.player.y = this.groundY - 20;
      }
    } else {
      if (this.player.ducking && !this.player.jumping) {
        this.player.ducking = false;
        this.player.height = 40;
        this.player.y = this.groundY - 40;
      }
    }

    // Update distance and score
    this.distance += this.gameSpeed;
    this.score = Math.floor(this.distance / 10);

    // Increase speed over time
    this.gameSpeed = 5 + Math.floor(this.distance / 500);
    if (this.gameSpeed > 15) this.gameSpeed = 15;

    // Player physics
    if (this.player.jumping) {
      this.player.vy += this.gravity;
      this.player.y += this.player.vy;

      var groundLevel = this.groundY - (this.player.ducking ? 20 : 40);
      if (this.player.y >= groundLevel) {
        this.player.y = groundLevel;
        this.player.jumping = false;
        this.player.vy = 0;
        this.player.height = this.player.ducking ? 20 : 40;
      }
    }

    // Spawn obstacles
    if (this.distance - this.lastObstacle > 150 + Math.random() * 200) {
      var type = Math.random();
      if (type < 0.6) {
        // Ground obstacle (cactus-like)
        this.obstacles.push({
          x: this.canvas.width,
          y: this.groundY - 35,
          width: 20 + Math.random() * 20,
          height: 35,
          type: "ground",
        });
      } else {
        // Flying obstacle (bird-like)
        this.obstacles.push({
          x: this.canvas.width,
          y: this.groundY - 60 - Math.random() * 40,
          width: 35,
          height: 20,
          type: "flying",
        });
      }
      this.lastObstacle = this.distance;
    }

    // Update obstacles
    for (var i = this.obstacles.length - 1; i >= 0; i--) {
      this.obstacles[i].x -= this.gameSpeed;
      if (this.obstacles[i].x + this.obstacles[i].width < 0) {
        this.obstacles.splice(i, 1);
      }
    }

    // Update clouds
    for (var i = 0; i < this.clouds.length; i++) {
      this.clouds[i].x -= this.gameSpeed * 0.3;
      if (this.clouds[i].x + this.clouds[i].size < 0) {
        this.clouds[i].x = this.canvas.width + this.clouds[i].size;
        this.clouds[i].y = 30 + Math.random() * 80;
      }
    }

    // Collision detection
    for (var i = 0; i < this.obstacles.length; i++) {
      var obs = this.obstacles[i];
      if (
        this.player.x < obs.x + obs.width &&
        this.player.x + this.player.width > obs.x &&
        this.player.y < obs.y + obs.height &&
        this.player.y + this.player.height > obs.y
      ) {
        this.playSound("gameOver");
        this.gameOver();
        return;
      }
    }
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Sky
    ctx.fillStyle = "#1a1025";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Clouds
    ctx.fillStyle = "#2d1f42";
    for (var i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.size * 0.5, 0, Math.PI * 2);
      ctx.arc(
        c.x + c.size * 0.4,
        c.y - c.size * 0.1,
        c.size * 0.4,
        0,
        Math.PI * 2
      );
      ctx.arc(c.x + c.size * 0.8, c.y, c.size * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ground
    ctx.fillStyle = "#3f3f46";
    ctx.fillRect(0, this.groundY, canvas.width, canvas.height - this.groundY);

    // Ground line
    ctx.strokeStyle = "#52525b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, this.groundY);
    ctx.lineTo(canvas.width, this.groundY);
    ctx.stroke();

    // Player
    ctx.fillStyle = "#f97316";
    ctx.fillRect(
      this.player.x,
      this.player.y,
      this.player.width,
      this.player.height
    );

    // Player eye
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(this.player.x + 20, this.player.y + 8, 6, 6);
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(this.player.x + 23, this.player.y + 10, 3, 3);

    // Obstacles
    for (var i = 0; i < this.obstacles.length; i++) {
      var obs = this.obstacles[i];
      if (obs.type === "ground") {
        ctx.fillStyle = "#22c55e";
        ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
        // Spikes
        ctx.fillStyle = "#16a34a";
        ctx.beginPath();
        ctx.moveTo(obs.x, obs.y);
        ctx.lineTo(obs.x + obs.width / 2, obs.y - 10);
        ctx.lineTo(obs.x + obs.width, obs.y);
        ctx.fill();
      } else {
        // Flying obstacle
        ctx.fillStyle = "#a78bfa";
        ctx.beginPath();
        ctx.ellipse(
          obs.x + obs.width / 2,
          obs.y + obs.height / 2,
          obs.width / 2,
          obs.height / 2,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
        // Wings
        ctx.fillStyle = "#7c3aed";
        ctx.beginPath();
        ctx.moveTo(obs.x + 10, obs.y + 10);
        ctx.lineTo(obs.x - 5, obs.y - 5);
        ctx.lineTo(obs.x + 15, obs.y + 5);
        ctx.fill();
      }
    }

    // UI
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Score: " + this.score, 10, 30);

    // Speed indicator
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.fillText("Speed: " + this.gameSpeed, 10, 50);

    // Instructions
    ctx.textAlign = "center";
    ctx.fillText(
      "UP/ENTER to jump, DOWN to duck",
      canvas.width / 2,
      canvas.height - 8
    );
  }
}

// Word Scramble Game
class WordScrambleGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "scramble";
    this.targetWord = "";
    this.scrambled = [];
    this.currentArrangement = [];
    this.selectedIndex = 0;
    this.wordsCompleted = 0;
    this.timeLeft = 60;
    this.lastTick = 0;
  }

  init() {
    this.score = 0;
    this.wordsCompleted = 0;
    this.timeLeft = 60;
    this.lastTick = Date.now();
    this.lastKeyTime = 0;
    this.keyDelay = 150;
    this.newWord();
  }

  newWord() {
    // Pick a word (use 5-letter words for fair difficulty)
    this.targetWord =
      WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)].toUpperCase();

    // Scramble it
    var letters = this.targetWord.split("");
    // Fisher-Yates shuffle
    for (var i = letters.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = letters[i];
      letters[i] = letters[j];
      letters[j] = temp;
    }

    // Make sure it's actually scrambled
    if (letters.join("") === this.targetWord) {
      var temp = letters[0];
      letters[0] = letters[1];
      letters[1] = temp;
    }

    this.scrambled = letters.slice();
    this.currentArrangement = letters.slice();
    this.selectedIndex = 0;
  }

  checkWord() {
    var current = this.currentArrangement.join("");
    if (current === this.targetWord) {
      // Correct!
      this.wordsCompleted++;
      this.score += 100 + Math.floor(this.timeLeft * 2); // Bonus for time left
      this.timeLeft += 7; // Add 7 seconds for correct answer
      this.playSound("levelUp");
      this.newWord();
    } else {
      // Wrong - small penalty
      this.playSound("hit");
    }
  }

  update() {
    if (this.isGameOver) return;

    // Timer countdown
    var now = Date.now();
    if (now - this.lastTick >= 1000) {
      this.timeLeft--;
      this.lastTick = now;

      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.playSound("gameOver");
        this.gameOver();
      }
    }

    // Handle key input with debounce
    if (now - this.lastKeyTime < this.keyDelay) return;

    var len = this.currentArrangement.length;

    if (this.keys["ArrowLeft"] || this.keys[37]) {
      this.selectedIndex = (this.selectedIndex - 1 + len) % len;
      this.lastKeyTime = now;
      this.keys["ArrowLeft"] = false;
      this.keys[37] = false;
    } else if (this.keys["ArrowRight"] || this.keys[39]) {
      this.selectedIndex = (this.selectedIndex + 1) % len;
      this.lastKeyTime = now;
      this.keys["ArrowRight"] = false;
      this.keys[39] = false;
    } else if (this.keys["ArrowUp"] || this.keys[38]) {
      // Swap with previous
      var prev = (this.selectedIndex - 1 + len) % len;
      var temp = this.currentArrangement[this.selectedIndex];
      this.currentArrangement[this.selectedIndex] =
        this.currentArrangement[prev];
      this.currentArrangement[prev] = temp;
      this.selectedIndex = prev;
      this.playSound("move");
      this.lastKeyTime = now;
      this.keys["ArrowUp"] = false;
      this.keys[38] = false;
    } else if (this.keys["ArrowDown"] || this.keys[40]) {
      // Swap with next
      var next = (this.selectedIndex + 1) % len;
      var temp = this.currentArrangement[this.selectedIndex];
      this.currentArrangement[this.selectedIndex] =
        this.currentArrangement[next];
      this.currentArrangement[next] = temp;
      this.selectedIndex = next;
      this.playSound("move");
      this.lastKeyTime = now;
      this.keys["ArrowDown"] = false;
      this.keys[40] = false;
    } else if (this.keys["Enter"] || this.keys[13] || this.keys["action"]) {
      this.checkWord();
      this.lastKeyTime = now;
      this.keys["Enter"] = false;
      this.keys[13] = false;
      this.keys["action"] = false;
    }
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Background
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("WORD SCRAMBLE", canvas.width / 2, 35);

    // Stats
    ctx.font = "16px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#f4f4f5";
    ctx.fillText("Score: " + this.score, 20, 70);
    ctx.fillText("Words: " + this.wordsCompleted, 20, 95);

    // Timer
    ctx.textAlign = "right";
    ctx.fillStyle = this.timeLeft <= 10 ? "#ef4444" : "#22c55e";
    ctx.fillText("Time: " + this.timeLeft + "s", canvas.width - 20, 70);

    // Draw letter tiles
    var tileSize = 60;
    var gap = 10;
    var totalWidth =
      this.currentArrangement.length * tileSize +
      (this.currentArrangement.length - 1) * gap;
    var startX = (canvas.width - totalWidth) / 2;
    var startY = 150;

    for (var i = 0; i < this.currentArrangement.length; i++) {
      var x = startX + i * (tileSize + gap);
      var isSelected = i === this.selectedIndex;

      // Tile background
      ctx.fillStyle = isSelected ? "#7c3aed" : "#27272a";
      ctx.fillRect(x, startY, tileSize, tileSize);

      // Selection border
      if (isSelected) {
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, startY, tileSize, tileSize);
      }

      // Letter
      ctx.fillStyle = "#f4f4f5";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        this.currentArrangement[i],
        x + tileSize / 2,
        startY + tileSize / 2 + 12
      );
    }

    // Arrows hint
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "← → to select, ↑ ↓ to swap, ENTER to submit",
      canvas.width / 2,
      startY + tileSize + 40
    );

    // Hint: show first letter
    ctx.fillStyle = "#52525b";
    ctx.font = "16px sans-serif";
    ctx.fillText(
      "Hint: Starts with '" + this.targetWord[0] + "'",
      canvas.width / 2,
      startY + tileSize + 70
    );

    // Game over overlay
    if (this.isGameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#f97316";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("TIME'S UP!", canvas.width / 2, canvas.height / 2 - 40);

      ctx.fillStyle = "#f4f4f5";
      ctx.font = "20px sans-serif";
      ctx.fillText(
        "Words Unscrambled: " + this.wordsCompleted,
        canvas.width / 2,
        canvas.height / 2
      );
      ctx.fillText(
        "Final Score: " + this.score,
        canvas.width / 2,
        canvas.height / 2 + 35
      );
    }
  }
}

// Jet Fighter Game (1975 style)
class JetFighterGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "jetfighter";
    this.player = { x: 0, y: 0, angle: 0, speed: 0 };
    this.enemy = { x: 0, y: 0, angle: 0, speed: 2, alive: true };
    this.playerBullets = [];
    this.enemyBullets = [];
    this.enemyShootTimer = 0;
    this.turnSpeed = 4;
    this.maxSpeed = 5;
  }

  init() {
    this.player = {
      x: 100,
      y: this.canvas.height / 2,
      angle: 0,
      speed: 3,
    };
    this.enemy = {
      x: this.canvas.width - 100,
      y: this.canvas.height / 2,
      angle: 180,
      speed: 2,
      alive: true,
    };
    this.playerBullets = [];
    this.enemyBullets = [];
    this.score = 0;
    this.enemyShootTimer = 0;
    this.enemiesDefeated = 0;
    this.lastShootTime = 0;
    this.shootDelay = 200;
  }

  shoot(shooter, bullets) {
    var rad = (shooter.angle * Math.PI) / 180;
    bullets.push({
      x: shooter.x + Math.cos(rad) * 15,
      y: shooter.y + Math.sin(rad) * 15,
      vx: Math.cos(rad) * 8,
      vy: Math.sin(rad) * 8,
      life: 60,
    });
  }

  spawnEnemy() {
    var side = Math.floor(Math.random() * 4);
    var x, y, angle;

    if (side === 0) {
      x = 0;
      y = Math.random() * this.canvas.height;
      angle = 0;
    } else if (side === 1) {
      x = this.canvas.width;
      y = Math.random() * this.canvas.height;
      angle = 180;
    } else if (side === 2) {
      x = Math.random() * this.canvas.width;
      y = 0;
      angle = 90;
    } else {
      x = Math.random() * this.canvas.width;
      y = this.canvas.height;
      angle = 270;
    }

    this.enemy = {
      x: x,
      y: y,
      angle: angle,
      speed: 2 + this.enemiesDefeated * 0.3,
      alive: true,
    };
  }

  update() {
    if (this.isGameOver) return;

    // Handle continuous player input
    if (this.keys["ArrowLeft"] || this.keys[37]) {
      this.player.angle -= this.turnSpeed;
    }
    if (this.keys["ArrowRight"] || this.keys[39]) {
      this.player.angle += this.turnSpeed;
    }
    if (this.keys["ArrowUp"] || this.keys[38]) {
      this.player.speed = Math.min(this.player.speed + 0.1, this.maxSpeed);
    }
    if (this.keys["ArrowDown"] || this.keys[40]) {
      this.player.speed = Math.max(this.player.speed - 0.1, 1);
    }

    // Handle shooting with delay
    var now = Date.now();
    if (
      (this.keys["Enter"] || this.keys[13] || this.keys["action"]) &&
      now - this.lastShootTime > this.shootDelay
    ) {
      this.shoot(this.player, this.playerBullets);
      this.playSound("shoot");
      this.lastShootTime = now;
    }

    // Update player position
    var pRad = (this.player.angle * Math.PI) / 180;
    this.player.x += Math.cos(pRad) * this.player.speed;
    this.player.y += Math.sin(pRad) * this.player.speed;

    // Wrap around screen
    if (this.player.x < 0) this.player.x = this.canvas.width;
    if (this.player.x > this.canvas.width) this.player.x = 0;
    if (this.player.y < 0) this.player.y = this.canvas.height;
    if (this.player.y > this.canvas.height) this.player.y = 0;

    // Update enemy AI
    if (this.enemy.alive) {
      // Turn towards player
      var dx = this.player.x - this.enemy.x;
      var dy = this.player.y - this.enemy.y;
      var targetAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

      var angleDiff = targetAngle - this.enemy.angle;
      while (angleDiff > 180) angleDiff -= 360;
      while (angleDiff < -180) angleDiff += 360;

      if (angleDiff > 2) this.enemy.angle += 2;
      else if (angleDiff < -2) this.enemy.angle -= 2;

      // Move enemy
      var eRad = (this.enemy.angle * Math.PI) / 180;
      this.enemy.x += Math.cos(eRad) * this.enemy.speed;
      this.enemy.y += Math.sin(eRad) * this.enemy.speed;

      // Wrap around
      if (this.enemy.x < 0) this.enemy.x = this.canvas.width;
      if (this.enemy.x > this.canvas.width) this.enemy.x = 0;
      if (this.enemy.y < 0) this.enemy.y = this.canvas.height;
      if (this.enemy.y > this.canvas.height) this.enemy.y = 0;

      // Enemy shooting
      this.enemyShootTimer++;
      if (this.enemyShootTimer > 60) {
        this.shoot(this.enemy, this.enemyBullets);
        this.enemyShootTimer = 0;
      }
    }

    // Update bullets
    this.updateBullets(this.playerBullets);
    this.updateBullets(this.enemyBullets);

    // Check player bullets hitting enemy
    if (this.enemy.alive) {
      for (var i = this.playerBullets.length - 1; i >= 0; i--) {
        var b = this.playerBullets[i];
        var dx = b.x - this.enemy.x;
        var dy = b.y - this.enemy.y;
        if (dx * dx + dy * dy < 400) {
          this.enemy.alive = false;
          this.score += 100;
          this.enemiesDefeated++;
          this.playerBullets.splice(i, 1);
          this.playSound("explosion");

          // Spawn new enemy after delay
          var self = this;
          setTimeout(function () {
            self.spawnEnemy();
          }, 1500);
          break;
        }
      }
    }

    // Check enemy bullets hitting player
    for (var i = this.enemyBullets.length - 1; i >= 0; i--) {
      var b = this.enemyBullets[i];
      var dx = b.x - this.player.x;
      var dy = b.y - this.player.y;
      if (dx * dx + dy * dy < 400) {
        this.playSound("gameOver");
        this.gameOver();
        return;
      }
    }
  }

  updateBullets(bullets) {
    for (var i = bullets.length - 1; i >= 0; i--) {
      bullets[i].x += bullets[i].vx;
      bullets[i].y += bullets[i].vy;
      bullets[i].life--;

      if (
        bullets[i].life <= 0 ||
        bullets[i].x < 0 ||
        bullets[i].x > this.canvas.width ||
        bullets[i].y < 0 ||
        bullets[i].y > this.canvas.height
      ) {
        bullets.splice(i, 1);
      }
    }
  }

  drawJet(x, y, angle, color) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((angle * Math.PI) / 180);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(-10, -8);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-10, 8);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Dark sky
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Stars
    ctx.fillStyle = "#ffffff";
    for (var i = 0; i < 50; i++) {
      var sx = (i * 127) % canvas.width;
      var sy = (i * 89) % canvas.height;
      ctx.fillRect(sx, sy, 1, 1);
    }

    // Draw bullets
    ctx.fillStyle = "#f97316";
    for (var i = 0; i < this.playerBullets.length; i++) {
      var b = this.playerBullets[i];
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#ef4444";
    for (var i = 0; i < this.enemyBullets.length; i++) {
      var b = this.enemyBullets[i];
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw player
    this.drawJet(this.player.x, this.player.y, this.player.angle, "#22c55e");

    // Draw enemy
    if (this.enemy.alive) {
      this.drawJet(this.enemy.x, this.enemy.y, this.enemy.angle, "#ef4444");
    }

    // UI
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Score: " + this.score, 10, 30);
    ctx.fillText("Kills: " + this.enemiesDefeated, 10, 55);

    // Instructions
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "← → turn, ↑ ↓ speed, ENTER to shoot",
      canvas.width / 2,
      canvas.height - 10
    );
  }
}

// Grid Lock / Traffic Jam Game
class GridLockGame extends BaseGame {
  constructor(canvas, ctx) {
    super(canvas, ctx);
    this.gameId = "gridlock";
    this.gridSize = 6;
    this.cellSize = 50;
    this.cars = [];
    this.selectedCar = -1;
    this.targetCar = 0;
    this.level = 1;
    this.moves = 0;
  }

  init() {
    this.level = 1;
    this.score = 0;
    this.moves = 0;
    this.lastKeyTime = 0;
    this.keyDelay = 200;
    this.loadLevel(this.level);
  }

  loadLevel(level) {
    this.cars = [];
    this.selectedCar = 0;
    this.moves = 0;

    // Level designs (row, col, length, horizontal, isTarget)
    var levels = [
      // Level 1 - Easy
      [
        { row: 2, col: 0, len: 2, horiz: true, target: true },
        { row: 0, col: 0, len: 2, horiz: false },
        { row: 0, col: 2, len: 3, horiz: false },
        { row: 3, col: 1, len: 2, horiz: false },
        { row: 4, col: 3, len: 3, horiz: true },
      ],
      // Level 2
      [
        { row: 2, col: 1, len: 2, horiz: true, target: true },
        { row: 0, col: 0, len: 3, horiz: false },
        { row: 0, col: 3, len: 2, horiz: true },
        { row: 1, col: 4, len: 3, horiz: false },
        { row: 3, col: 0, len: 2, horiz: true },
        { row: 4, col: 2, len: 2, horiz: false },
        { row: 5, col: 3, len: 3, horiz: true },
      ],
      // Level 3
      [
        { row: 2, col: 0, len: 2, horiz: true, target: true },
        { row: 0, col: 2, len: 2, horiz: true },
        { row: 0, col: 4, len: 3, horiz: false },
        { row: 1, col: 0, len: 2, horiz: false },
        { row: 1, col: 2, len: 2, horiz: false },
        { row: 3, col: 1, len: 3, horiz: true },
        { row: 4, col: 0, len: 2, horiz: true },
        { row: 4, col: 3, len: 2, horiz: false },
        { row: 5, col: 1, len: 2, horiz: true },
      ],
      // Level 4
      [
        { row: 2, col: 1, len: 2, horiz: true, target: true },
        { row: 0, col: 0, len: 2, horiz: true },
        { row: 0, col: 3, len: 3, horiz: false },
        { row: 1, col: 0, len: 2, horiz: false },
        { row: 1, col: 1, len: 2, horiz: true },
        { row: 3, col: 0, len: 3, horiz: true },
        { row: 3, col: 4, len: 3, horiz: false },
        { row: 4, col: 1, len: 2, horiz: false },
        { row: 5, col: 2, len: 2, horiz: true },
      ],
      // Level 5
      [
        { row: 2, col: 0, len: 2, horiz: true, target: true },
        { row: 0, col: 0, len: 2, horiz: false },
        { row: 0, col: 1, len: 2, horiz: true },
        { row: 0, col: 4, len: 2, horiz: false },
        { row: 1, col: 3, len: 2, horiz: true },
        { row: 2, col: 2, len: 3, horiz: false },
        { row: 2, col: 4, len: 2, horiz: false },
        { row: 3, col: 0, len: 2, horiz: true },
        { row: 4, col: 1, len: 3, horiz: false },
        { row: 4, col: 3, len: 3, horiz: true },
        { row: 5, col: 0, len: 2, horiz: true },
      ],
    ];

    var levelData = levels[(level - 1) % levels.length];
    var colors = [
      "#ef4444",
      "#3b82f6",
      "#22c55e",
      "#eab308",
      "#a78bfa",
      "#ec4899",
      "#14b8a6",
      "#f97316",
    ];

    for (var i = 0; i < levelData.length; i++) {
      var d = levelData[i];
      this.cars.push({
        row: d.row,
        col: d.col,
        length: d.len,
        horizontal: d.horiz,
        isTarget: d.target || false,
        color: d.target ? "#ef4444" : colors[(i + 1) % colors.length],
      });
      if (d.target) this.targetCar = i;
    }
  }

  update() {
    if (this.isGameOver) return;

    var now = Date.now();
    if (now - this.lastKeyTime < this.keyDelay) return;

    var car = this.cars[this.selectedCar];
    if (!car) return;

    if (this.keys["ArrowUp"] || this.keys[38]) {
      if (car.horizontal) {
        this.selectedCar =
          (this.selectedCar - 1 + this.cars.length) % this.cars.length;
      } else {
        this.tryMove(car, -1);
      }
      this.lastKeyTime = now;
      this.keys["ArrowUp"] = false;
      this.keys[38] = false;
    } else if (this.keys["ArrowDown"] || this.keys[40]) {
      if (car.horizontal) {
        this.selectedCar = (this.selectedCar + 1) % this.cars.length;
      } else {
        this.tryMove(car, 1);
      }
      this.lastKeyTime = now;
      this.keys["ArrowDown"] = false;
      this.keys[40] = false;
    } else if (this.keys["ArrowLeft"] || this.keys[37]) {
      if (car.horizontal) {
        this.tryMove(car, -1);
      } else {
        this.selectedCar =
          (this.selectedCar - 1 + this.cars.length) % this.cars.length;
      }
      this.lastKeyTime = now;
      this.keys["ArrowLeft"] = false;
      this.keys[37] = false;
    } else if (this.keys["ArrowRight"] || this.keys[39]) {
      if (car.horizontal) {
        this.tryMove(car, 1);
      } else {
        this.selectedCar = (this.selectedCar + 1) % this.cars.length;
      }
      this.lastKeyTime = now;
      this.keys["ArrowRight"] = false;
      this.keys[39] = false;
    } else if (this.keys["Enter"] || this.keys[13] || this.keys["action"]) {
      this.selectedCar = (this.selectedCar + 1) % this.cars.length;
      this.playSound("move");
      this.lastKeyTime = now;
      this.keys["Enter"] = false;
      this.keys[13] = false;
      this.keys["action"] = false;
    }
  }

  tryMove(car, dir) {
    var newRow = car.row;
    var newCol = car.col;

    if (car.horizontal) {
      newCol += dir;
      // Check bounds
      if (newCol < 0 || newCol + car.length > this.gridSize) return;
    } else {
      newRow += dir;
      if (newRow < 0 || newRow + car.length > this.gridSize) return;
    }

    // Check collision with other cars
    for (var i = 0; i < this.cars.length; i++) {
      if (this.cars[i] === car) continue;
      if (this.carsOverlap(car, newRow, newCol, this.cars[i])) return;
    }

    // Move is valid
    car.row = newRow;
    car.col = newCol;
    this.moves++;
    this.playSound("move");

    // Check win condition - target car exits right
    var targetCar = this.cars[this.targetCar];
    if (
      targetCar.horizontal &&
      targetCar.col + targetCar.length >= this.gridSize
    ) {
      // Level complete!
      this.score += Math.max(100 - this.moves * 2, 10);
      this.playSound("levelUp");
      this.level++;

      if (this.level > 5) {
        // All levels complete
        this.score += 500;
        this.gameOver();
      } else {
        this.loadLevel(this.level);
      }
    }
  }

  carsOverlap(car, newRow, newCol, other) {
    var car1Cells = [];
    for (var i = 0; i < car.length; i++) {
      if (car.horizontal) {
        car1Cells.push({ r: newRow, c: newCol + i });
      } else {
        car1Cells.push({ r: newRow + i, c: newCol });
      }
    }

    for (var i = 0; i < other.length; i++) {
      var or = other.horizontal ? other.row : other.row + i;
      var oc = other.horizontal ? other.col + i : other.col;

      for (var j = 0; j < car1Cells.length; j++) {
        if (car1Cells[j].r === or && car1Cells[j].c === oc) return true;
      }
    }
    return false;
  }

  draw() {
    var ctx = this.ctx;
    var canvas = this.canvas;

    // Background
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid
    var offsetX = (canvas.width - this.gridSize * this.cellSize) / 2;
    var offsetY = 60;

    // Grid background
    ctx.fillStyle = "#1a1025";
    ctx.fillRect(
      offsetX,
      offsetY,
      this.gridSize * this.cellSize,
      this.gridSize * this.cellSize
    );

    // Grid lines
    ctx.strokeStyle = "#2d1f42";
    ctx.lineWidth = 1;
    for (var i = 0; i <= this.gridSize; i++) {
      ctx.beginPath();
      ctx.moveTo(offsetX + i * this.cellSize, offsetY);
      ctx.lineTo(
        offsetX + i * this.cellSize,
        offsetY + this.gridSize * this.cellSize
      );
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(offsetX, offsetY + i * this.cellSize);
      ctx.lineTo(
        offsetX + this.gridSize * this.cellSize,
        offsetY + i * this.cellSize
      );
      ctx.stroke();
    }

    // Exit marker
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(
      offsetX + this.gridSize * this.cellSize,
      offsetY + 2 * this.cellSize + 10,
      15,
      this.cellSize - 20
    );
    ctx.fillStyle = "#ffffff";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "→",
      offsetX + this.gridSize * this.cellSize + 7,
      offsetY + 2 * this.cellSize + 35
    );

    // Draw cars
    for (var i = 0; i < this.cars.length; i++) {
      var car = this.cars[i];
      var x = offsetX + car.col * this.cellSize + 3;
      var y = offsetY + car.row * this.cellSize + 3;
      var w = car.horizontal
        ? car.length * this.cellSize - 6
        : this.cellSize - 6;
      var h = car.horizontal
        ? this.cellSize - 6
        : car.length * this.cellSize - 6;

      // Car body
      ctx.fillStyle = car.color;
      ctx.fillRect(x, y, w, h);

      // Selection highlight
      if (i === this.selectedCar) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);

        // Direction arrows
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        if (car.horizontal) {
          ctx.fillText("◄ ►", x + w / 2, y + h / 2 + 6);
        } else {
          ctx.fillText("▲", x + w / 2, y + h / 2 - 5);
          ctx.fillText("▼", x + w / 2, y + h / 2 + 15);
        }
      }

      // Target car indicator
      if (car.isTarget) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("CAR", x + w / 2, y + h / 2 + 5);
      }
    }

    // UI
    ctx.fillStyle = "#f4f4f5";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Level: " + this.level, 10, 30);
    ctx.fillText("Moves: " + this.moves, 10, 55);

    ctx.textAlign = "right";
    ctx.fillText("Score: " + this.score, canvas.width - 10, 30);

    // Instructions
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "Move the RED car to the exit! ENTER to switch cars",
      canvas.width / 2,
      canvas.height - 10
    );

    // Game over overlay (all levels complete)
    if (this.isGameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#22c55e";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        "ALL LEVELS COMPLETE!",
        canvas.width / 2,
        canvas.height / 2 - 20
      );

      ctx.fillStyle = "#f4f4f5";
      ctx.font = "20px sans-serif";
      ctx.fillText(
        "Final Score: " + this.score,
        canvas.width / 2,
        canvas.height / 2 + 20
      );
    }
  }
}

// Aurora: class declarations are global lexical bindings, not window
// properties - expose an explicit registry for the module-based UI.
window.AuroraGameClasses = {
  snake: SnakeGame, pong: PongGame, breakout: BreakoutGame,
  spaceinvaders: SpaceInvadersGame, pacman: PacmanGame, tetris: TetrisGame,
  flappy: FlappyGame, crossy: CrossyGame, doodlejump: DoodleJumpGame,
  asteroids: AsteroidsGame, galaga: GalagaGame, game2048: Game2048,
  simon: SimonGame, trivia: TriviaGame, wordle: WordleGame,
  hangman: HangmanGame, tower: TowerBuilderGame, runner: EndlessRunnerGame,
  scramble: WordScrambleGame, jetfighter: JetFighterGame, gridlock: GridLockGame,
};
