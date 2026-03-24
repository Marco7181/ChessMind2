from fastapi import APIRouter

router = APIRouter()

# In memoria (puoi sostituire con DB)
PLAYERS = {}

@router.post("/join")
def join(name: str):
    if name not in PLAYERS:
        PLAYERS[name] = 0
    return {"players": PLAYERS}

@router.post("/match")
def match(name: str, win: bool):
    if name not in PLAYERS:
        return {"error": "Non iscritto"}

    if win:
        PLAYERS[name] += 3

    return {"points": PLAYERS[name]}

@router.get("/leaderboard")
def leaderboard():
    return dict(sorted(PLAYERS.items(), key=lambda x: x[1], reverse=True))
