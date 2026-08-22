// ===== ARCADE ENHANCEMENTS =====
// Sound System, Particle Effects, Screen Shake, Player Stats, Tournament Mode

// ===== 8-BIT SOUND SYSTEM =====
var SoundSystem = {
  audioContext: null,
  muted: false,
  initialized: false,
  
  init: function() {
    if (this.initialized) return;
    
    try {
      // Try different AudioContext for browser compatibility
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioContext = new AudioContext();
        this.initialized = true;
      }
    } catch(e) {
      console.log('Web Audio API not supported');
    }
    
    // Load mute preference
    try {
      this.muted = localStorage.getItem('sound_muted') === 'true';
      this.updateMuteButton();
    } catch(e) {}
  },
  
  // Generate a simple oscillator beep
  beep: function(frequency, duration, type, volume) {
    if (this.muted || !this.audioContext) return;
    
    try {
      var oscillator = this.audioContext.createOscillator();
      var gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      
      oscillator.type = type || 'square';
      oscillator.frequency.value = frequency || 440;
      
      gainNode.gain.value = volume || 0.1;
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + (duration || 0.1));
      
      oscillator.start(this.audioContext.currentTime);
      oscillator.stop(this.audioContext.currentTime + (duration || 0.1));
    } catch(e) {}
  },
  
  // Pre-defined sound effects
  playMove: function() {
    this.beep(200, 0.05, 'square', 0.05);
  },
  
  playScore: function() {
    this.beep(523, 0.1, 'square', 0.1);
    var self = this;
    setTimeout(function() { self.beep(659, 0.1, 'square', 0.1); }, 100);
  },
  
  playHit: function() {
    this.beep(100, 0.15, 'sawtooth', 0.15);
  },
  
  playGameOver: function() {
    var self = this;
    this.beep(392, 0.2, 'square', 0.15);
    setTimeout(function() { self.beep(330, 0.2, 'square', 0.15); }, 200);
    setTimeout(function() { self.beep(262, 0.4, 'square', 0.15); }, 400);
  },
  
  playPowerUp: function() {
    var self = this;
    var notes = [523, 659, 784, 1047];
    for (var i = 0; i < notes.length; i++) {
      (function(note, delay) {
        setTimeout(function() { self.beep(note, 0.1, 'square', 0.1); }, delay);
      })(notes[i], i * 80);
    }
  },
  
  playLevelUp: function() {
    var self = this;
    var notes = [262, 330, 392, 523, 659, 784];
    for (var i = 0; i < notes.length; i++) {
      (function(note, delay) {
        setTimeout(function() { self.beep(note, 0.15, 'triangle', 0.12); }, delay);
      })(notes[i], i * 100);
    }
  },
  
  playShoot: function() {
    this.beep(880, 0.05, 'sawtooth', 0.08);
    var self = this;
    setTimeout(function() { self.beep(440, 0.05, 'sawtooth', 0.06); }, 50);
  },
  
  playExplosion: function() {
    var self = this;
    // White noise-like explosion using multiple frequencies
    for (var i = 0; i < 5; i++) {
      (function(delay) {
        setTimeout(function() {
          self.beep(50 + Math.random() * 100, 0.1, 'sawtooth', 0.1);
        }, delay);
      })(i * 30);
    }
  },
  
  playJump: function() {
    var self = this;
    var freq = 150;
    for (var i = 0; i < 5; i++) {
      (function(f, delay) {
        setTimeout(function() { self.beep(f, 0.03, 'square', 0.08); }, delay);
      })(freq + i * 80, i * 20);
    }
  },
  
  playEat: function() {
    this.beep(400, 0.05, 'sine', 0.08);
  },
  
  toggleMute: function() {
    this.muted = !this.muted;
    try {
      localStorage.setItem('sound_muted', this.muted ? 'true' : 'false');
    } catch(e) {}
    this.updateMuteButton();
    
    // Play a test sound when unmuting
    if (!this.muted) {
      this.beep(440, 0.1, 'square', 0.1);
    }
  },
  
  updateMuteButton: function() {
    var btn = document.getElementById('sound-toggle');
    var onIcon = document.getElementById('sound-on-icon');
    var offIcon = document.getElementById('sound-off-icon');
    
    if (btn && onIcon && offIcon) {
      if (this.muted) {
        btn.className = 'sound-toggle muted';
        onIcon.style.display = 'none';
        offIcon.style.display = 'block';
      } else {
        btn.className = 'sound-toggle';
        onIcon.style.display = 'block';
        offIcon.style.display = 'none';
      }
    }
  }
};

// Particle system disabled for TV performance
var ParticleSystem = {
  init: function() {},
  createExplosion: function() {},
  createSparkle: function() {},
  createTrail: function() {},
  createScorePopup: function() {},
  update: function() {},
  render: function() {},
  clear: function() {}
};

// Screen shake disabled for TV performance
var ScreenShake = {
  shake: function() {}
};

// ===== PLAYER STATS =====
var PlayerStats = {
  getStats: function(gameId) {
    try {
      var data = localStorage.getItem('stats_' + gameId);
      return data ? JSON.parse(data) : {
        gamesPlayed: 0,
        bestScore: 0,
        totalScore: 0,
        totalTime: 0,
        lastPlayed: null
      };
    } catch(e) {
      return {
        gamesPlayed: 0,
        bestScore: 0,
        totalScore: 0,
        totalTime: 0,
        lastPlayed: null
      };
    }
  },
  
  saveStats: function(gameId, stats) {
    try {
      localStorage.setItem('stats_' + gameId, JSON.stringify(stats));
    } catch(e) {}
  },
  
  recordGame: function(gameId, score, duration) {
    var stats = this.getStats(gameId);
    stats.gamesPlayed++;
    stats.totalScore += score;
    stats.totalTime += duration || 0;
    if (score > stats.bestScore) {
      stats.bestScore = score;
    }
    stats.lastPlayed = Date.now();
    this.saveStats(gameId, stats);
    return stats;
  },
  
  renderStats: function(gameId) {
    var stats = this.getStats(gameId);
    var panel = document.getElementById('player-stats');
    var gamesEl = document.getElementById('stat-games');
    var bestEl = document.getElementById('stat-best');
    var avgEl = document.getElementById('stat-avg');
    var timeEl = document.getElementById('stat-time');
    
    if (!panel) return;
    
    if (stats.gamesPlayed > 0) {
      if (gamesEl) gamesEl.textContent = stats.gamesPlayed;
      if (bestEl) bestEl.textContent = stats.bestScore;
      if (avgEl) avgEl.textContent = Math.round(stats.totalScore / stats.gamesPlayed);
      
      // Format time
      var minutes = Math.floor(stats.totalTime / 60000);
      if (timeEl) {
        if (minutes < 60) {
          timeEl.textContent = minutes + 'm';
        } else {
          timeEl.textContent = Math.floor(minutes / 60) + 'h';
        }
      }
      
      panel.style.display = 'block';
    } else {
      panel.style.display = 'none';
    }
  }
};

// ===== TOURNAMENT MODE =====
var TournamentMode = {
  active: false,
  currentPlayer: 1,
  player1Score: 0,
  player2Score: 0,
  player1Name: 'PLAYER 1',
  player2Name: 'PLAYER 2',
  currentGameId: null,
  gameStartTime: 0,
  
  start: function(gameId) {
    this.active = true;
    this.currentPlayer = 1;
    this.player1Score = 0;
    this.player2Score = 0;
    this.currentGameId = gameId;
    this.gameStartTime = Date.now();
    
    // Show tournament UI
    var banner = document.getElementById('tournament-banner');
    var players = document.getElementById('tournament-players');
    if (banner) banner.style.display = 'block';
    if (players) players.style.display = '-webkit-flex';
    if (players) players.style.display = 'flex';
    
    this.updateUI();
    
    return true;
  },
  
  end: function() {
    this.active = false;
    
    // Hide tournament UI
    var banner = document.getElementById('tournament-banner');
    var players = document.getElementById('tournament-players');
    if (banner) banner.style.display = 'none';
    if (players) players.style.display = 'none';
  },
  
  recordScore: function(score) {
    if (!this.active) return null;
    
    if (this.currentPlayer === 1) {
      this.player1Score = score;
      this.currentPlayer = 2;
      this.updateUI();
      return { nextPlayer: 2, finished: false };
    } else {
      this.player2Score = score;
      this.updateUI();
      return { 
        nextPlayer: null, 
        finished: true,
        winner: this.player1Score > this.player2Score ? 1 : 
                this.player2Score > this.player1Score ? 2 : 0
      };
    }
  },
  
  updateUI: function() {
    var p1Box = document.getElementById('player1-box');
    var p2Box = document.getElementById('player2-box');
    var p1Score = document.getElementById('player1-score');
    var p2Score = document.getElementById('player2-score');
    
    if (p1Score) p1Score.textContent = this.player1Score;
    if (p2Score) p2Score.textContent = this.player2Score;
    
    if (p1Box && p2Box) {
      if (this.currentPlayer === 1) {
        p1Box.className = 'tournament-player active';
        p2Box.className = 'tournament-player waiting';
      } else {
        p1Box.className = 'tournament-player waiting';
        p2Box.className = 'tournament-player active';
      }
    }
  },
  
  getWinnerMessage: function() {
    if (this.player1Score > this.player2Score) {
      return 'PLAYER 1 WINS!';
    } else if (this.player2Score > this.player1Score) {
      return 'PLAYER 2 WINS!';
    } else {
      return 'IT\'S A TIE!';
    }
  }
};

// CRT Effect removed for TV compatibility

// ===== INITIALIZATION =====
(function() {
  // Initialize when DOM is ready
  var initArcade = function() {
    SoundSystem.init();
    
    // Sound toggle button
    var soundBtn = document.getElementById('sound-toggle');
    if (soundBtn) {
      soundBtn.onclick = function() { 
        SoundSystem.init(); // Ensure context is created on user interaction
        SoundSystem.toggleMute(); 
      };
    }
    
    // Tournament button
    var tournamentBtn = document.getElementById('tournament-btn');
    if (tournamentBtn) {
      tournamentBtn.onclick = function() {
        if (window.startTournamentMode) {
          window.startTournamentMode();
        }
      };
    }
  };
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initArcade);
  } else {
    initArcade();
  }
})();

