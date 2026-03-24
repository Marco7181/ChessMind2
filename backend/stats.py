from fastapi import APIRouter

router = APIRouter()

STATS = {}

@router.post("/update")
def update(name: str, games: int, wins: int, puzzles: int):
    STATS[name] = {
        "games": games,
        "wins": wins,
        "puzzles": puzzles
    }
    return STATS[name]

@router.get("/{name}")
def get_stats(name: str):
    return STATS.get(name, {"games": 0, "wins": 0, "puzzles": 0})
