/* ── theme ── */
const THEMES = [
  { name: "dawn",      start:  5, cls: "theme-dawn"      },
  { name: "morning",   start:  8, cls: "theme-morning"   },
  { name: "afternoon", start: 12, cls: "theme-afternoon" },
  { name: "evening",   start: 17, cls: "theme-evening"   },
  { name: "night",     start: 21, cls: "theme-night"     },
];

function applyTheme() {
  const h = new Date().getHours();
  let theme = THEMES[THEMES.length - 1];
  for (let i = THEMES.length - 1; i >= 0; i--) {
    if (h >= THEMES[i].start) { theme = THEMES[i]; break; }
  }
  document.body.className = theme.cls;
  const lbl = document.getElementById("theme-label");
  if (lbl) lbl.textContent = theme.name.charAt(0).toUpperCase() + theme.name.slice(1);
}
applyTheme();

/* ── service worker ── */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

/* ── toast ── */
function showToast(msg, duration = 2400) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), duration);
}

/* ── difficulty buttons ── */
document.querySelectorAll(".diff-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".diff-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    btn.querySelector("input").checked = true;
  });
  if (btn.querySelector("input").checked) btn.classList.add("active");
});

/* ── helpers ── */
function getDifficulty() {
  return document.querySelector('input[name="diff"]:checked')?.value ?? "medium";
}

function getPlayerName() {
  return document.getElementById("player-name").value.trim() || "Bee";
}

function makePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

function goToGame(roomCode, playerId, name, difficulty) {
  const params = new URLSearchParams({ room: roomCode, pid: playerId, name, diff: difficulty });
  window.location.href = `/game?${params}`;
}

/* ── create room ── */
let pollingInterval = null;
let createdRoomCode = null;
let createdPlayerId = null;

document.getElementById("btn-create").addEventListener("click", async () => {
  const name = getPlayerName();
  if (!name) { showToast("Enter your name first!"); return; }

  const diff = getDifficulty();
  const btn = document.getElementById("btn-create");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const res = await fetch(`/api/room/create?difficulty=${diff}`);
    if (!res.ok) throw new Error("Server error");
    const data = await res.json();

    createdRoomCode = data.code;
    createdPlayerId = makePlayerId();

    document.getElementById("room-code-text").textContent = data.code;
    document.getElementById("room-created").classList.remove("hidden");
    btn.classList.add("hidden");

    startPolling(data.code, createdPlayerId, name, diff);
  } catch {
    showToast("Could not create room. Try again.");
    btn.disabled = false;
    btn.textContent = "Create Room";
  }
});

document.getElementById("btn-copy").addEventListener("click", () => {
  const code = document.getElementById("room-code-text").textContent;
  navigator.clipboard.writeText(code).then(() => showToast("Code copied!")).catch(() => {
    showToast(code);
  });
});

document.getElementById("btn-cancel").addEventListener("click", () => {
  stopPolling();
  createdRoomCode = null;
  document.getElementById("room-created").classList.add("hidden");
  const btn = document.getElementById("btn-create");
  btn.classList.remove("hidden");
  btn.disabled = false;
  btn.textContent = "Create Room";
});

function startPolling(roomCode, playerId, name, diff) {
  stopPolling();
  pollingInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/room/check/${roomCode}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.players >= 1) {
        stopPolling();
        goToGame(roomCode, playerId, name, diff);
      } else {
        document.getElementById("room-status").textContent = "Waiting for your friend…";
      }
    } catch {}
  }, 2000);
}

function stopPolling() {
  clearInterval(pollingInterval);
  pollingInterval = null;
}

/* ── join room ── */
const joinCodeInput = document.getElementById("join-code");

joinCodeInput.addEventListener("input", () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  document.getElementById("join-error").classList.add("hidden");
});

joinCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join").click();
});

document.getElementById("btn-join").addEventListener("click", async () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  const name = getPlayerName();
  const errEl = document.getElementById("join-error");

  if (!name) { showToast("Enter your name first!"); return; }
  if (code.length !== 6) {
    errEl.textContent = "Code must be 6 characters.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("btn-join");
  btn.disabled = true;
  btn.textContent = "Joining…";

  try {
    const res = await fetch(`/api/room/check/${code}`);
    if (res.status === 404) throw new Error("Room not found.");
    if (res.status === 400) throw new Error("Room is already full.");
    if (!res.ok) throw new Error("Server error.");
    const data = await res.json();

    const playerId = makePlayerId();
    goToGame(code, playerId, name, data.difficulty);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Join";
  }
});
