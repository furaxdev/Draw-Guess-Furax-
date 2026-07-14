const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const WORD_BANK = require("./words.js");

const DIFFICULTIES = ["facile", "moyen", "difficile", "mixte"];

function getWordPool(difficulty) {
  switch (difficulty) {
    case "facile":
      return WORD_BANK.facile;
    case "moyen":
      return WORD_BANK.moyen;
    case "difficile":
      return WORD_BANK.difficile;
    default:
      return WORD_BANK.all;
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Tolérance élevée aux connexions instables (Wi-Fi capricieux, DNS
  // tunneling type BrowseDNS, etc.) : évite de considérer un joueur
  // déconnecté pour un simple pic de latence passager.
  pingInterval: 20000,
  pingTimeout: 45000,
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

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
  difficulty: "mixte",
};

const POINTS_MAX = 100;
const POINTS_MIN = 20;
const DRAWER_POINTS_PER_GUESSER = 25;
const PAUSE_GRACE_MS = 90000;
const PAUSE_DEBOUNCE_MS = 5000;
const DISCONNECT_FORGET_MS = 10 * 60 * 1000;

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

function pickWordChoices(usedWords, difficulty, count = 3) {
  const fullPool = getWordPool(difficulty);
  const available = fullPool.filter((w) => !usedWords.has(w));
  const pool = available.length >= count ? available : fullPool;
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
    /** @type {Map<string, Player>} clé = sessionId, stable même après reconnexion */
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

    // Pause pour connexion perdue en cours de dessin
    this.paused = false;
    this.pauseGraceTimeout = null;
    this.pendingPauseTimeout = null;
  }

  toPublicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      round: this.round,
      currentDrawerId: this.currentDrawerId,
      paused: this.paused,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        isDrawing: p.id === this.currentDrawerId,
        guessed: this.correctGuessers.has(p.id),
        latency: p.latency,
      })),
    };
  }

  broadcastState() {
    io.to(this.code).emit("room_update", this.toPublicState());
  }

  emitToPlayer(playerId, event, payload) {
    const player = this.players.get(playerId);
    if (player && player.socketId) {
      io.to(player.socketId).emit(event, payload);
    }
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
    this.clearPause();
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
    this.wordChoices = pickWordChoices(this.usedWords, this.settings.difficulty, 3);

    io.to(this.code).emit("chat_message", {
      system: true,
      text: `${drawer.name} choisit un mot...`,
    });

    this.emitToPlayer(drawer.id, "choose_word", {
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

    this.emitToPlayer(this.currentDrawerId, "turn_started", {
      word: this.currentWord,
      isDrawer: true,
      drawerId: this.currentDrawerId,
      drawerName: drawer.name,
      round: this.round,
      totalRounds: this.settings.rounds,
      drawTime: this.settings.drawTime,
    });

    io.to(this.code).except(drawer.socketId || "").emit("turn_started", {
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
    this.checkConnectivity();
  }

  startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.paused) return;
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
          const drawer = this.players.get(this.currentDrawerId);
          io.to(this.code).except(drawer ? drawer.socketId || "" : "").emit("word_hint", {
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
      this.emitToPlayer(player.id, "guess_result", { correct: true, points });
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
      this.emitToPlayer(player.id, "chat_message", {
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
    this.clearPause();
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
    this.clearPause();
    this.state = "gameEnd";
    this.currentDrawerId = null;
    const ranking = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    io.to(this.code).emit("game_end", { ranking });
    this.broadcastState();
  }

  // -------------------------------------------------------------------
  // Pause automatique quand la partie ne peut pas continuer (déco réseau)
  // -------------------------------------------------------------------
  connectivitySnapshot() {
    const drawer = this.players.get(this.currentDrawerId);
    const drawerConnected = !!(drawer && drawer.connected);
    const guessersConnected = this.connectedPlayers().filter(
      (p) => p.id !== this.currentDrawerId
    ).length;
    return { drawerConnected, shouldPause: !drawerConnected || guessersConnected === 0 };
  }

  checkConnectivity() {
    if (this.state !== "drawing") return;
    const { drawerConnected, shouldPause } = this.connectivitySnapshot();

    if (shouldPause) {
      if (this.paused || this.pendingPauseTimeout) return;
      // On attend quelques secondes avant de vraiment mettre en pause :
      // une micro-coupure réseau qui se résout toute seule ne doit pas
      // interrompre la partie ni afficher de bannière inutilement.
      this.pendingPauseTimeout = setTimeout(() => {
        this.pendingPauseTimeout = null;
        if (this.state !== "drawing") return;
        const check = this.connectivitySnapshot();
        if (check.shouldPause) this.pause(check.drawerConnected);
      }, PAUSE_DEBOUNCE_MS);
    } else {
      if (this.pendingPauseTimeout) {
        clearTimeout(this.pendingPauseTimeout);
        this.pendingPauseTimeout = null;
      }
      if (this.paused) this.resume();
    }
  }

  pause(drawerConnected) {
    this.paused = true;
    const message = drawerConnected
      ? "Désolé, la connexion de votre adversaire semble buguée. Veuillez patienter le temps qu'elle revienne..."
      : "Le dessinateur a été déconnecté. La partie reprendra dès son retour...";

    io.to(this.code).emit("game_paused", { message });
    this.broadcastState();

    if (this.pauseGraceTimeout) clearTimeout(this.pauseGraceTimeout);
    this.pauseGraceTimeout = setTimeout(() => {
      if (!this.paused) return;
      const drawer = this.players.get(this.currentDrawerId);
      if (!drawer || !drawer.connected) {
        // Le dessinateur n'est jamais revenu : on passe au suivant
        this.clearPause();
        this.endTurn(false);
      } else {
        // Le dessinateur est là mais plus personne pour deviner : on relance le chrono
        this.resume();
      }
    }, PAUSE_GRACE_MS);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.pauseGraceTimeout) clearTimeout(this.pauseGraceTimeout);
    this.pauseGraceTimeout = null;
    io.to(this.code).emit("game_resumed", {});
    this.broadcastState();
  }

  clearPause() {
    this.paused = false;
    if (this.pauseGraceTimeout) clearTimeout(this.pauseGraceTimeout);
    this.pauseGraceTimeout = null;
    if (this.pendingPauseTimeout) clearTimeout(this.pendingPauseTimeout);
    this.pendingPauseTimeout = null;
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
    player.socketId = null;
    player.disconnectedAt = Date.now();

    if (this.state === "lobby") {
      this.players.delete(id);
      this.drawerOrder = this.drawerOrder.filter((pid) => pid !== id);
    }

    if (this.hostId === id) {
      const next = this.connectedPlayers()[0];
      this.hostId = next ? next.id : null;
    }

    if (this.state === "drawing") {
      this.checkConnectivity();
    } else if (
      this.connectedPlayers().length < 1 &&
      this.state !== "lobby" &&
      this.state !== "gameEnd"
    ) {
      this.endGame();
    }
  }

  reconnectPlayer(id, socketId) {
    const player = this.players.get(id);
    if (!player) return null;
    player.connected = true;
    player.socketId = socketId;
    player.disconnectedAt = null;
    if (!this.hostId) this.hostId = player.id;
    if (this.state === "drawing") {
      this.checkConnectivity();
    }
    return player;
  }
}

class Player {
  constructor(id, name) {
    this.id = id; // sessionId, stable
    this.socketId = null; // socket.id courant, change à chaque (re)connexion
    this.name = name;
    this.score = 0;
    this.connected = true;
    this.latency = null;
    this.disconnectedAt = null;
  }
}

function sanitizeName(name) {
  if (typeof name !== "string") return "Joueur";
  const trimmed = name.trim().slice(0, 18);
  return trimmed.length > 0 ? trimmed : "Joueur";
}

function sanitizeSessionId(id) {
  if (typeof id !== "string") return null;
  const trimmed = id.trim().slice(0, 64);
  return /^[a-zA-Z0-9_-]{6,64}$/.test(trimmed) ? trimmed : null;
}

function roomEmptyCleanupCheck(room) {
  if (room.connectedPlayers().length === 0) {
    setTimeout(() => {
      if (room.connectedPlayers().length === 0) {
        room.clearTimers();
        room.clearPause();
        rooms.delete(room.code);
      }
    }, DISCONNECT_FORGET_MS);
  }
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  let currentRoomCode = null;
  let mySessionId = null;

  function sendJoinSnapshot(room, player) {
    if (room.strokes.length) {
      socket.emit("canvas_history", room.strokes);
    }
    if (room.state === "drawing" || room.state === "roundEnd") {
      const drawer = room.players.get(room.currentDrawerId);
      const isDrawer = room.currentDrawerId === player.id;
      socket.emit("turn_started", {
        word: isDrawer ? room.currentWord : undefined,
        maskedWord: isDrawer
          ? undefined
          : maskWord(room.currentWord, room.revealedIndexes),
        isDrawer,
        drawerId: room.currentDrawerId,
        drawerName: drawer ? drawer.name : "",
        round: room.round,
        totalRounds: room.settings.rounds,
        drawTime: room.settings.drawTime,
      });
      socket.emit("timer", { timeLeft: room.timeLeft });
      if (room.paused) {
        socket.emit("game_paused", {
          message: "En attente de la reconnexion d'un joueur...",
        });
      }
    } else if (room.state === "choosing" && room.currentDrawerId === player.id) {
      socket.emit("choose_word", {
        choices: room.wordChoices,
        round: room.round,
        totalRounds: room.settings.rounds,
      });
    }
  }

  socket.on("create_room", ({ name, settings, sessionId } = {}) => {
    const code = generateRoomCode();
    const room = new Room(code, {
      rounds: clampInt(settings?.rounds, 1, 10, DEFAULT_SETTINGS.rounds),
      drawTime: clampInt(settings?.drawTime, 30, 240, DEFAULT_SETTINGS.drawTime),
      maxPlayers: DEFAULT_SETTINGS.maxPlayers,
      difficulty: DIFFICULTIES.includes(settings?.difficulty)
        ? settings.difficulty
        : DEFAULT_SETTINGS.difficulty,
    });
    rooms.set(code, room);

    const id = sanitizeSessionId(sessionId) || `s-${socket.id}`;
    const player = new Player(id, sanitizeName(name));
    player.socketId = socket.id;
    room.addPlayer(player);
    socket.join(code);
    currentRoomCode = code;
    mySessionId = id;

    socket.emit("joined_room", { code, playerId: id, sessionId: id });
    room.broadcastState();
  });

  socket.on("join_room", ({ code, name, sessionId } = {}) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) {
      socket.emit("room_error", { message: "Cette partie n'existe pas." });
      return;
    }
    if (room.connectedPlayers().length >= room.settings.maxPlayers) {
      socket.emit("room_error", { message: "La partie est complète." });
      return;
    }

    const id = sanitizeSessionId(sessionId) || `s-${socket.id}`;
    const player = new Player(id, sanitizeName(name));
    player.socketId = socket.id;
    room.addPlayer(player);
    socket.join(room.code);
    currentRoomCode = room.code;
    mySessionId = id;

    socket.emit("joined_room", { code: room.code, playerId: id, sessionId: id });

    sendJoinSnapshot(room, player);

    io.to(room.code).emit("chat_message", {
      system: true,
      text: `${player.name} a rejoint la partie.`,
    });
    room.broadcastState();
  });

  socket.on("rejoin_room", ({ code, sessionId, name } = {}) => {
    const room = rooms.get((code || "").toUpperCase());
    const id = sanitizeSessionId(sessionId);
    if (!room || !id || !room.players.has(id)) {
      socket.emit("room_error", {
        message: "Impossible de reprendre cette partie (elle n'existe plus).",
        fatal: true,
      });
      return;
    }

    const player = room.reconnectPlayer(id, socket.id);
    if (!player) {
      socket.emit("room_error", {
        message: "Impossible de reprendre cette partie.",
        fatal: true,
      });
      return;
    }
    if (typeof name === "string" && name.trim()) {
      player.name = sanitizeName(name);
    }

    socket.join(room.code);
    currentRoomCode = room.code;
    mySessionId = id;

    socket.emit("joined_room", { code: room.code, playerId: id, sessionId: id });
    sendJoinSnapshot(room, player);

    io.to(room.code).emit("chat_message", {
      system: true,
      text: `${player.name} est de retour !`,
    });
    room.broadcastState();
  });

  socket.on("start_game", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (room.hostId !== mySessionId) return;
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
    if (room.currentDrawerId !== mySessionId) return;
    room.selectWord(word);
  });

  socket.on("draw", (payload) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (room.currentDrawerId !== mySessionId) return;

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
    const player = room.players.get(mySessionId);
    if (!player || typeof text !== "string") return;
    const clean = text.trim().slice(0, 200);
    if (!clean) return;

    const isGuessing =
      room.state === "drawing" &&
      mySessionId !== room.currentDrawerId &&
      !room.correctGuessers.has(mySessionId);

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

  socket.on("ping_check", (_data, ack) => {
    if (typeof ack === "function") ack();
  });

  socket.on("report_latency", (ms) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(mySessionId);
    if (!player || typeof ms !== "number" || !isFinite(ms)) return;
    player.latency = Math.max(0, Math.round(ms));
    room.broadcastState();
  });

  socket.on("leave_room", () => {
    handleDisconnect(true);
  });

  socket.on("disconnect", () => {
    handleDisconnect(false);
  });

  function handleDisconnect(explicit) {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(mySessionId);
    room.removePlayer(mySessionId);
    socket.leave(room.code);
    if (player) {
      io.to(room.code).emit("chat_message", {
        system: true,
        text: explicit
          ? `${player.name} a quitté la partie.`
          : `${player.name} a perdu la connexion...`,
      });
    }
    room.broadcastState();
    roomEmptyCleanupCheck(room);
    currentRoomCode = null;
    mySessionId = null;
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
