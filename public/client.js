(() => {
  const socket = io();

  // ------------------------------------------------------------------
  // Session persistante (survit aux reconnexions et aux F5)
  // ------------------------------------------------------------------
  function getSessionId() {
    var id = null;
    try { id = window.localStorage.getItem("dg-session"); } catch (e) { /* ignore */ }
    if (!id) {
      id = "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      try { window.localStorage.setItem("dg-session", id); } catch (e) { /* ignore */ }
    }
    return id;
  }
  const mySessionId = getSessionId();

  function saveActiveRoom(code, name) {
    try {
      window.localStorage.setItem("dg-room", JSON.stringify({ code: code, name: name }));
    } catch (e) { /* stockage indisponible, tant pis */ }
  }
  function loadActiveRoom() {
    try {
      const raw = window.localStorage.getItem("dg-room");
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearActiveRoom() {
    try { window.localStorage.removeItem("dg-room"); } catch (e) { /* ignore */ }
  }

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
  const inputDifficulty = document.getElementById("input-difficulty");
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

  const connectionBanner = document.getElementById("connection-banner");
  const pauseBanner = document.getElementById("pause-banner");
  const pauseMessage = document.getElementById("pause-message");
  const updateToast = document.getElementById("update-toast");
  const btnRefreshUpdate = document.getElementById("btn-refresh-update");

  // ------------------------------------------------------------------
  // Icônes SVG inline (aucune dépendance réseau, pas d'emoji)
  // ------------------------------------------------------------------
  const ICONS = {
    volumeOn: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a9 9 0 0 1 0 12"/></svg>',
    volumeOff: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4L8 9H4Z"/><line x1="16" y1="9" x2="22" y2="15"/><line x1="22" y1="9" x2="16" y2="15"/></svg>',
    crown: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M3 8l4 3 5-6 5 6 4-3-2 10H5L3 8Z"/></svg>',
    pencil: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    checkCircle: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
    medal: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="15" r="6"/><path d="M9 10 6 3h3l3 5 3-5h3l-3 7"/></svg>',
    gamepad: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="5"/><line x1="7" y1="10" x2="7" y2="14"/><line x1="5" y1="12" x2="9" y2="12"/><circle cx="16" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="18.5" cy="13" r="1" fill="currentColor" stroke="none"/></svg>',
    flame: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1-.5-1.8-1-2.5.8.3 3 1.8 3 5.5a5 5 0 0 1-10 0c0-5 3-7 5-11Z"/></svg>',
  };

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
    btnMute.innerHTML = SFX.isMuted() ? ICONS.volumeOff : ICONS.volumeOn;
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
  let myId = mySessionId;
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
      sessionId: mySessionId,
      settings: {
        rounds: parseInt(inputRounds.value, 10) || 3,
        drawTime: parseInt(inputDrawtime.value, 10) || 80,
        difficulty: inputDifficulty.value,
      },
    });
  });

  btnJoin.addEventListener("click", () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim().toUpperCase();
    if (!name) return showHomeError("Entre un pseudo pour continuer.");
    if (!code) return showHomeError("Entre un code de partie.");
    socket.emit("join_room", { name, code, sessionId: mySessionId });
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

  socket.on("room_error", ({ message, fatal }) => {
    homeError.textContent = message;
    lobbyError.textContent = message;
    if (fatal) {
      clearActiveRoom();
      showScreen("home");
    }
  });

  socket.on("joined_room", ({ code, playerId }) => {
    myId = playerId;
    lobbyCode.textContent = code;
    saveActiveRoom(code, inputName.value.trim() || (loadActiveRoom() || {}).name || "Joueur");
    connectionBanner.classList.add("hidden");
    if (!screens.game.classList.contains("active")) {
      showScreen("lobby");
    }
  });

  // Reconnexion automatique : au premier chargement ET après toute
  // coupure réseau, on retente de rejoindre la partie sauvegardée.
  socket.on("connect", () => {
    connectionBanner.classList.add("hidden");
    const saved = loadActiveRoom();
    if (saved && saved.code) {
      socket.emit("rejoin_room", {
        code: saved.code,
        sessionId: mySessionId,
        name: saved.name,
      });
    }
    measureLatency();
  });

  socket.on("disconnect", () => {
    connectionBanner.classList.remove("hidden");
  });

  // Toast "mise à jour disponible" : le serveur annonce sa version à
  // chaque connexion. Si elle change en cours de session, c'est qu'un
  // déploiement a eu lieu entre-temps.
  let knownServerVersion = null;
  socket.on("server_info", ({ version }) => {
    if (knownServerVersion === null) {
      knownServerVersion = version;
      return;
    }
    if (version !== knownServerVersion) {
      updateToast.classList.remove("hidden");
    }
  });

  btnRefreshUpdate.addEventListener("click", () => {
    window.location.reload();
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
    clearActiveRoom();
    socket.emit("leave_room");
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

    if (state.state !== "lobby" && !screens.game.classList.contains("active")) {
      showScreen("game");
      resizeCanvas();
    }

    if (!state.paused) {
      pauseBanner.classList.add("hidden");
    }
  });

  function pingBadge(latency) {
    if (latency === null || latency === undefined) return "";
    let cls = "ping-good";
    if (latency > 300) cls = "ping-bad";
    else if (latency > 120) cls = "ping-mid";
    return `<span class="ping ${cls}">${latency}ms</span>`;
  }

  function renderLobbyPlayers(state) {
    lobbyPlayers.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="player-name">${p.id === state.hostId ? ICONS.crown : ""}${escapeHtml(p.name)}</span>
        ${pingBadge(p.latency)}
      `;
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
        <span class="player-name">${p.id === state.hostId ? ICONS.crown : ""}${p.isDrawing ? ICONS.pencil : ""}${escapeHtml(p.name)}${p.guessed ? ICONS.checkCircle : ""}</span>
        <span class="player-meta">${pingBadge(p.latency)}<span class="score">${p.score}</span></span>
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
  // Pause automatique (connexion perdue d'un joueur)
  // ------------------------------------------------------------------
  socket.on("game_paused", ({ message }) => {
    pauseMessage.textContent = message;
    pauseBanner.classList.remove("hidden");
  });

  socket.on("game_resumed", () => {
    pauseBanner.classList.add("hidden");
  });

  // ------------------------------------------------------------------
  // Ping
  // ------------------------------------------------------------------
  function measureLatency() {
    if (!socket.connected) return;
    const sentAt = Date.now();
    socket.emit("ping_check", null, () => {
      socket.emit("report_latency", Date.now() - sentAt);
    });
  }
  setInterval(measureLatency, 1000);

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
    pauseBanner.classList.add("hidden");
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
      const medalClass = ["medal-gold", "medal-silver", "medal-bronze"][i];
      const medal = medalClass ? `<span class="${medalClass}">${ICONS.medal}</span>` : "";
      li.innerHTML = `${medal} ${escapeHtml(p.name)} — ${p.score} points`;
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

    if (text.toLowerCase() === "/clear") {
      chatMessages.innerHTML = "";
      chatInput.value = "";
      return;
    }

    triggerEasterEggsFromText(text);

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
      if (msg.playerId !== myId) {
        SFX.message();
        triggerEasterEggsFromText(msg.text);
      }
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  function addSystemMessage(text, correct = false, iconHtml = "") {
    const div = document.createElement("div");
    div.className = "msg system" + (correct ? " correct" : "");
    div.innerHTML = iconHtml + escapeHtml(text);
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

  // ------------------------------------------------------------------
  // Easter eggs
  // ------------------------------------------------------------------
  function spawnConfetti() {
    const colors = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899"];
    for (let i = 0; i < 60; i++) {
      const el = document.createElement("div");
      el.className = "confetti-piece";
      el.style.left = Math.random() * 100 + "vw";
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.animationDuration = (2 + Math.random() * 2) + "s";
      el.style.animationDelay = (Math.random() * 0.4) + "s";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 5000);
    }
  }

  function triggerPartyMode() {
    document.body.classList.add("party-mode");
    SFX.gameEnd();
    spawnConfetti();
    addSystemMessage("Konami code activé ! Mode fête pendant 8 secondes !", false, ICONS.gamepad);
    setTimeout(() => document.body.classList.remove("party-mode"), 8000);
  }

  const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let konamiProgress = 0;
  window.addEventListener("keydown", (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === KONAMI[konamiProgress]) {
      konamiProgress++;
      if (konamiProgress === KONAMI.length) {
        konamiProgress = 0;
        triggerPartyMode();
      }
    } else {
      konamiProgress = key === KONAMI[0] ? 1 : 0;
    }
  });

  let lastFuraxEgg = 0;
  function triggerEasterEggsFromText(text) {
    if (/furax/i.test(text)) {
      const now = Date.now();
      if (now - lastFuraxEgg > 3000) {
        lastFuraxEgg = now;
        spawnConfetti();
        addSystemMessage("FURAX EST DANS LA PLACE !", false, ICONS.flame);
      }
    }
  }
})();
