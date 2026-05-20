/* ── theme ── */
const THEMES = [
  { name: "Dawn",      start:  5, cls: "theme-dawn"      },
  { name: "Morning",   start:  8, cls: "theme-morning"   },
  { name: "Afternoon", start: 12, cls: "theme-afternoon" },
  { name: "Evening",   start: 17, cls: "theme-evening"   },
  { name: "Night",     start: 21, cls: "theme-night"     },
];

function applyTheme() {
  const h = new Date().getHours();
  let theme = THEMES[THEMES.length - 1];
  for (let i = THEMES.length - 1; i >= 0; i--) {
    if (h >= THEMES[i].start) { theme = THEMES[i]; break; }
  }
  document.body.className = theme.cls;
  const lbl = document.getElementById("theme-label");
  if (lbl) lbl.textContent = theme.name;
}
applyTheme();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

/* ── toast ── */
function showToast(msg, dur = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), dur);
}

/* ── screen carousel ── */
const SCREEN_ORDER = ["s-land", "s-games", "s-options"];
let currentScreen = "s-land";

function goTo(id) {
  if (id === currentScreen) return;
  const nextIdx = SCREEN_ORDER.indexOf(id);
  if (nextIdx < 0) return;
  document.getElementById("screens").style.transform =
    `translateX(-${nextIdx * (100 / 3)}%)`;
  currentScreen = id;
}

// Back buttons
document.querySelectorAll("[data-to]").forEach(btn => {
  btn.addEventListener("click", () => {
    collapseExpandables();
    goTo(btn.dataset.to);
  });
});

function collapseExpandables() {
  document.getElementById("join-section").classList.add("hidden");
  document.getElementById("room-created").classList.add("hidden");
  stopPolling();
}

/* ── difficulty ── */
document.querySelectorAll(".diff-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".diff-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    btn.querySelector("input").checked = true;
  });
  if (btn.querySelector("input").checked) btn.classList.add("active");
});

function getDifficulty() {
  return document.querySelector('input[name="diff"]:checked')?.value ?? "medium";
}
function getPlayerName() {
  return document.getElementById("player-name").value.trim() || "Bee";
}
function makePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

/* ── Screen 1: landing ── */
document.getElementById("player-name").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-enter").click();
});

document.getElementById("btn-enter").addEventListener("click", () => {
  const name = getPlayerName();
  if (!name) { showToast("Enter your name first!"); return; }
  document.getElementById("greeting").textContent = name;
  goTo("s-games");
});

/* ── Screen 2: game selection ── */
const GAMES = {
  sudoku:   { icon: "🔢", name: "Sudoku",   hasDiff: true,  available: true  },
  bingo:    { icon: "🎱", name: "Bingo",    hasDiff: false, available: false },
  chess:    { icon: "♟️", name: "Chess",    hasDiff: false, available: false },
  checkers: { icon: "🔴", name: "Checkers", hasDiff: false, available: false },
};

let selectedGame = "sudoku";

document.querySelectorAll(".game-card").forEach(card => {
  card.addEventListener("click", () => {
    const game = card.dataset.game;
    const meta = GAMES[game];
    if (!meta.available) {
      showToast(`${meta.name} is coming soon 🐝`);
      return;
    }
    selectedGame = game;
    document.getElementById("sg-icon").textContent = meta.icon;
    document.getElementById("sg-name").textContent = meta.name;
    document.getElementById("diff-section").classList.toggle("hidden", !meta.hasDiff);
    collapseExpandables();
    goTo("s-options");
  });
});

/* ── Screen 3: play options ── */

// ── Create Room ──
let pollingInterval = null;

document.getElementById("btn-create").addEventListener("click", async () => {
  const btn = document.getElementById("btn-create");
  btn.disabled = true;
  collapseExpandables();

  try {
    const res  = await fetch(`/api/room/create?game=${selectedGame}&difficulty=${getDifficulty()}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    document.getElementById("room-code-text").textContent = data.code;
    document.getElementById("room-created").classList.remove("hidden");

    startPolling(data.code, makePlayerId(), getPlayerName(), getDifficulty());
  } catch {
    showToast("Couldn't create room. Try again.");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-copy").addEventListener("click", () => {
  const code = document.getElementById("room-code-text").textContent;
  navigator.clipboard.writeText(code)
    .then(() => showToast("Code copied! 📋"))
    .catch(() => showToast(code));
});

document.getElementById("btn-cancel").addEventListener("click", collapseExpandables);

function startPolling(roomCode, playerId, name, diff) {
  stopPolling();
  pollingInterval = setInterval(async () => {
    try {
      const res  = await fetch(`/api/room/check/${roomCode}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.players >= 1) {
        stopPolling();
        navToGame(selectedGame, roomCode, playerId, name, diff);
      }
    } catch {}
  }, 2000);
}

function stopPolling() {
  clearInterval(pollingInterval);
  pollingInterval = null;
}

// ── Join Room ──
document.getElementById("btn-join-toggle").addEventListener("click", () => {
  const sec    = document.getElementById("join-section");
  const hidden = sec.classList.contains("hidden");
  document.getElementById("room-created").classList.add("hidden");
  sec.classList.toggle("hidden", !hidden);
  if (hidden) document.getElementById("join-code").focus();
});

const joinInput = document.getElementById("join-code");
joinInput.addEventListener("input", () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  document.getElementById("join-error").classList.add("hidden");
});
joinInput.addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-join").click();
});

document.getElementById("btn-join").addEventListener("click", async () => {
  const code  = joinInput.value.trim().toUpperCase();
  const errEl = document.getElementById("join-error");
  if (code.length !== 6) {
    errEl.textContent = "Code must be 6 characters.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("btn-join");
  btn.disabled = true; btn.textContent = "Joining…";

  try {
    const res  = await fetch(`/api/room/check/${code}`);
    if (res.status === 404) throw new Error("Room not found.");
    if (res.status === 400) throw new Error("Room is full.");
    if (!res.ok)            throw new Error("Server error.");
    const data = await res.json();
    navToGame(data.game || selectedGame, code, makePlayerId(), getPlayerName(), getDifficulty());
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
    btn.disabled = false; btn.textContent = "Join";
  }
});

// ── vs Bot ──
document.getElementById("btn-bot").addEventListener("click", async () => {
  const btn = document.getElementById("btn-bot");
  btn.disabled = true;

  try {
    const res  = await fetch(
      `/api/room/create?game=${selectedGame}&difficulty=${getDifficulty()}&bot=true`
    );
    if (!res.ok) throw new Error();
    const data = await res.json();
    navToGame(selectedGame, data.code, makePlayerId(), getPlayerName(), getDifficulty(), true);
  } catch {
    showToast("Couldn't start bot game. Try again.");
    btn.disabled = false;
  }
});

/* ── navigate to game ── */
function navToGame(game, roomCode, playerId, name, diff, isBot = false) {
  const routes = { sudoku: "/game", bingo: "/bingo", chess: "/chess", checkers: "/checkers" };
  const p = new URLSearchParams({ room: roomCode, pid: playerId, name, diff });
  if (isBot) p.set("bot", "true");
  window.location.href = `${routes[game] || "/game"}?${p}`;
}
