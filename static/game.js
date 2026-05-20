/* ── theme ── */
const THEMES = [
  { start:  5, cls: "theme-dawn"      },
  { start:  8, cls: "theme-morning"   },
  { start: 12, cls: "theme-afternoon" },
  { start: 17, cls: "theme-evening"   },
  { start: 21, cls: "theme-night"     },
];
(function applyTheme() {
  const h = new Date().getHours();
  let theme = THEMES[THEMES.length - 1];
  for (let i = THEMES.length - 1; i >= 0; i--) {
    if (h >= THEMES[i].start) { theme = THEMES[i]; break; }
  }
  document.body.className = theme.cls;
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

/* ── URL params ── */
const params      = new URLSearchParams(location.search);
const ROOM_CODE   = (params.get("room")  || "").toUpperCase();
const PLAYER_ID   = params.get("pid")   || Math.random().toString(36).slice(2, 10);
const PLAYER_NAME = params.get("name") || "Bee";
const DIFFICULTY  = params.get("diff") || "medium";

if (!ROOM_CODE) location.href = "/";

/* ── state ── */
let puzzle      = null;
let selected    = null;
let notesMode   = false;
let notes       = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => new Set()));
let myFills     = {};
let myErrors    = {};
let hintsLeft   = 3;
let errorCount  = 0;
let oppFills    = {};
let oppName     = "";
let oppColor    = "";
let gameOver    = false;
let gameStarted = false;
let timerSec    = 0;
let timerHandle = null;
let hintsUsed   = 0;

/* ── DOM refs ── */
const gridEl        = document.getElementById("sudoku-grid");
const numpadEl      = document.getElementById("numpad");
const timerEl       = document.getElementById("timer");
const hintCountEl   = document.getElementById("hints-left");
const noteStateEl   = document.getElementById("notes-state");
const oppPanel      = document.getElementById("opp-panel");
const oppNameEl     = document.getElementById("opp-name");
const oppDotEl      = document.getElementById("opp-dot");
const oppGridEl     = document.getElementById("opp-mini-grid");
const oppProgressEl = document.getElementById("opp-progress");
const overlay       = document.getElementById("overlay");
const waitingOverlay= document.getElementById("waiting-overlay");
const toastEl       = document.getElementById("toast");
const musicAudio    = document.getElementById("music-audio");
const musicBtn      = document.getElementById("btn-music");

document.getElementById("room-code-badge").textContent = ROOM_CODE;
document.getElementById("diff-badge").textContent =
  DIFFICULTY.charAt(0).toUpperCase() + DIFFICULTY.slice(1);

/* ── toast ── */
function showToast(msg, dur = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("show"), dur);
}

/* ── timer ── */
function startTimer() {
  stopTimer();
  timerHandle = setInterval(() => {
    timerSec++;
    const m = String(Math.floor(timerSec / 60)).padStart(2, "0");
    const s = String(timerSec % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() { clearInterval(timerHandle); }
function formatTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/* ── grid rendering ── */
function buildGrid() {
  gridEl.innerHTML = "";
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.setAttribute("data-row", r);
      cell.setAttribute("data-col", c);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("tabindex", "0");
      cell.addEventListener("click", () => selectCell(r, c));
      cell.addEventListener("keydown", handleCellKey);
      gridEl.appendChild(cell);
    }
  }
}

function cellEl(r, c) {
  return gridEl.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
}

function renderAll() {
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) renderCell(r, c);
}

function renderCell(r, c) {
  const el = cellEl(r, c);
  if (!el) return;
  const key = `${r},${c}`;
  const given = puzzle && puzzle[r][c] !== 0;

  el.className = "cell";
  el.setAttribute("data-row", r);
  el.setAttribute("data-col", c);
  el.textContent = "";

  if (given) {
    el.classList.add("given");
    el.textContent = puzzle[r][c];
    return;
  }

  if (myFills[key]) {
    el.classList.add("filled-ok");
    el.textContent = myFills[key];
  } else if (myErrors[key]) {
    el.classList.add("filled-err");
    el.textContent = myErrors[key];
  } else if (oppFills[key]) {
    el.classList.add("opp-fill");
  } else if (notes[r][c].size > 0) {
    renderNotes(el, r, c);
  }

  if (selected && selected.row === r && selected.col === c) {
    el.classList.add("selected");
  }
}

function renderNotes(el, r, c) {
  el.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "notes-grid";
  for (let n = 1; n <= 9; n++) {
    const span = document.createElement("span");
    span.textContent = notes[r][c].has(n) ? n : "";
    grid.appendChild(span);
  }
  el.appendChild(grid);
}

/* ── opponent mini-grid ── */
function buildMiniGrid() {
  oppGridEl.innerHTML = "";
  for (let i = 0; i < 81; i++) {
    const d = document.createElement("div");
    oppGridEl.appendChild(d);
  }
}

function updateMiniCell(r, c) {
  const el = oppGridEl.children[r * 9 + c];
  if (el) el.style.background = oppFills[`${r},${c}`] ? oppColor : "";
}

function updateOppProgress() {
  const filled  = Object.keys(oppFills).length;
  const empties = countEmpties();
  const pct = empties > 0 ? Math.min(100, Math.round((filled / empties) * 100)) : 0;
  oppProgressEl.style.width = `${pct}%`;
}

function countEmpties() {
  if (!puzzle) return 81;
  let n = 0;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (puzzle[r][c] === 0) n++;
  return n;
}

/* ── cell selection ── */
function selectCell(r, c) {
  if (gameOver || !gameStarted) return;
  const prev = selected;
  selected = { row: r, col: c };
  if (prev) renderCell(prev.row, prev.col);
  renderCell(r, c);
}

/* ── keyboard on cell ── */
function handleCellKey(e) {
  if (!selected) return;
  const { row, col } = selected;
  if (e.key >= "1" && e.key <= "9") { e.preventDefault(); inputNumber(parseInt(e.key)); }
  else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") { e.preventDefault(); inputNumber(0); }
  else if (e.key === "ArrowUp"    && row > 0) { e.preventDefault(); selectCell(row - 1, col); }
  else if (e.key === "ArrowDown"  && row < 8) { e.preventDefault(); selectCell(row + 1, col); }
  else if (e.key === "ArrowLeft"  && col > 0) { e.preventDefault(); selectCell(row, col - 1); }
  else if (e.key === "ArrowRight" && col < 8) { e.preventDefault(); selectCell(row, col + 1); }
}

/* ── number input ── */
function inputNumber(num) {
  if (!selected || !puzzle || gameOver || !gameStarted) return;
  const { row, col } = selected;
  const key = `${row},${col}`;

  if (puzzle[row][col] !== 0) return;
  if (myFills[key]) return;

  if (num === 0) {
    if (myErrors[key]) {
      delete myErrors[key];
      notes[row][col].clear();
      renderCell(row, col);
      sendWS({ type: "erase", row, col });
    } else {
      notes[row][col].clear();
      renderCell(row, col);
    }
    return;
  }

  if (notesMode) {
    if (notes[row][col].has(num)) notes[row][col].delete(num);
    else notes[row][col].add(num);
    renderCell(row, col);
    return;
  }

  sendWS({ type: "fill", row, col, value: num });
}

/* ── numpad ── */
numpadEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".num-btn");
  if (btn) inputNumber(parseInt(btn.dataset.num));
});

/* ── notes toggle ── */
document.getElementById("btn-notes").addEventListener("click", () => {
  notesMode = !notesMode;
  noteStateEl.textContent = notesMode ? "ON" : "OFF";
  document.getElementById("btn-notes").classList.toggle("active", notesMode);
});

/* ── hint (no cell selection required) ── */
document.getElementById("btn-hint").addEventListener("click", () => {
  if (gameOver || !gameStarted) return;
  if (hintsLeft <= 0) { showToast("No hints left!"); return; }
  sendWS({ type: "hint" });
});

/* ── music ── */
const STATIONS = [
  { name: "Radio Swiss Classic",  url: "https://stream.srg-ssr.ch/m/rsc_de/aacp_96" },
  { name: "France Musique",       url: "https://icecast.radiofrance.fr/francemusique-hifi.aac" },
  { name: "Classical KING FM",    url: "https://20023.live.streamtheworld.com/KING_FM_HIGH.mp3" },
  { name: "Calm Radio Classical", url: "https://streams.calmradio.com/api/37/128/stream" },
  { name: "Venice Classic Radio", url: "https://uk2.streamingpulse.com/ssl/vcr1" },
];
let stationIdx = 0;

function loadStation(idx) {
  stationIdx = ((idx % STATIONS.length) + STATIONS.length) % STATIONS.length;
  const s = STATIONS[stationIdx];
  musicAudio.src = s.url;
  musicAudio.load();
  musicAudio.play()
    .then(() => {
      musicBtn.textContent = "♫";
      musicBtn.classList.add("playing");
      showToast(`♪ ${s.name}`);
    })
    .catch(() => {
      showToast(`Couldn't load ${s.name}, trying next…`);
      setTimeout(() => loadStation(stationIdx + 1), 800);
    });
}

musicBtn.addEventListener("click", () => {
  if (musicAudio.paused || musicAudio.ended || !musicAudio.src) {
    loadStation(stationIdx);
  } else {
    musicAudio.pause();
    musicBtn.textContent = "♪";
    musicBtn.classList.remove("playing");
  }
});

// Long-press or double-click to skip station
let musicPressTimer;
musicBtn.addEventListener("mousedown",  () => { musicPressTimer = setTimeout(() => loadStation(stationIdx + 1), 600); });
musicBtn.addEventListener("touchstart", () => { musicPressTimer = setTimeout(() => loadStation(stationIdx + 1), 600); }, { passive: true });
musicBtn.addEventListener("mouseup",    () => clearTimeout(musicPressTimer));
musicBtn.addEventListener("touchend",   () => clearTimeout(musicPressTimer));

/* ── back button ── */
document.getElementById("btn-back").addEventListener("click", () => {
  if (confirm("Leave the game?")) {
    stopTimer();
    if (ws) ws.close();
    location.href = "/";
  }
});

/* ── play again / home ── */
document.getElementById("btn-play-again").addEventListener("click", () => {
  stopTimer();
  if (ws) ws.close();
  location.href = `/?name=${encodeURIComponent(PLAYER_NAME)}&diff=${DIFFICULTY}`;
});
document.getElementById("btn-home").addEventListener("click", () => {
  stopTimer();
  if (ws) ws.close();
  location.href = "/";
});

/* ── win/lose screen ── */
function showResult(win, isOpponentWin = false) {
  if (gameOver) return;
  gameOver = true;
  stopTimer();
  musicAudio.pause();

  const emoji = document.getElementById("result-emoji");
  const title = document.getElementById("result-title");
  const sub   = document.getElementById("result-sub");

  if (win) {
    emoji.textContent = "🏆";
    title.textContent = "You solved it!";
    sub.textContent   = oppName ? `You beat ${oppName}!` : "Puzzle complete!";
  } else if (isOpponentWin) {
    emoji.textContent = "🐝";
    title.textContent = `${oppName || "Opponent"} won!`;
    sub.textContent   = "Better luck next time!";
  } else {
    emoji.textContent = "✅";
    title.textContent = "Puzzle complete!";
    sub.textContent   = "Well played!";
  }

  document.getElementById("stat-time").textContent   = formatTime(timerSec);
  document.getElementById("stat-hints").textContent  = hintsUsed;
  document.getElementById("stat-errors").textContent = errorCount;

  overlay.classList.remove("hidden");
  if (win) launchConfetti();
}

/* ── confetti ── */
function launchConfetti() {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const COLORS = ["#F5BE18","#F5846B","#6BA3F5","#7FD4C8","#E8427A","#FFE566"];
  const pieces = Array.from({ length: 90 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    r: 5 + Math.random() * 7,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 4,
    spin: (Math.random() - 0.5) * 0.18,
    angle: 0,
  }));
  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((p) => {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.55);
      ctx.restore();
      p.x += p.vx; p.y += p.vy; p.angle += p.spin;
    });
    if (pieces.some((p) => p.y < canvas.height + 20)) frame = requestAnimationFrame(draw);
    else canvas.remove();
  }
  draw();
  setTimeout(() => { cancelAnimationFrame(frame); canvas.remove(); }, 5000);
}

/* ── WebSocket ── */
let ws;

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${ROOM_CODE}/${PLAYER_ID}`);

  ws.addEventListener("open", () => {
    sendWS({ type: "set_name", name: PLAYER_NAME });
    // Keepalive ping every 25s to prevent server sleep on free hosting
    ws._ping = setInterval(() => sendWS({ type: "ping" }), 25000);
  });

  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener("close", () => {
    clearInterval(ws._ping);
    if (!gameOver) showToast("Connection lost. Reconnecting…");
    setTimeout(connectWS, 2000);
  });

  ws.addEventListener("error", () => ws.close());
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/* ── message handling ── */
function handleMessage(msg) {
  switch (msg.type) {

    case "init":
      puzzle = msg.puzzle;
      buildGrid();
      buildMiniGrid();

      // Restore opponent fills that happened before we connected
      if (msg.opponent && msg.opponent.filled) {
        oppColor = msg.opponent.color || oppColor;
        for (const key of Object.keys(msg.opponent.filled)) {
          oppFills[key] = true;
        }
      }

      renderAll();

      // Update mini-grid for pre-existing opponent fills
      for (const key of Object.keys(oppFills)) {
        const [r, c] = key.split(",").map(Number);
        updateMiniCell(r, c);
      }
      updateOppProgress();

      document.getElementById("waiting-title").textContent = "Ready!";
      document.getElementById("waiting-sub").textContent   = "Waiting for your friend…";
      break;

    case "game_start":
      gameStarted = true;
      waitingOverlay.classList.add("hidden");
      startTimer();
      showToast("Game on! 🐝");
      break;

    case "player_joined":
      oppName  = msg.name || "Opponent";
      oppColor = msg.color;
      oppDotEl.style.background = oppColor;
      oppNameEl.textContent = oppName;
      oppPanel.classList.remove("hidden");
      break;

    case "name_update":
      oppName  = msg.name;
      oppColor = msg.color || oppColor;
      oppDotEl.style.background = oppColor;
      oppNameEl.textContent = oppName;
      oppPanel.classList.remove("hidden");
      break;

    case "fill_result": {
      const key = `${msg.row},${msg.col}`;
      if (msg.correct) {
        delete myErrors[key];
        myFills[key] = msg.value;
        notes[msg.row][msg.col].clear();
      } else {
        errorCount++;
        myErrors[key] = msg.value;
      }
      renderCell(msg.row, msg.col);
      if (msg.board_complete) showResult(true);
      break;
    }

    case "erase_result": {
      const key = `${msg.row},${msg.col}`;
      delete myErrors[key];
      delete myFills[key];
      notes[msg.row][msg.col].clear();
      renderCell(msg.row, msg.col);
      break;
    }

    case "hint_result": {
      const key = `${msg.row},${msg.col}`;
      hintsLeft = msg.hints_left;
      hintCountEl.textContent = hintsLeft;
      hintsUsed++;
      delete myErrors[key];
      myFills[key] = msg.value;
      notes[msg.row][msg.col].clear();
      renderCell(msg.row, msg.col);
      // Re-apply hint highlight after render
      const el = cellEl(msg.row, msg.col);
      if (el) el.classList.add("hint-cell");
      if (msg.board_complete) showResult(true);
      break;
    }

    case "opponent_fill": {
      const key = `${msg.row},${msg.col}`;
      if (msg.correct) {
        oppFills[key] = true;
        updateMiniCell(msg.row, msg.col);
        updateOppProgress();
        renderCell(msg.row, msg.col);
      } else {
        // Brief red flash on mini-grid for opponent error
        const miniEl = oppGridEl.children[msg.row * 9 + msg.col];
        if (miniEl) {
          miniEl.style.background = "#F5846B";
          setTimeout(() => { miniEl.style.background = ""; }, 700);
        }
      }
      break;
    }

    case "opponent_erase": {
      const key = `${msg.row},${msg.col}`;
      delete oppFills[key];
      updateMiniCell(msg.row, msg.col);
      updateOppProgress();
      renderCell(msg.row, msg.col);
      break;
    }

    case "game_over":
      showResult(false, true);
      break;

    case "player_left":
      showToast(`${oppName || "Opponent"} left the game.`);
      oppNameEl.textContent = "Left";
      break;

    case "error":
      showToast(msg.message || "Something went wrong.");
      break;
  }
}

/* ── kick off ── */
connectWS();
