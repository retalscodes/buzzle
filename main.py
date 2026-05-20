import asyncio
import os
import random
import string
import time
from pathlib import Path
from typing import Optional

BASE_DIR   = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from sudoku import generate_puzzle, is_correct

app = FastAPI(title="Buzzle")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory room store ──────────────────────────────────────────────────────
rooms: dict = {}

PLAYER_COLORS = ["#6BA3F5", "#F5846B"]
HINTS_PER_GAME = 3
BOT_ID = "__bot__"


def _new_room_code() -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if code not in rooms:
            return code


# ── Bot ───────────────────────────────────────────────────────────────────────

class _BotWS:
    """No-op WebSocket for the bot — silently discards all messages."""
    async def send_json(self, data): pass


async def _run_bot(room_code: str, difficulty: str):
    """Solves the puzzle cell by cell at a pace that matches the difficulty."""
    pace = {"easy": (5, 11), "medium": (3, 7), "hard": (1.5, 4), "expert": (0.8, 2.5)}
    lo, hi = pace.get(difficulty, (3, 7))

    await asyncio.sleep(2)  # brief "thinking" pause before first move

    while True:
        room = rooms.get(room_code)
        if not room or room.get("finished"):
            return

        bot = room["players"].get(BOT_ID)
        if not bot:
            return

        # Pick a random unsolved cell
        empties = [
            (r, c) for r in range(9) for c in range(9)
            if room["puzzle"][r][c] == 0 and (r, c) not in bot["filled"]
        ]
        if not empties:
            return

        r, c = random.choice(empties)
        await asyncio.sleep(random.uniform(lo, hi))

        room = rooms.get(room_code)
        if not room or room.get("finished"):
            return

        await _handle(room, BOT_ID, {
            "type": "fill", "row": r, "col": c,
            "value": room["solution"][r][c],
        })


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get("/api/room/create")
async def create_room(game: str = "sudoku", difficulty: str = "medium", bot: bool = False):
    code = _new_room_code()

    puzzle, solution = (generate_puzzle(difficulty)
                        if game == "sudoku"
                        else ([], []))

    rooms[code] = {
        "code": code,
        "game": game,
        "puzzle": puzzle,
        "solution": solution,
        "difficulty": difficulty,
        "players": {},
        "started": False,
        "start_time": None,
        "finished": False,
        "created_at": time.time(),
    }

    if bot and game == "sudoku":
        rooms[code]["players"][BOT_ID] = {
            "ws":         _BotWS(),
            "name":       "🤖 Bot",
            "color":      PLAYER_COLORS[1],
            "filled":     {},
            "hints_left": 0,
        }
        asyncio.create_task(_run_bot(code, difficulty))

    return {"code": code}


@app.get("/api/room/check/{code}")
async def check_room(code: str):
    code = code.upper().strip()
    if code not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    room = rooms[code]
    player_count = sum(1 for pid in room["players"] if pid != BOT_ID)
    if player_count >= 2 and not room["finished"]:
        raise HTTPException(status_code=400, detail="Room is full")
    return {
        "code":       code,
        "game":       room.get("game", "sudoku"),
        "difficulty": room["difficulty"],
        "players":    player_count,
    }


# ── Page routes ───────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/game")
async def game_page():
    return FileResponse(STATIC_DIR / "game.html")

@app.get("/bingo")
async def bingo_page():
    return FileResponse(STATIC_DIR / "bingo.html")

@app.get("/chess")
async def chess_page():
    return FileResponse(STATIC_DIR / "chess.html")

@app.get("/checkers")
async def checkers_page():
    return FileResponse(STATIC_DIR / "checkers.html")


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/{room_code}/{player_id}")
async def ws_endpoint(ws: WebSocket, room_code: str, player_id: str):
    room_code = room_code.upper().strip()

    if room_code not in rooms:
        await ws.close(code=4004, reason="Room not found")
        return

    room = rooms[room_code]
    human_count = sum(1 for pid in room["players"] if pid != BOT_ID)

    if human_count >= 2 and player_id not in room["players"]:
        await ws.close(code=4003, reason="Room full")
        return

    await ws.accept()

    used  = {p["color"] for p in room["players"].values()}
    color = next((c for c in PLAYER_COLORS if c not in used), PLAYER_COLORS[0])

    room["players"][player_id] = {
        "ws":         ws,
        "name":       "Player",
        "color":      color,
        "filled":     {},
        "hints_left": HINTS_PER_GAME,
    }

    await ws.send_json({
        "type":       "init",
        "puzzle":     room["puzzle"],
        "difficulty": room["difficulty"],
        "player_id":  player_id,
        "color":      color,
        "room_code":  room_code,
        "hints_left": HINTS_PER_GAME,
        "opponent":   _opponent_snapshot(room, player_id),
    })

    await _broadcast_except(room, player_id, {
        "type":      "player_joined",
        "player_id": player_id,
        "name":      room["players"][player_id]["name"],
        "color":     color,
    })

    total = len(room["players"])
    if total == 2 and not room["started"]:
        room["started"]    = True
        room["start_time"] = time.time()
        await _broadcast(room, {"type": "game_start"})

    try:
        while True:
            data = await ws.receive_json()
            await _handle(room, player_id, data)
    except WebSocketDisconnect:
        _remove_player(room, player_id, room_code)
        await _broadcast(room, {"type": "player_left", "player_id": player_id})


# ── Message handler ───────────────────────────────────────────────────────────

async def _handle(room: dict, pid: str, data: dict):
    t      = data.get("type")
    player = room["players"].get(pid)
    if not player or room["finished"]:
        return

    if t == "ping":
        return

    if t == "set_name":
        player["name"] = str(data.get("name", "Player"))[:24]
        await _broadcast_except(room, pid, {
            "type":      "name_update",
            "player_id": pid,
            "name":      player["name"],
            "color":     player["color"],
        })

    elif t == "fill":
        row, col, value = int(data["row"]), int(data["col"]), int(data["value"])
        if not (0 <= row < 9 and 0 <= col < 9 and 1 <= value <= 9):
            return
        if room["puzzle"][row][col] != 0:
            return

        correct  = is_correct(room["solution"], row, col, value)
        player["filled"][(row, col)] = value

        complete = correct and _is_board_complete(room, pid)
        if complete:
            room["finished"] = True

        await player["ws"].send_json({
            "type": "fill_result",
            "row": row, "col": col, "value": value,
            "correct": correct, "board_complete": complete,
        })
        await _broadcast_except(room, pid, {
            "type":    "opponent_fill",
            "row":     row, "col": col,
            "color":   player["color"],
            "correct": correct,
        })
        if complete:
            await _broadcast_except(room, pid, {"type": "game_over"})

    elif t == "erase":
        row, col = int(data["row"]), int(data["col"])
        if room["puzzle"][row][col] != 0:
            return
        player["filled"].pop((row, col), None)
        await player["ws"].send_json({"type": "erase_result", "row": row, "col": col})
        await _broadcast_except(room, pid, {"type": "opponent_erase", "row": row, "col": col})

    elif t == "hint":
        if player["hints_left"] <= 0:
            return
        empties = [
            (r, c) for r in range(9) for c in range(9)
            if room["puzzle"][r][c] == 0 and (r, c) not in player["filled"]
        ]
        if not empties:
            return
        r, c = random.choice(empties)
        val  = room["solution"][r][c]
        player["filled"][(r, c)] = val
        player["hints_left"] -= 1

        complete = _is_board_complete(room, pid)
        if complete:
            room["finished"] = True

        await player["ws"].send_json({
            "type": "hint_result",
            "row": r, "col": c, "value": val,
            "hints_left": player["hints_left"],
            "board_complete": complete,
        })
        await _broadcast_except(room, pid, {
            "type": "opponent_fill", "row": r, "col": c,
            "color": player["color"], "correct": True,
        })
        if complete:
            await _broadcast_except(room, pid, {"type": "game_over"})


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_board_complete(room: dict, pid: str) -> bool:
    player = room["players"][pid]
    sol, puz = room["solution"], room["puzzle"]
    for r in range(9):
        for c in range(9):
            if puz[r][c] == 0:
                if (r, c) not in player["filled"]:
                    return False
                if player["filled"][(r, c)] != sol[r][c]:
                    return False
    return True


def _opponent_snapshot(room: dict, exclude_pid: str) -> Optional[dict]:
    for pid, p in room["players"].items():
        if pid != exclude_pid:
            return {
                "player_id": pid,
                "name":      p["name"],
                "color":     p["color"],
                "filled":    {f"{k[0]},{k[1]}": v for k, v in p["filled"].items()},
            }
    return None


def _remove_player(room: dict, pid: str, room_code: str):
    room["players"].pop(pid, None)
    human_left = sum(1 for p in room["players"] if p != BOT_ID)
    if human_left == 0:
        rooms.pop(room_code, None)


async def _broadcast(room: dict, msg: dict):
    for p in room["players"].values():
        try: await p["ws"].send_json(msg)
        except Exception: pass


async def _broadcast_except(room: dict, exclude: str, msg: dict):
    for pid, p in room["players"].items():
        if pid != exclude:
            try: await p["ws"].send_json(msg)
            except Exception: pass


# ── Static files (must be last) ───────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
