import os
import random
import string
import time
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).parent
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

PLAYER_COLORS = ["#6BA3F5", "#F5846B"]  # blue, coral
HINTS_PER_GAME = 3


def _new_room_code() -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if code not in rooms:
            return code


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get("/api/room/create")
async def create_room(difficulty: str = "medium"):
    code = _new_room_code()
    puzzle, solution = generate_puzzle(difficulty)
    rooms[code] = {
        "code": code,
        "puzzle": puzzle,
        "solution": solution,
        "difficulty": difficulty,
        "players": {},
        "started": False,
        "start_time": None,
        "finished": False,
        "created_at": time.time(),
    }
    return {"code": code}


@app.get("/api/room/check/{code}")
async def check_room(code: str):
    code = code.upper().strip()
    if code not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    room = rooms[code]
    if len(room["players"]) >= 2 and not room["finished"]:
        raise HTTPException(status_code=400, detail="Room is full")
    return {"code": code, "difficulty": room["difficulty"], "players": len(room["players"])}


# ── Page routes ───────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/game")
async def game():
    return FileResponse(STATIC_DIR / "game.html")


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/{room_code}/{player_id}")
async def ws_endpoint(ws: WebSocket, room_code: str, player_id: str):
    room_code = room_code.upper().strip()

    if room_code not in rooms:
        await ws.close(code=4004, reason="Room not found")
        return

    room = rooms[room_code]

    if len(room["players"]) >= 2 and player_id not in room["players"]:
        await ws.close(code=4003, reason="Room full")
        return

    await ws.accept()

    # Assign color
    used = {p["color"] for p in room["players"].values()}
    color = next((c for c in PLAYER_COLORS if c not in used), PLAYER_COLORS[0])

    room["players"][player_id] = {
        "ws": ws,
        "name": "Player",
        "color": color,
        "filled": {},   # (row, col) -> value
        "hints_left": HINTS_PER_GAME,
    }

    # Send this player their init state
    await ws.send_json({
        "type": "init",
        "puzzle": room["puzzle"],
        "difficulty": room["difficulty"],
        "player_id": player_id,
        "color": color,
        "room_code": room_code,
        "hints_left": HINTS_PER_GAME,
        "opponent": _opponent_snapshot(room, player_id),
    })

    # Tell the opponent someone joined (name will arrive via name_update shortly after)
    await _broadcast_except(room, player_id, {
        "type": "player_joined",
        "player_id": player_id,
        "name": room["players"][player_id]["name"],
        "color": color,
    })

    # Start game when both players are present
    if len(room["players"]) == 2 and not room["started"]:
        room["started"] = True
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
    t = data.get("type")
    player = room["players"].get(pid)
    if not player or room["finished"]:
        return

    if t == "ping":
        return  # keepalive, no response needed

    if t == "set_name":
        player["name"] = str(data.get("name", "Player"))[:24]
        await _broadcast_except(room, pid, {
            "type": "name_update", "player_id": pid,
            "name": player["name"], "color": player["color"],
        })

    elif t == "fill":
        row, col, value = int(data["row"]), int(data["col"]), int(data["value"])
        if not (0 <= row < 9 and 0 <= col < 9 and 1 <= value <= 9):
            return
        if room["puzzle"][row][col] != 0:   # can't overwrite a given
            return

        correct = is_correct(room["solution"], row, col, value)
        player["filled"][(row, col)] = value

        complete = correct and _is_board_complete(room, pid)
        if complete:
            room["finished"] = True

        # Tell the filler their result (with the actual value)
        await player["ws"].send_json({
            "type": "fill_result",
            "row": row, "col": col, "value": value,
            "correct": correct, "board_complete": complete,
        })

        # Tell opponent: cell is marked (no value revealed)
        await _broadcast_except(room, pid, {
            "type": "opponent_fill",
            "row": row, "col": col,
            "color": player["color"],
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
        await _broadcast_except(room, pid, {
            "type": "opponent_erase",
            "row": row, "col": col,
        })

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
        val = room["solution"][r][c]
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
            "type": "opponent_fill",
            "row": r, "col": c,
            "color": player["color"],
            "correct": True,
        })

        if complete:
            await _broadcast_except(room, pid, {"type": "game_over"})


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_board_complete(room: dict, pid: str) -> bool:
    player = room["players"][pid]
    sol = room["solution"]
    puz = room["puzzle"]
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
                "color": p["color"],
                "filled": {f"{k[0]},{k[1]}": v for k, v in p["filled"].items()},
            }
    return None


def _remove_player(room: dict, pid: str, room_code: str):
    room["players"].pop(pid, None)
    if not room["players"]:
        rooms.pop(room_code, None)


async def _broadcast(room: dict, msg: dict):
    for p in room["players"].values():
        try:
            await p["ws"].send_json(msg)
        except Exception:
            pass


async def _broadcast_except(room: dict, exclude: str, msg: dict):
    for pid, p in room["players"].items():
        if pid != exclude:
            try:
                await p["ws"].send_json(msg)
            except Exception:
                pass


# ── Static files (must be last) ───────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
