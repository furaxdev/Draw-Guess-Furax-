const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const WORDS = require("./words.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// État du jeu
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_SETTINGS = {
  rounds: 3,
  drawTime: 80,
  maxPlayers: 12,
};

const POINTS_MAX = 100;
const POINTS_MIN = 20;
const DRAWER_POINTS_PER_GUESSER = 25;

function generateRoomCode() {
  let code;
  do {
    code = Array.from(
      { length: 5 },
      () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function maskWord(word, revealedIndexes) {
  return word
    .split("")
    .map((ch, i) => {
      if (ch === " ") return " ";
      if (ch === "-") return "-";
      if (revealedIndexes.has(i)) return ch;
      return "_";
    })
    .join(" ");
}

function pickWordChoices(usedWords, count = 3) {
  const available = WORDS.filter((w) => !usedWords.has(w));
  const pool = available.length >= count ? available : WORDS;
  const choices = [];
  const poolCopy = [...pool];
  while (choices.length < count && poolCopy.length > 0) {
    const idx = Math.floor(Math.random() * poolCopy.length);
    choices.push(poolCopy.splice(idx, 1)[0]);
  }
  return choices;
}

class Room {
  constructor(code, settings) {
    this.code = code;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.hostId = null;
    this.state = "lobby"; // lobby | choosing | drawing | roundEnd | gameEnd
    this.round = 0;
    this.drawerOrder = [];
    this.drawerIndex = -1;
    this.currentDrawerId = null;
    this.currentWord = null;
    this.revealedIndexes = new Set();
    this.correctGuessers = new Set();
    this.usedWords = new Set();
    this.strokes = [];
    this.timer = null;
    this.timeLeft = 0;
    this.hintTimeout = null;
    this.turnEndTimeout = null;
    this.wordChoices = [];
  }

  toPublicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      round: this.round,
      currentDrawerId: this.currentDrawerId,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        isDrawing: p.id === this.currentDrawerId,
        guessed: this.correctGuessers.has(p.id),
      })),
    };
  }

  broadcastState() {
    io.to(this.code).emit("room_update", this.toPublicState());
  }

  connectedPlayers() {
    return Array.from(this.players.values()).filter((p) => p.connected);
  }

  clearTimers() {
    if (this.timer) clearInterval(this.timer);
    if (this.hintTimeout) clearTimeout(this.hintTimeout);
    if (this.turnEndTimeout) clearTimeout(this.turnEndTimeout);
    this.timer = null;
    this.hintTimeout = null;
    this.turnEndTimeout = null;
  }

  startGame() {
    this.state = "choosing";
    this.round = 0;
    this.drawerOrder = this.connectedPlayers().map((p) => p.id);
    this.drawerIndex = -1;
    this.usedWords.clear();
    for (const p of this.players.values()) p.score = 0;
    this.nextTurn();
  }

  nextTurn() {
    this.clearTimers();
    this.strokes = [];
    this.correctGuessers.clear();

    this.drawerIndex++;
    if (this.drawerIndex >= this.drawerOrder.length) {
      this.drawerIndex = 0;
      this.round++;
    }
    if (this.round === 0) this.round = 1;

    if (this.round > this.settings.rounds) {
      this.endGame();
      return;
    }

    // Trouve le prochain joueur connecté dans l'ordre
    let attempts = 0;
    let drawer = null;
    while (attempts < this.drawerOrder.length) {
      const candidateId = this.drawerOrder[this.drawerIndex];
      const candidate = this.players.get(candidateId);
      if (candidate && candidate.connected) {
        drawer = candidate;
        break;
      }
      this.drawerIndex = (this.drawerIndex + 1) % this.drawerOrder.length;
      attempts++;
    }

    if (!drawer || this.connectedPlayers().length < 2) {
      this.endGame();
      return;
    }

    this.currentDrawerId = drawer.id;
    this.currentWord = null;
    this.revealedIndexes = new Set();
    this.state = "choosing";
    this.wordChoices = pickWordChoices(this.usedWords, 3);

    io.to(this.code).emit("chat_message", {
      system: true,
      text: `${drawer.name} choisit un mot...`,
    });

    io.to(drawer.id).emit("choose_word", {
      choices: this.wordChoices,
      round: this.round,
      totalRounds: this.settings.rounds,
    });

    this.broadcastState();

    // Choix automatique si le dessinateur ne répond pas
    this.turnEndTimeout = setTimeout(() => {
      if (this.state === "choosing") {
        this.selectWord(this.wordChoices[0]);
      }
    }, 15000);
  }

  selectWord(word) {
    if (this.state !== "choosing") return;
    if (!this.wordChoices.includes(word)) word = this.wordChoices[0];
    clearTimeout(this.turnEndTimeout);

    this.currentWord = word;
    this.usedWords.add(word);
    this.state = "drawing";
    this.timeLeft = this.settings.drawTime;

    const drawer = this.players.get(this.currentDrawerId);

    io.to(this.currentDrawerId).emit("turn_started", {
      word: this.currentWord,
      isDrawer: true,
      drawerId: this.currentDrawerId,
      drawerName: drawer.name,
      round: this.round,
      totalRounds: this.settings.rounds,
      drawTime: this.settings.drawTime,
    });

    io.to(this.code).except(this.currentDrawerId).emit("turn_started", {
      maskedWord: maskWord(this.currentWord, this.revealedIndexes),
      isDrawer: false,
      drawerId: this.currentDrawerId,
      drawerName: drawer.name,
      round: this.round,
      totalRounds: this.settings.rounds,
      drawTime: this.settings.drawTime,
    });

    this.broadcastState();
    this.startTimer();
    this.scheduleHints();
  }

  startTimer() {
    this.timer = setInterval(() => {
      this.timeLeft--;
      io.to(this.code).emit("timer", { timeLeft: this.timeLeft });
      if (this.timeLeft <= 0) {
        this.endTurn(false);
      }
    }, 1000);
  }

  scheduleHints() {
    const word = this.currentWord;
    const lettersIdx = [];
    for (let i = 0; i < word.length; i++) {
      if (word[i] !== " " && word[i] !== "-") lettersIdx.push(i);
    }
    const maxHints = Math.max(0, Math.floor(lettersIdx.length / 2) - 1);
    if (maxHints <= 0) return;

    const revealInterval = Math.floor(
      (this.settings.drawTime * 1000) / (maxHints + 1)
    );

    const scheduleNext = (count) => {
      if (count >= maxHints) return;
      this.hintTimeout = setTimeout(() => {
        if (this.state !== "drawing") return;
        const remaining = lettersIdx.filter(
          (i) => !this.revealedIndexes.has(i)
        );
        if (remaining.length > 1) {
          const idx = remaining[Math.floor(Math.random() * remaining.length)];
          this.revealedIndexes.add(idx);
          io.to(this.code).except(this.currentDrawerId).emit("word_hint", {
            maskedWord: maskWord(this.currentWord, this.revealedIndexes),
          });
        }
        scheduleNext(count + 1);
      }, revealInterval);
    };
    scheduleNext(0);
  }

  handleGuess(player, rawText) {
    if (this.state !== "drawing") return false;
    if (player.id === this.currentDrawerId) return false;
    if (this.correctGuessers.has(player.id)) return false;

    const guess = normalize(rawText);
    const answer = normalize(this.currentWord);

    if (guess === answer) {
      this.correctGuessers.add(player.id);
      const ratio = Math.max(this.timeLeft, 0) / this.settings.drawTime;
      const points = Math.round(
        POINTS_MIN + (POINTS_MAX - POINTS_MIN) * ratio
      );
      player.score += points;

      const drawer = this.players.get(this.currentDrawerId);
      if (drawer) drawer.score += DRAWER_POINTS_PER_GUESSER;

      io.to(this.code).emit("chat_message", {
        system: true,
        text: `${player.name} a trouvé le mot !`,
      });
      io.to(player.id).emit("guess_result", { correct: true, points });
      this.broadcastState();

      const activeGuessers = this.connectedPlayers().filter(
        (p) => p.id !== this.currentDrawerId
      );
      const allGuessed = activeGuessers.every((p) =>
        this.correctGuessers.has(p.id)
      );
      if (allGuessed) {
        this.endTurn(true);
      }
      return true;
    }

    if (levenshtein(guess, answer) <= 1 && answer.length > 3) {
      io.to(player.id).emit("chat_message", {
        system: true,
        text: `"${rawText}" est très proche !`,
        onlyMe: true,
      });
      return true; // Ne pas afficher aux autres pour éviter de spoiler
    }

    return false;
  }

  endTurn(allGuessed) {
    if (this.state !== "drawing") return;
    this.clearTimers();
    this.state = "roundEnd";

    io.to(this.code).emit("round_end", {
      word: this.currentWord,
      allGuessed,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        guessed: this.correctGuessers.has(p.id),
      })),
    });
    this.broadcastState();

    this.turnEndTimeout = setTimeout(() => this.nextTurn(), 5000);
  }

  endGame() {
    this.clearTimers();
    this.state = "gameEnd";
    this.currentDrawerId = null;
    const ranking = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    io.to(this.code).emit("game_end", { ranking });
    this.broadcastState();
  }

  addPlayer(player) {
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    if (this.state !== "lobby") {
      this.drawerOrder.push(player.id);
    }
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;

    if (this.state === "lobby") {
      this.players.delete(id);
      this.drawerOrder = this.drawerOrder.filter((pid) => pid !== id);
    }

    if (this.hostId === id) {
      const next = this.connectedPlayers()[0];
      this.hostId = next ? next.id : null;
    }

    if (this.state === "drawing" && this.currentDrawerId === id) {
      this.endTurn(false);
    } else if (this.connectedPlayers().length < 2 && this.state !== "lobby" && this.state !== "gameEnd") {
      this.endGame();
    }
  }
}

class Player {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.score = 0;
    this.connected = true;
  }
}

function sanitizeName(name) {
  if (typeof name !== "string") return "Joueur";
  const trimmed = name.trim().slice(0, 18);
  return trimmed.length > 0 ? trimmed : "Joueur";
}

function roomEmptyCleanupCheck(room) {
  if (room.connectedPlayers().length === 0) {
    setTimeout(() => {
      if (room.connectedPlayers().length === 0) {
        room.clearTimers();
        rooms.delete(room.code);
      }
    }, 30000);
  }
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  let currentRoomCode = null;

  socket.on("create_room", ({ name, settings } = {}) => {
    const code = generateRoomCode();
    const room = new Room(code, {
      rounds: clampInt(settings?.rounds, 1, 10, DEFAULT_SETTINGS.rounds),
      drawTime: clampInt(settings?.drawTime, 30, 240, DEFAULT_SETTINGS.drawTime),
      maxPlayers: DEFAULT_SETTINGS.maxPlayers,
    });
    rooms.set(code, room);

    const player = new Player(socket.id, sanitizeName(name));
    room.addPlayer(player);
    socket.join(code);
    currentRoomCode = code;

    socket.emit("joined_room", { code, playerId: socket.id });
    room.broadcastState();
  });

  socket.on("join_room", ({ code, name } = {}) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) {
      socket.emit("room_error", { message: "Cette partie n'existe pas." });
      return;
    }
    if (room.connectedPlayers().length >= room.settings.maxPlayers) {
      socket.emit("room_error", { message: "La partie est complète." });
      return;
    }

    const player = new Player(socket.id, sanitizeName(name));
    room.addPlayer(player);
    socket.join(room.code);
    currentRoomCode = room.code;

    socket.emit("joined_room", { code: room.code, playerId: socket.id });
    socket.emit("chat_history", []);

    if (room.strokes.length) {
      socket.emit("canvas_history", room.strokes);
    }
    if (room.state === "drawing" || room.state === "roundEnd") {
      socket.emit("turn_started", {
        maskedWord: maskWord(room.currentWord, room.revealedIndexes),
        isDrawer: false,
        drawerId: room.currentDrawerId,
        drawerName: room.players.get(room.currentDrawerId)?.name,
        round: room.round,
        totalRounds: room.settings.rounds,
        drawTime: room.settings.drawTime,
      });
      socket.emit("timer", { timeLeft: room.timeLeft });
    }

    io.to(room.code).emit("chat_message", {
      system: true,
      text: `${player.name} a rejoint la partie.`,
    });
    room.broadcastState();
  });

  socket.on("start_game", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.connectedPlayers().length < 2) {
      socket.emit("room_error", {
        message: "Il faut au moins 2 joueurs pour commencer.",
      });
      return;
    }
    room.startGame();
  });

  socket.on("choose_word", ({ word } = {}) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (room.currentDrawerId !== socket.id) return;
    room.selectWord(word);
  });

  socket.on("draw", (payload) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (room.currentDrawerId !== socket.id) return;

    if (payload?.type === "clear") {
      room.strokes = [];
    } else {
      room.strokes.push(payload);
      if (room.strokes.length > 5000) room.strokes.shift();
    }
    socket.to(room.code).emit("draw", payload);
  });

  socket.on("chat_message", ({ text } = {}) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || typeof text !== "string") return;
    const clean = text.trim().slice(0, 200);
    if (!clean) return;

    const isGuessing =
      room.state === "drawing" &&
      socket.id !== room.currentDrawerId &&
      !room.correctGuessers.has(socket.id);

    if (isGuessing) {
      const handled = room.handleGuess(player, clean);
      if (handled) return;
    }

    io.to(room.code).emit("chat_message", {
      playerId: player.id,
      name: player.name,
      text: clean,
    });
  });

  socket.on("leave_room", () => {
    handleDisconnect();
  });

  socket.on("disconnect", () => {
    handleDisconnect();
  });

  function handleDisconnect() {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    room.removePlayer(socket.id);
    socket.leave(room.code);
    if (player) {
      io.to(room.code).emit("chat_message", {
        system: true,
        text: `${player.name} a quitté la partie.`,
      });
    }
    room.broadcastState();
    roomEmptyCleanupCheck(room);
    currentRoomCode = null;
  }
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

server.listen(PORT, () => {
  console.log(`Serveur Draw & Guess lancé sur le port ${PORT}`);
});
