(() => {
  const socket = io();

  // ------------------------------------------------------------------
  // Références DOM
  // ------------------------------------------------------------------
  const screens = {
    home: document.getElementById("screen-home"),
    lobby: document.getElementById("screen-lobby"),
    game: document.getElementById("screen-game"),
  };

  const inputName = document.getElementById("input-name");
  const inputCode = document.getElementById("input-code");
  const btnShowCreate = document.getElementById("btn-show-create");
  const createSettings = document.getElementById("create-settings");
  const btnCreate = document.getElementById("btn-create");
  const btnJoin = document.getElementById("btn-join");
  const inputRounds = document.getElementById("input-rounds");
  const inputDrawtime = document.getElementById("input-drawtime");
  const homeError = document.getElementById("home-error");

  const lobbyCode = document.getElementById("lobby-code");
  const lobbyPlayers = document.getElementById("lobby-players");
  const btnStartGame = document.getElementById("btn-start-game");
  const btnCopyCode = document.getElementById("btn-copy-code");
  const lobbyError = document.getElementById("lobby-error");

  const roundInfo = document.getElementById("round-info");
  const wordDisplay = document.getElementById("word-display");
  const timerDisplay = document.getElementById("timer-display");
  const gamePlayers = document.getElementById("game-players");

  const canvas = document.getElementById("draw-canvas");
  const ctx = canvas.getContext("2d");
  const toolbar = document.getElementById("toolbar");
  const colorPalette = document.getElementById("color-palette");
  const colorPicker = document.getElementById("color-picker");
  const btnEraser = document.getElementById("btn-eraser");
  const btnClear = document.getElementById("btn-clear");

  const chooseWordOverlay = document.getElementById("choose-word-overlay");
  const wordChoicesEl = document.getElementById("word-choices");
  const roundEndOverlay = document.getElementById("round-end-overlay");
  const revealedWordEl = document.getElementById("revealed-word");
  const roundEndSub = document.getElementById("round-end-sub");
  const gameEndOverlay = document.getElementById("game-end-overlay");
  const finalRanking = document.getElementById("final-ranking");
  const btnBackHome = document.getElementById("btn-back-home");

  const chatMessages = document.getElementById("chat-messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const btnMute = document.getElementById("btn-mute");

  // ------------------------------------------------------------------
  // Effets sonores (synthétisés via Web Audio, aucun fichier externe)
  // ------------------------------------------------------------------
  var SFX = (function () {
    var ctxAudio = null;
    var muted = false;
    try {
      muted = window.localStorage.getItem("dg-muted") === "1";
    } catch (e) {
      muted = false;
    }

    function ensureContext() {
      if (ctxAudio) return ctxAudio;
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      ctxAudio = new AudioCtor();
      return ctxAudio;
    }

    function unlock() {
      var c = ensureContext();
      if (c && c.state === "suspended" && c.resume) {
        c.resume();
      }
    }

    function tone(freq, duration, type, delay, volume) {
      if (muted) return;
      var c = ensureContext();
      if (!c) return;
      type = type || "sine";
      delay = delay || 0;
      volume = volume === undefined ? 0.18 : volume;
      var startAt = c.currentTime + delay;
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(volume, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    return {
      unlock: unlock,
      isMuted: function () { return muted; },
      setMuted: function (value) {
        muted = value;
        try {
          window.localStorage.setItem("dg-muted", muted ? "1" : "0");
        } catch (e) { /* stockage indisponible, tant pis */ }
      },
      click: function () { tone(520, 0.06, "square", 0, 0.08); },
      join: function () { tone(440, 0.12, "sine", 0); tone(660, 0.14, "sine", 0.08); },
      message: function () { tone(700, 0.05, "square", 0, 0.06); },
      correct: function () {
        tone(523, 0.1, "triangle", 0);
        tone(659, 0.1, "triangle", 0.09);
        tone(784, 0.18, "triangle", 0.18);
      },
      closeGuess: function () { tone(300, 0.08, "sawtooth", 0, 0.1); },
      myTurn: function () {
        tone(392, 0.12, "square", 0);
        tone(494, 0.12, "square", 0.12);
        tone(587, 0.2, "square", 0.24);
      },
      othersTurn: function () { tone(330, 0.15, "sine", 0, 0.1); },
      tick: function () { tone(880, 0.05, "square", 0, 0.07); },
      roundEnd: function () {
        tone(392, 0.12, "sine", 0);
        tone(330, 0.16, "sine", 0.12);
      },
      gameEnd: function () {
        tone(523, 0.14, "triangle", 0);
        tone(659, 0.14, "triangle", 0.14);
        tone(784, 0.14, "triangle", 0.28);
        tone(1047, 0.3, "triangle", 0.42);
      },
    };
  })();

  function updateMuteButton() {
    btnMute.textContent = SFX.isMuted() ? "🔇" : "🔊";
  }
  updateMuteButton();

  btnMute.addEventListener("click", () => {
    SFX.unlock();
    SFX.setMuted(!SFX.isMuted());
    updateMuteButton();
  });

  ["click", "touchstart", "keydown"].forEach((evt) => {
    window.addEventListener(evt, () => SFX.unlock(), { once: true, passive: true });
  });

  // ------------------------------------------------------------------
  // État local
  // ------------------------------------------------------------------
  let myId = null;
  let isDrawer = false;
  let currentColor = "#000000";
  let currentSize = 8;
  let isErasing = false;
  let drawing = false;
  let lastPoint = null;

  const PALETTE = [
    "#111318", "#ef4444", "#f97316", "#facc15",
    "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899",
    "#a05a2c", "#ffffff",
  ];

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  // ------------------------------------------------------------------
  // Accueil
  // ------------------------------------------------------------------
  btnShowCreate.addEventListener("click", () => {
    createSettings.classList.toggle("hidden");
  });

  btnCreate.addEventListener("click", () => {
    const name = inputName.value.trim();
    if (!name) return showHomeError("Entre un pseudo pour continuer.");
    socket.emit("create_room", {
      name,
      settings: {
        rounds: parseInt(inputRounds.value, 10) || 3,
        drawTime: parseInt(inputDrawtime.value, 10) || 80,
      },
    });
  });

  btnJoin.addEventListener("click", () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim().toUpperCase();
    if (!name) return showHomeError("Entre un pseudo pour continuer.");
    if (!code) return showHomeError("Entre un code de partie.");
    socket.emit("join_room", { name, code });
  });

  inputCode.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnJoin.click();
  });

  function showHomeError(msg) {
    homeError.textContent = msg;
    setTimeout(() => {
      if (homeError.textContent === msg) homeError.textContent = "";
    }, 4000);
  }

  socket.on("room_error", ({ message }) => {
    homeError.textContent = message;
    lobbyError.textContent = message;
  });

  socket.on("joined_room", ({ code, playerId }) => {
    myId = playerId;
    lobbyCode.textContent = code;
    showScreen("lobby");
  });

  btnCopyCode.addEventListener("click", () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lobbyCode.textContent).catch(() => {});
    }
  });

  btnStartGame.addEventListener("click", () => {
    socket.emit("start_game");
  });

  btnBackHome.addEventListener("click", () => {
    window.location.reload();
  });

  // ------------------------------------------------------------------
  // Mise à jour de l'état de la salle (lobby + jeu)
  // ------------------------------------------------------------------
  socket.on("room_update", (state) => {
    renderLobbyPlayers(state);
    renderGamePlayers(state);
    roundInfo.textContent = `${state.round || 1}/${state.settings.rounds}`;

    const isHost = state.hostId === myId;
    btnStartGame.classList.toggle("hidden", !isHost);

    if (state.state !== "lobby" && screens.lobby.classList.contains("active")) {
      showScreen("game");
      resizeCanvas();
    }
  });

  function renderLobbyPlayers(state) {
    lobbyPlayers.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="player-name">${p.id === state.hostId ? "👑 " : ""}${escapeHtml(p.name)}</span>`;
      if (!p.connected) li.classList.add("disconnected");
      lobbyPlayers.appendChild(li);
    });
  }

  function renderGamePlayers(state) {
    gamePlayers.innerHTML = "";
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p) => {
      const li = document.createElement("li");
      if (p.isDrawing) li.classList.add("drawing");
      if (p.guessed) li.classList.add("guessed");
      if (!p.connected) li.classList.add("disconnected");
      li.innerHTML = `
        <span class="player-name">${p.id === state.hostId ? "👑 " : ""}${p.isDrawing ? "✏️ " : ""}${escapeHtml(p.name)}</span>
        <span class="score">${p.score}</span>
      `;
      gamePlayers.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // Déroulement d'une manche
  // ------------------------------------------------------------------
  socket.on("choose_word", ({ choices, round, totalRounds }) => {
    hideOverlays();
    roundInfo.textContent = `${round}/${totalRounds}`;
    wordChoicesEl.innerHTML = "";
    choices.forEach((word) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary";
      btn.textContent = word;
      btn.addEventListener("click", () => {
        socket.emit("choose_word", { word });
        chooseWordOverlay.classList.add("hidden");
      });
      wordChoicesEl.appendChild(btn);
    });
    chooseWordOverlay.classList.remove("hidden");
    toolbar.classList.add("hidden");
    wordDisplay.textContent = "Choix du mot...";
  });

  socket.on("turn_started", (data) => {
    hideOverlays();
    clearCanvasLocal();
    isDrawer = !!data.isDrawer;
    toolbar.classList.toggle("hidden", !isDrawer);
    canvas.style.cursor = isDrawer ? "crosshair" : "default";
    roundInfo.textContent = `${data.round}/${data.totalRounds}`;

    if (isDrawer) {
      wordDisplay.textContent = data.word.toUpperCase();
      addSystemMessage(`À toi de dessiner : "${data.word}"`);
      SFX.myTurn();
    } else {
      wordDisplay.textContent = data.maskedWord;
      addSystemMessage(`${data.drawerName} dessine maintenant !`);
      SFX.othersTurn();
    }
    timerDisplay.textContent = data.drawTime;
  });

  socket.on("word_hint", ({ maskedWord }) => {
    if (!isDrawer) wordDisplay.textContent = maskedWord;
  });

  let lastTickSecond = null;
  socket.on("timer", ({ timeLeft }) => {
    const clamped = Math.max(timeLeft, 0);
    timerDisplay.textContent = clamped;
    timerDisplay.style.color = timeLeft <= 10 ? "#ff5c5c" : "";
    if (clamped <= 5 && clamped > 0 && clamped !== lastTickSecond) {
      SFX.tick();
    }
    lastTickSecond = clamped;
  });

  socket.on("guess_result", ({ correct, points }) => {
    if (correct) {
      addSystemMessage(`Bravo, tu as trouvé ! +${points} points`, true);
      SFX.correct();
    }
  });

  socket.on("round_end", ({ word, players }) => {
    toolbar.classList.add("hidden");
    revealedWordEl.textContent = word;
    const me = players.find((p) => p.id === myId);
    roundEndSub.textContent = (me && me.guessed) || isDrawer
      ? "Bien joué !"
      : "Ce sera pour la prochaine fois...";
    roundEndOverlay.classList.remove("hidden");
    SFX.roundEnd();
  });

  socket.on("game_end", ({ ranking }) => {
    hideOverlays();
    toolbar.classList.add("hidden");
    finalRanking.innerHTML = "";
    SFX.gameEnd();
    ranking.forEach((p, i) => {
      const li = document.createElement("li");
      const medal = ["🥇", "🥈", "🥉"][i] || "";
      li.textContent = `${medal} ${p.name} — ${p.score} points`;
      finalRanking.appendChild(li);
    });
    gameEndOverlay.classList.remove("hidden");
  });

  function hideOverlays() {
    chooseWordOverlay.classList.add("hidden");
    roundEndOverlay.classList.add("hidden");
    gameEndOverlay.classList.add("hidden");
  }

  // ------------------------------------------------------------------
  // Chat / devinettes
  // ------------------------------------------------------------------
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit("chat_message", { text });
    chatInput.value = "";
  });

  socket.on("chat_message", (msg) => {
    const div = document.createElement("div");
    div.className = "msg";
    if (msg.system) {
      div.classList.add("system");
      div.textContent = msg.text;
      if (msg.onlyMe) SFX.closeGuess();
    } else {
      div.innerHTML = `<span class="author">${escapeHtml(msg.name)}:</span>${escapeHtml(msg.text)}`;
      if (msg.playerId !== myId) SFX.message();
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  function addSystemMessage(text, correct = false) {
    const div = document.createElement("div");
    div.className = "msg system" + (correct ? " correct" : "");
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ------------------------------------------------------------------
  // Canvas — dessin
  // ------------------------------------------------------------------
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const displayWidth = 800;
    const displayHeight = 600;
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    redrawFromHistory();
  }

  let strokeHistory = [];

  function redrawFromHistory() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    strokeHistory.forEach((p) => applyDrawPayload(p, false));
  }

  function clearCanvasLocal() {
    strokeHistory = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function getCanvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function applyDrawPayload(payload, record = true) {
    if (payload.type === "clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (record) strokeHistory = [];
      return;
    }
    if (payload.type === "line") {
      ctx.strokeStyle = payload.erase ? "#ffffff" : payload.color;
      ctx.lineWidth = payload.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(payload.x0, payload.y0);
      ctx.lineTo(payload.x1, payload.y1);
      ctx.stroke();
      if (record) strokeHistory.push(payload);
    }
  }

  function startDraw(e) {
    if (!isDrawer) return;
    drawing = true;
    lastPoint = getCanvasPoint(e);
  }

  function moveDraw(e) {
    if (!isDrawer || !drawing) return;
    const point = getCanvasPoint(e);
    const payload = {
      type: "line",
      x0: lastPoint.x,
      y0: lastPoint.y,
      x1: point.x,
      y1: point.y,
      color: currentColor,
      size: currentSize,
      erase: isErasing,
    };
    applyDrawPayload(payload);
    socket.emit("draw", payload);
    lastPoint = point;
  }

  function endDraw() {
    drawing = false;
    lastPoint = null;
  }

  canvas.addEventListener("mousedown", startDraw);
  canvas.addEventListener("mousemove", moveDraw);
  window.addEventListener("mouseup", endDraw);
  canvas.addEventListener("touchstart", (e) => { e.preventDefault(); startDraw(e); }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); moveDraw(e); }, { passive: false });
  canvas.addEventListener("touchend", endDraw);

  socket.on("draw", (payload) => applyDrawPayload(payload));
  socket.on("canvas_history", (strokes) => {
    strokeHistory = strokes.filter((s) => s.type === "line");
    redrawFromHistory();
  });

  // ------------------------------------------------------------------
  // Barre d'outils
  // ------------------------------------------------------------------
  PALETTE.forEach((color, i) => {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";
    swatch.style.background = color;
    if (i === 0) swatch.classList.add("active");
    swatch.addEventListener("click", () => {
      currentColor = color;
      isErasing = false;
      document.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("active"));
      swatch.classList.add("active");
      btnEraser.classList.remove("active-tool");
    });
    colorPalette.appendChild(swatch);
  });

  colorPicker.addEventListener("input", (e) => {
    currentColor = e.target.value;
    isErasing = false;
    document.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("active"));
  });

  document.querySelectorAll(".size-btn").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      currentSize = parseInt(btn.dataset.size, 10);
      document.querySelectorAll(".size-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
    if (i === 1) btn.classList.add("active");
  });
  currentSize = 8;

  btnEraser.addEventListener("click", () => {
    isErasing = !isErasing;
    btnEraser.classList.toggle("active-tool", isErasing);
  });

  btnClear.addEventListener("click", () => {
    if (!isDrawer) return;
    const payload = { type: "clear" };
    applyDrawPayload(payload);
    socket.emit("draw", payload);
  });

  window.addEventListener("resize", () => {
    if (screens.game.classList.contains("active")) resizeCanvas();
  });
})();
